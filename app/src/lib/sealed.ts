// Hidden drops: the art goes on chain as a link at launch but is only
// published at the reveal, after the sale.
//
// At launch every file of the art (images, metadata and the folder that lists
// them) is signed as an Arweave upload, which fixes its address, but not
// published. The signed files are kept on Arweave encrypted, in packages,
// under a key that only the seller's wallet can make again: a hash of the
// wallet's signature of a fixed message and the auction's address. A small
// index lists the packages; the collection's metadata points to it.
//
// To reveal, the seller's wallet makes the key again, the packages are
// downloaded and opened, and the signed files are published exactly as they
// were signed, at the addresses committed on chain.
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { PublicKey } from "@solana/web3.js";
import { FREE_UPLOAD_ITEM_BYTES } from "../config";
import { dataItemSize } from "./arweave";

type Bytes = Uint8Array<ArrayBuffer>;

export const SEALED_CONTENT_TYPE = "application/octet-stream";
/** AES-GCM's nonce and tag, around each package's contents. */
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
/** Each signed file in a package is preceded by its length. */
const RECORD_HEADER = 4;
/** Paid packages are kept well under the single-upload limit. */
const PAID_PACKAGE_BYTES = 8 * 1024 * 1024;

/** What the collection's metadata points to: where the sealed packages are and what they hold. */
export type SealedIndex = {
  veiling: "sealed-art";
  version: 1;
  /** The auction the art belongs to; the key is made for it. */
  auction: string;
  cipher: "AES-256-GCM";
  /** Whether the files go to free or paid storage at the reveal. */
  upload: "free" | "paid";
  /** The folder of NFT metadata committed on chain. */
  manifest: string;
  /** Signed files and their total size, so the reveal can be priced before anything is opened. */
  files: number;
  bytes: number;
  /** Package ids, in the order the files were signed. */
  packages: string[];
};

/** The key that seals one auction's art: only the seller's wallet can make it again. */
export function revealKey(walletSignature: Uint8Array, auction: PublicKey): Bytes {
  return Uint8Array.from(sha256(concatBytes(utf8ToBytes("veiling/reveal-key/v1"), walletSignature, auction.toBytes())));
}

/** Largest package contents for a kind of storage, so each package is one upload of that kind. */
export function packageLimit(paid: boolean): number {
  if (paid) return PAID_PACKAGE_BYTES;
  return FREE_UPLOAD_ITEM_BYTES - dataItemSize(0, SEALED_CONTENT_TYPE) - IV_LENGTH - TAG_LENGTH;
}

/**
 * Groups signed files, in order, into packages whose contents stay within
 * `limit`; a file larger than that gets a package of its own. Returns each
 * package's file indexes.
 */
export function packageGroups(sizes: number[], limit: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let used = 0;
  sizes.forEach((size, i) => {
    const record = RECORD_HEADER + size;
    if (current.length > 0 && used + record > limit) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(i);
    used += record;
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

/** A package's contents for files of these sizes: each file with its length. */
export const packageContentSize = (sizes: number[]) => sizes.reduce((sum, size) => sum + RECORD_HEADER + size, 0);

/** The upload size of a package holding files of these sizes. */
export const packageUploadSize = (sizes: number[]) =>
  dataItemSize(IV_LENGTH + packageContentSize(sizes) + TAG_LENGTH, SEALED_CONTENT_TYPE);

/** Signed files laid end to end, each after its length. */
export function packRecords(files: Uint8Array[]): Bytes {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    const length = new Uint8Array(RECORD_HEADER);
    new DataView(length.buffer).setUint32(0, file.length, true);
    parts.push(length, file);
  }
  return Uint8Array.from(concatBytes(...parts));
}

export function unpackRecords(data: Uint8Array): Bytes[] {
  const files: Bytes[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  while (at < data.length) {
    if (at + RECORD_HEADER > data.length) throw new Error("A sealed package is cut short.");
    const length = view.getUint32(at, true);
    at += RECORD_HEADER;
    if (at + length > data.length) throw new Error("A sealed package is cut short.");
    files.push(Uint8Array.from(data.subarray(at, at + length)));
    at += length;
  }
  return files;
}

async function aesKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", Uint8Array.from(key), { name: "AES-GCM" }, false, [usage]);
}

/** Encrypts a package under a fresh random nonce, which goes in front. */
export async function sealPackage(key: Uint8Array, contents: Uint8Array): Promise<Bytes> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 }, await aesKey(key, "encrypt"), Uint8Array.from(contents))
  );
  return Uint8Array.from(concatBytes(iv, sealed));
}

export async function openPackage(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  if (data.length < IV_LENGTH + TAG_LENGTH) throw new Error("A sealed package is cut short.");
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Uint8Array.from(data.subarray(0, IV_LENGTH)), tagLength: TAG_LENGTH * 8 },
      await aesKey(key, "decrypt"),
      Uint8Array.from(data.subarray(IV_LENGTH))
    );
    return new Uint8Array(opened);
  } catch {
    throw new Error("The art could not be opened with this wallet's key. Reveal with the wallet that opened the auction.");
  }
}

/** Reads an index file; null if it is not one. */
export function parseSealedIndex(value: unknown): SealedIndex | null {
  const v = value as Partial<SealedIndex> | null;
  if (!v || v.veiling !== "sealed-art" || v.version !== 1 || v.cipher !== "AES-256-GCM") return null;
  const id = (s: unknown) => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);
  if (v.upload !== "free" && v.upload !== "paid") return null;
  if (!id(v.manifest) || typeof v.auction !== "string") return null;
  if (!Number.isSafeInteger(v.files) || !Number.isSafeInteger(v.bytes)) return null;
  if (!Array.isArray(v.packages) || v.packages.length === 0 || !v.packages.every(id)) return null;
  return v as SealedIndex;
}
