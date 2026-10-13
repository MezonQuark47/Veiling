// Uploads files to Arweave through ArDrive Turbo, straight from the browser.
//
// Each file becomes an ANS-104 data item. Free uploads are signed by a
// throwaway key made for this page: Turbo stores small items for free, so the
// key never holds funds and the seller's wallet is never asked to sign
// anything. Paid uploads are signed by the seller's upload key, which holds
// the storage credit they bought (see storage.ts). Signing follows arbundles'
// HexSolanaSigner (signature type 4), the format Turbo's own SDK uses for
// Solana keys.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256, sha384 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import {
  ARWEAVE_GATEWAY,
  FREE_UPLOAD_ITEM_BYTES,
  FRESH_ARWEAVE_GATEWAY,
  MAX_PAID_ITEM_BYTES,
  PAID_STORAGE,
  UPLOAD_SERVICE_URL,
} from "../config";

export type Tag = { name: string; value: string };
type Bytes = Uint8Array<ArrayBuffer>;

/** Where files go and who signs them. */
export type UploadTarget = {
  /** Turbo's upload service. */
  service: string;
  /** The gateway that serves what was uploaded. */
  gateway: string;
  /** The ed25519 seed that signs each upload. */
  key: Uint8Array;
  /** Whether uploads draw on bought credit rather than the free allowance. */
  paid: boolean;
};

/** ANS-104 signature type 4: an ed25519 (Solana) key signing the hex of the message. */
const SIGNATURE_TYPE = 4;
const SIGNATURE_LENGTH = 64;
const OWNER_LENGTH = 32;
const MAX_TAGS = 128;
const MAX_TAG_NAME_BYTES = 1024;
const MAX_TAG_VALUE_BYTES = 3072;
const MAX_TAG_BYTES = 4096;

const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 60_000;

/**
 * A problem with an upload, worded for the person uploading. `reason` tells
 * the free allowance being used up, or bought credit running short, apart
 * from other failures.
 */
export class UploadError extends Error {
  readonly reason: "free-used-up" | "credit-short" | null;
  constructor(message: string, reason: "free-used-up" | "credit-short" | null = null) {
    super(message);
    this.name = "UploadError";
    this.reason = reason;
  }
}

function concat(parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** A little-endian unsigned integer of `size` bytes. */
function littleEndian(value: number, size: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid length");
  const out = new Uint8Array(size);
  let rest = value;
  for (let i = 0; i < size; i++) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  if (rest !== 0) throw new Error("Length too large");
  return out;
}

/** An Avro long: zigzag-encoded, then 7 bits per byte. Only used for small non-negative values. */
function avroLong(value: number): number[] {
  let rest = value * 2;
  const out: number[] = [];
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

/** Tags as ANS-104 stores them: an Avro array of {name: bytes, value: bytes}; nothing when there are none. */
export function serializeTags(tags: Tag[]): Bytes {
  if (tags.length === 0) return new Uint8Array(0);
  if (tags.length > MAX_TAGS) throw new Error("Too many tags");
  const parts: Uint8Array[] = [Uint8Array.from(avroLong(tags.length))];
  for (const { name, value } of tags) {
    const n = utf8ToBytes(name);
    const v = utf8ToBytes(value);
    if (n.length === 0 || n.length > MAX_TAG_NAME_BYTES) throw new Error("Invalid tag name");
    if (v.length === 0 || v.length > MAX_TAG_VALUE_BYTES) throw new Error("Invalid tag value");
    parts.push(Uint8Array.from(avroLong(n.length)), n, Uint8Array.from(avroLong(v.length)), v);
  }
  parts.push(Uint8Array.of(0));
  const out = concat(parts);
  if (out.length > MAX_TAG_BYTES) throw new Error("Tags too large");
  return out;
}

/** Arweave's deep hash of a list of byte strings (SHA-384). */
export function deepHash(chunks: Uint8Array[]): Bytes {
  let acc = sha384(concat([utf8ToBytes("list"), utf8ToBytes(String(chunks.length))]));
  for (const chunk of chunks) {
    const tagged = concat([sha384(concat([utf8ToBytes("blob"), utf8ToBytes(String(chunk.byteLength))])), sha384(chunk)]);
    acc = sha384(concat([acc, sha384(tagged)]));
  }
  return concat([acc]);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type DataItem = { id: string; bytes: Bytes };

/** The size of the signed data item that uploads `dataLength` bytes of `contentType`. */
export function dataItemSize(dataLength: number, contentType: string): number {
  const tags = serializeTags([{ name: "Content-Type", value: contentType }]);
  return 2 + SIGNATURE_LENGTH + OWNER_LENGTH + 1 + 1 + 8 + 8 + tags.length + dataLength;
}

/**
 * A signed ANS-104 data item with no target and no anchor. `secretKey` is a
 * 32-byte ed25519 seed. Its id is the base64url SHA-256 of the signature.
 */
export function createDataItem(data: Uint8Array, tags: Tag[], secretKey: Uint8Array): DataItem {
  const owner = ed25519.getPublicKey(secretKey);
  if (owner.length !== OWNER_LENGTH) throw new Error("Invalid key");
  const tagBytes = serializeTags(tags);
  const empty = new Uint8Array(0);
  const message = deepHash([
    utf8ToBytes("dataitem"),
    utf8ToBytes("1"),
    utf8ToBytes(String(SIGNATURE_TYPE)),
    owner,
    empty, // target
    empty, // anchor
    tagBytes,
    data,
  ]);
  const signature = ed25519.sign(utf8ToBytes(bytesToHex(message)), secretKey);
  if (signature.length !== SIGNATURE_LENGTH) throw new Error("Invalid signature");
  const bytes = concat([
    littleEndian(SIGNATURE_TYPE, 2),
    signature,
    owner,
    Uint8Array.of(0), // no target
    Uint8Array.of(0), // no anchor
    littleEndian(tags.length, 8),
    littleEndian(tagBytes.length, 8),
    tagBytes,
    data,
  ]);
  return { id: base64url(sha256(signature)), bytes };
}

/** The smallest signed data item: its header with no tags and no data. */
const MIN_ITEM_LENGTH = 2 + SIGNATURE_LENGTH + OWNER_LENGTH + 1 + 1 + 8 + 8;

/**
 * A signed data item read back from its bytes, with the id its signature
 * gives it. Only the layout this app signs (type 4, no target, no anchor) is
 * accepted; the storage service checks the signature itself.
 */
export function dataItemFromBytes(bytes: Uint8Array): DataItem {
  if (bytes.length < MIN_ITEM_LENGTH || bytes[0] !== SIGNATURE_TYPE || bytes[1] !== 0) {
    throw new Error("A sealed file is not a signed upload.");
  }
  const signature = bytes.subarray(2, 2 + SIGNATURE_LENGTH);
  const flags = 2 + SIGNATURE_LENGTH + OWNER_LENGTH;
  if (bytes[flags] !== 0 || bytes[flags + 1] !== 0) throw new Error("A sealed file is not a signed upload.");
  return { id: base64url(sha256(signature)), bytes: Uint8Array.from(bytes) };
}

/** Signs `data` as an upload of `contentType` without sending it; its address is fixed from now on. */
export function signFile(data: Uint8Array, contentType: string, key: Uint8Array): DataItem {
  return createDataItem(data, [{ name: "Content-Type", value: contentType }], key);
}

// A key for this page only. It signs free uploads and nothing else, and is
// gone when the page closes.
let pageKey: Uint8Array | null = null;

/** Turbo's free storage, signed by this page's own key. */
export function freeTarget(): UploadTarget {
  pageKey ??= ed25519.utils.randomSecretKey();
  return { service: UPLOAD_SERVICE_URL, gateway: ARWEAVE_GATEWAY, key: pageKey, paid: false };
}

/** Turbo's paid storage, signed by the seller's upload key, which holds their credit. */
export function paidTarget(key: Uint8Array): UploadTarget {
  return { service: PAID_STORAGE.uploadUrl, gateway: PAID_STORAGE.gateway, key, paid: true };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends a signed data item to Turbo, retrying network failures and busy responses. */
export async function sendDataItem(item: DataItem, target: UploadTarget): Promise<string> {
  if (!target.paid && item.bytes.length > FREE_UPLOAD_ITEM_BYTES) {
    throw new UploadError("This file is over the free upload size of 105 KB.");
  }
  if (target.paid && item.bytes.length > MAX_PAID_ITEM_BYTES) {
    throw new UploadError("This file is too large to upload.");
  }
  let lastProblem = "The storage service could not be reached.";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${target.service}/v1/tx/solana`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: item.bytes,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        // Large originals get longer, as if sent at 32 KB a second.
        signal: AbortSignal.timeout(Math.max(ATTEMPT_TIMEOUT_MS, Math.ceil(item.bytes.length / 32_768) * 1_000)),
      });
    } catch {
      lastProblem = "The storage service could not be reached. Check your connection and try again.";
      if (attempt < ATTEMPTS) await sleep(1_000 * attempt * attempt);
      continue;
    }
    if (response.ok) {
      // The id is fixed by the signature; check the service agrees when it says.
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      if (body && typeof body.id === "string" && body.id !== item.id) {
        throw new UploadError("The storage service answered with a different file id.");
      }
      return item.id;
    }
    if (response.status === 402) {
      throw target.paid
        ? new UploadError(
            "Your storage credit ran out before the upload finished. Launch again to add what is missing; files already stored are not uploaded twice.",
            "credit-short"
          )
        : new UploadError(
            "The free storage for this connection is used up. Pay for storage to go on, or link to metadata you host.",
            "free-used-up"
          );
    }
    if (response.status === 413) throw new UploadError("This file is too large to upload.");
    if (response.status === 429 || response.status >= 500) {
      lastProblem = `The storage service is busy (${response.status}). Try again in a minute.`;
      if (attempt < ATTEMPTS) await sleep(1_000 * attempt * attempt);
      continue;
    }
    throw new UploadError(`The storage service refused the file (${response.status}).`);
  }
  throw new UploadError(lastProblem);
}

export type Uploaded = { id: string; url: string };

// Identical files are uploaded once per page, so retrying a launch after a
// rejected wallet prompt does not upload (or pay for) everything again.
const uploaded = new Map<string, Promise<string>>();

/** Uploads bytes with a content type and returns where the gateway serves them. */
export async function uploadBytes(data: Uint8Array, contentType: string, target: UploadTarget): Promise<Uploaded> {
  const tags = [{ name: "Content-Type", value: contentType }];
  const key = `${target.service}\n${contentType}\n${bytesToHex(sha256(data))}`;
  let pending = uploaded.get(key);
  if (!pending) {
    pending = sendDataItem(createDataItem(data, tags, target.key), target);
    uploaded.set(key, pending);
    pending.catch(() => uploaded.delete(key));
  }
  const id = await pending;
  return { id, url: `${target.gateway}/${id}` };
}

/** The bytes a JSON document is uploaded as. */
export const jsonBytes = (value: unknown): Bytes => Uint8Array.from(utf8ToBytes(JSON.stringify(value)));

/** Uploads a JSON document. */
export function uploadJson(value: unknown, target: UploadTarget): Promise<Uploaded> {
  return uploadBytes(jsonBytes(value), "application/json", target);
}

export const MANIFEST_TYPE = "application/x.arweave-manifest+json";

/** Uploads an item signed earlier, unless this page already sent it; returns its id. */
export async function sendSigned(item: DataItem, target: UploadTarget): Promise<string> {
  const key = `${target.service}\nsigned\n${item.id}`;
  let pending = uploaded.get(key);
  if (!pending) {
    pending = sendDataItem(item, target);
    uploaded.set(key, pending);
    pending.catch(() => uploaded.delete(key));
  }
  return pending;
}

/**
 * Downloads an uploaded file. A file uploaded in the last few minutes may not
 * be on arweave.net yet, so the AR.IO gateway that serves new uploads at once
 * is tried too.
 */
export async function downloadFile(id: string, gateway: string): Promise<Bytes> {
  const urls = [`${gateway}/${id}`];
  if (gateway === ARWEAVE_GATEWAY) urls.push(`${FRESH_ARWEAVE_GATEWAY}/${id}`);
  let problem = "The file could not be downloaded.";
  for (const url of urls) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
        problem = `The storage gateway answered ${response.status} for ${id}.`;
        if (response.status === 404) break;
      } catch {
        problem = "The storage gateway could not be reached. Check your connection and try again.";
      }
      if (attempt < ATTEMPTS) await sleep(1_000 * attempt * attempt);
    }
  }
  throw new Error(problem);
}

/** A path manifest that serves each path from an uploaded file. */
export function manifestOf(paths: Record<string, string>) {
  return {
    manifest: "arweave/paths",
    version: "0.1.0",
    paths: Object.fromEntries(Object.entries(paths).map(([path, id]) => [path, { id }])),
  };
}

/**
 * Uploads a path manifest that serves each path from an uploaded file, so
 * `<url>0.json` reads the file stored for "0.json". The url ends with "/".
 */
export async function uploadManifest(paths: Record<string, string>, target: UploadTarget): Promise<Uploaded> {
  const { id, url } = await uploadBytes(jsonBytes(manifestOf(paths)), MANIFEST_TYPE, target);
  return { id, url: `${url}/` };
}
