// Builds the metadata files a token or a collection needs, uploads them with
// their images, and returns the links that go on chain.
//
// A collection's files follow the Metaplex metadata standard with the fields
// OpenSea reads too: each NFT has its name, description, image, link and
// traits; the collection has its logo, banner and links. A hidden drop seals
// its NFTs' files at launch and publishes them at the reveal (see sealed.ts).
import type { PublicKey } from "@solana/web3.js";
import { ARWEAVE_GATEWAY, PAID_STORAGE } from "../config";
import {
  type DataItem,
  MANIFEST_TYPE,
  type UploadTarget,
  dataItemFromBytes,
  dataItemSize,
  downloadFile,
  jsonBytes,
  manifestOf,
  sendSigned,
  signFile,
  uploadBytes,
  uploadJson,
  uploadManifest,
} from "./arweave";
import type { Trait } from "./csv";
import { type PreparedImage, loadOriginal } from "./images";
import {
  SEALED_CONTENT_TYPE,
  type SealedIndex,
  openPackage,
  packRecords,
  packageGroups,
  packageLimit,
  packageUploadSize,
  sealPackage,
  unpackRecords,
} from "./sealed";

/** Reports how many of the planned uploads are done. */
export type Progress = (done: number, total: number) => void;

/** Which form of each image is stored: compressed for free storage, or the original, paid for. */
export type Quality = "compressed" | "original";

/** Free storage (small files, limited allowance) or storage paid for with credit. */
export type StorageKind = "free" | "paid";

const PARALLEL_UPLOADS = 4;
/** Arweave ids are 43 characters, so files can be sized before they are uploaded. */
const PLACEHOLDER_ID = "x".repeat(43);
/** Solana addresses are at most 44 characters. */
const PLACEHOLDER_ADDRESS = "x".repeat(44);

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function counter(total: number, progress: Progress) {
  let done = 0;
  let planned = total;
  progress(0, planned);
  return {
    step: () => progress(++done, planned),
    /** The plan grew or shrank once real sizes were known. */
    replan: (count: number) => {
      planned = count;
      progress(done, planned);
    },
  };
}

const withDescription = (description: string) => (description.trim() ? { description: description.trim() } : {});

/** The gateway that serves uploads of a kind of storage. */
export const gatewayOf = (storage: StorageKind) => (storage === "paid" ? PAID_STORAGE.gateway : ARWEAVE_GATEWAY);

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Uploads a new token's image (if any) and metadata file; returns the metadata link. */
export async function uploadTokenMetadata(
  token: {
    name: string;
    symbol: string;
    description: string;
    image: PreparedImage | null;
    links?: { website: string; x: string };
  },
  progress: Progress,
  target: UploadTarget
): Promise<string> {
  const { step } = counter(token.image ? 2 : 1, progress);
  let image: string | null = null;
  if (token.image) {
    image = (await uploadBytes(token.image.bytes, token.image.type, target)).url;
    step();
  }
  const { url } = await uploadJson(
    {
      name: token.name,
      symbol: token.symbol,
      ...withDescription(token.description),
      ...(image ? { image } : {}),
      // Where wallets and explorers look for a token's links, and where Veiling does.
      ...(token.links?.website ? { external_url: token.links.website, website: token.links.website } : {}),
      ...(token.links?.x ? { twitter: token.links.x } : {}),
      ...(token.links?.website || token.links?.x
        ? { veiling: { links: { website: token.links.website || undefined, x: token.links.x || undefined } } }
        : {}),
    },
    target
  );
  step();
  return url;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** One NFT's metadata file. */
export type NftFile = {
  /** Exactly the name the NFT gets on chain. */
  name: string;
  /** Empty for the collection's description. */
  description: string;
  /** A link to the NFT's page on the creator's site; empty for none. */
  externalUrl: string;
  attributes: Trait[];
  image: PreparedImage;
};

export type CollectionLinks = { website: string; x: string };

export type CollectionUpload = {
  /** How the collection was put together, for the sale page: all at once, or item by item. */
  kind: "drop" | "collection";
  name: string;
  description: string;
  /** The collection's logo. */
  image: PreparedImage;
  banner: PreparedImage | null;
  links: CollectionLinks;
  /** Every NFT's file in NFT-number order when `perNft`, else the one file every NFT shares. */
  nfts: NftFile[];
  perNft: boolean;
  /** Hidden drops seal their NFTs' files at launch and publish them at the reveal. */
  hidden: boolean;
  /** Hidden drops: what the sale page shows until the reveal; the logo when null. */
  preview: PreparedImage | null;
};

const fileFields = (url: string, type: string) => ({ files: [{ uri: url, type }], category: "image" });

/** An NFT's metadata: Metaplex's fields, plus the link and traits OpenSea reads. */
function nftJson(c: CollectionUpload, nft: NftFile, url: string, type: string) {
  return {
    name: nft.name,
    ...withDescription(nft.description.trim() || c.description),
    image: url,
    ...(nft.externalUrl ? { external_url: nft.externalUrl } : {}),
    ...(nft.attributes.length > 0 ? { attributes: nft.attributes } : {}),
    properties: fileFields(url, type),
  };
}

type CollectionExtras = { banner: string | null; preview: string | null; sealed: string | null };

/** The collection's metadata, with what Veiling's sale page shows under `veiling`. */
function collectionJson(c: CollectionUpload, url: string, type: string, extras: CollectionExtras) {
  return {
    name: c.name,
    ...withDescription(c.description),
    image: url,
    ...(extras.banner ? { banner_image: extras.banner } : {}),
    ...(c.links.website ? { external_url: c.links.website } : {}),
    properties: fileFields(url, type),
    veiling: {
      kind: c.kind,
      ...(c.links.x ? { links: { x: c.links.x } } : {}),
      ...(c.hidden ? { hidden: true } : {}),
      ...(extras.preview ? { preview: extras.preview } : {}),
      ...(extras.sealed ? { sealed: extras.sealed } : {}),
    },
  };
}

/** An image's file at a quality: its size and type, or null if its original cannot be used. */
function imageInfo(image: PreparedImage, quality: Quality): { size: number; type: string } | null {
  if (quality === "compressed") return { size: image.bytes.length, type: image.type };
  return image.original.ok ? { size: image.original.size, type: image.original.type } : null;
}

/** The NFTs' images, each once, in the order NFTs first use them. */
function nftImages(c: CollectionUpload): PreparedImage[] {
  return [...new Set(c.nfts.map((nft) => nft.image))];
}

/** The images published at launch: the logo, the banner and, for a hidden drop, its preview. */
function publicImages(c: CollectionUpload): PreparedImage[] {
  const images = [c.image, c.banner, c.hidden ? c.preview : null].filter((i): i is PreparedImage => i !== null);
  if (!c.hidden) images.push(...nftImages(c));
  return [...new Set(images)];
}

// Images already stored this session, by file and quality, so a launch tried
// again skips them, and neither reads nor pays for them twice.
const stored = new Map<string, { url: string; type: string }>();
const storedKey = (image: PreparedImage, quality: Quality, target: UploadTarget) =>
  [target.service, quality, image.file.name, image.file.size, image.file.lastModified].join("\n");

const imageFile = (image: PreparedImage, quality: Quality) =>
  quality === "original" ? loadOriginal(image) : Promise.resolve({ bytes: image.bytes, type: image.type });

async function uploadImage(image: PreparedImage, quality: Quality, target: UploadTarget) {
  const key = storedKey(image, quality, target);
  const done = stored.get(key);
  if (done) return done;
  const file = await imageFile(image, quality);
  const { url } = await uploadBytes(file.bytes, file.type, target);
  const result = { url, type: file.type };
  stored.set(key, result);
  return result;
}

const jsonSize = (value: unknown) => dataItemSize(jsonBytes(value).length, "application/json");

/** What a collection's upload stores: at launch, and (hidden drops) at the reveal. Signed upload sizes. */
export type UploadSizes = { launch: number[]; reveal: number[] };

/**
 * The signed sizes of the NFTs' own files, in signing order: their images
 * (less any published with the collection, or already stored when `skip`
 * says so), metadata and folder.
 */
function nftFileSizes(
  c: CollectionUpload,
  quality: Quality,
  gateway: string,
  skip: (image: PreparedImage) => boolean
): number[] | null {
  const url = `${gateway}/${PLACEHOLDER_ID}`;
  const sizes: number[] = [];
  const types = new Map<PreparedImage, string>();
  for (const image of nftImages(c)) {
    const info = imageInfo(image, quality);
    if (!info) return null;
    types.set(image, info.type);
    const published = !c.hidden && (image === c.image || image === c.banner);
    if (!published && !skip(image)) sizes.push(dataItemSize(info.size, info.type));
  }
  for (const nft of c.nfts) sizes.push(jsonSize(nftJson(c, nft, url, types.get(nft.image)!)));
  if (c.perNft) {
    const paths = Object.fromEntries(c.nfts.map((_, i) => [`${i}.json`, PLACEHOLDER_ID]));
    sizes.push(dataItemSize(jsonBytes(manifestOf(paths)).length, MANIFEST_TYPE));
  }
  return sizes;
}

/**
 * The sizes of the files a collection upload stores, each as the signed
 * upload Turbo charges for. With `target`, images already stored there this
 * session are left out. Null if an original that is needed cannot be used.
 */
export function collectionUploadSizes(
  c: CollectionUpload,
  quality: Quality,
  storage: StorageKind,
  target?: UploadTarget
): UploadSizes | null {
  const gateway = gatewayOf(storage);
  const url = `${gateway}/${PLACEHOLDER_ID}`;
  const launch: number[] = [];
  const logo = imageInfo(c.image, quality);
  if (!logo) return null;
  const done = (image: PreparedImage) => Boolean(target && stored.has(storedKey(image, quality, target)));
  for (const image of publicImages(c)) {
    if (!c.hidden && image !== c.image && image !== c.banner) continue; // counted with the NFTs' files
    const info = imageInfo(image, quality);
    if (!info) return null;
    if (!done(image)) launch.push(dataItemSize(info.size, info.type));
  }
  // A hidden drop's NFT files are signed afresh, never taken from earlier uploads.
  const files = nftFileSizes(c, quality, gateway, c.hidden ? () => false : done);
  if (!files) return null;
  const extras = { banner: c.banner ? url : null, preview: c.hidden && c.preview ? url : null, sealed: c.hidden ? PLACEHOLDER_ID : null };
  if (!c.hidden) {
    launch.push(...files, jsonSize(collectionJson(c, url, logo.type, extras)));
    return { launch, reveal: [] };
  }
  const groups = packageGroups(files, packageLimit(storage === "paid"));
  for (const group of groups) launch.push(packageUploadSize(group.map((i) => files[i])));
  launch.push(jsonSize(sealedIndex(PLACEHOLDER_ADDRESS, storage, PLACEHOLDER_ID, files, groups.map(() => PLACEHOLDER_ID))));
  launch.push(jsonSize(collectionJson(c, url, logo.type, extras)));
  return { launch, reveal: files };
}

function sealedIndex(auction: string, storage: StorageKind, manifest: string, sizes: number[], packages: string[]): SealedIndex {
  return {
    veiling: "sealed-art",
    version: 1,
    auction,
    cipher: "AES-256-GCM",
    upload: storage,
    manifest,
    files: sizes.length,
    bytes: sizes.reduce((sum, size) => sum + size, 0),
    packages,
  };
}

export type CollectionLinksOnChain = { collectionUri: string; itemUri: string; uriPerItem: boolean };

/** What sealing a hidden drop needs: the key only the seller's wallet can make again, and the auction it is for. */
export type SealOptions = { key: Uint8Array; auction: PublicKey };

/**
 * Uploads a collection's art and metadata. Returns the collection's metadata
 * link and the NFTs' link: one file for all of them, or a folder where NFT
 * #n reads `${n - 1}.json`. A hidden drop's NFT files are sealed instead, and
 * its folder link is fixed but not served until the reveal.
 */
export async function uploadCollection(
  c: CollectionUpload,
  quality: Quality,
  progress: Progress,
  target: UploadTarget,
  seal?: SealOptions
): Promise<CollectionLinksOnChain> {
  const storage: StorageKind = target.paid ? "paid" : "free";
  // Every file counts towards progress, including any stored on an earlier try.
  const sizes = collectionUploadSizes(c, quality, storage);
  if (!sizes) throw new Error("An image cannot be kept as it is. Choose compressed storage.");
  const plan = counter(sizes.launch.length, progress);

  const logo = await uploadImage(c.image, quality, target);
  plan.step();
  const banner = c.banner ? await uploadImage(c.banner, quality, target) : null;
  if (banner) plan.step();

  if (c.hidden) {
    if (!seal) throw new Error("A hidden drop needs its sealing key.");
    if (!c.perNft) throw new Error("A hidden drop needs one metadata file per NFT.");
    const preview = c.preview ? await uploadImage(c.preview, quality, target) : null;
    if (preview) plan.step();
    const { manifest, packages, files } = await sealNftFiles(c, quality, target, seal.key, plan);
    const index = await uploadJson(sealedIndex(seal.auction.toBase58(), storage, manifest.id, files, packages), target);
    plan.step();
    const collection = await uploadJson(
      collectionJson(c, logo.url, logo.type, { banner: banner?.url ?? null, preview: preview?.url ?? null, sealed: index.id }),
      target
    );
    plan.step();
    return { collectionUri: collection.url, itemUri: `${target.gateway}/${manifest.id}/`, uriPerItem: true };
  }

  const images = new Map<PreparedImage, { url: string; type: string }>([[c.image, logo]]);
  await mapLimited(
    nftImages(c).filter((image) => !images.has(image)),
    PARALLEL_UPLOADS,
    async (image) => {
      images.set(image, await uploadImage(image, quality, target));
      plan.step();
    }
  );
  const ids = await mapLimited(c.nfts, PARALLEL_UPLOADS, async (nft) => {
    const image = images.get(nft.image)!;
    const uploaded = await uploadJson(nftJson(c, nft, image.url, image.type), target);
    plan.step();
    return uploaded;
  });
  let itemUri: string;
  if (c.perNft) {
    itemUri = (await uploadManifest(Object.fromEntries(ids.map((file, i) => [`${i}.json`, file.id])), target)).url;
    plan.step();
  } else {
    itemUri = ids[0].url;
  }
  const collection = await uploadJson(collectionJson(c, logo.url, logo.type, { banner: banner?.url ?? null, preview: null, sealed: null }), target);
  plan.step();
  return { collectionUri: collection.url, itemUri, uriPerItem: c.perNft };
}

// Packages sealed this session, by their contents, so a launch tried again
// does not upload (or pay for) the same sealed files twice.
const sealedPackages = new Map<string, Promise<string>>();

async function sealAndUpload(key: Uint8Array, files: DataItem[], target: UploadTarget): Promise<string> {
  const contents = packRecords(files.map((file) => file.bytes));
  const id = [target.service, ...files.map((file) => file.id)].join("\n");
  let pending = sealedPackages.get(id);
  if (!pending) {
    pending = sealPackage(key, contents).then((sealed) => uploadBytes(sealed, SEALED_CONTENT_TYPE, target).then((u) => u.id));
    sealedPackages.set(id, pending);
    pending.catch(() => sealedPackages.delete(id));
  }
  return pending;
}

/**
 * Signs a hidden drop's NFT files (images, metadata and folder) with the
 * upload key, without publishing them, and uploads them sealed in packages.
 * Returns the folder's signed file, the package ids and the files' sizes.
 */
async function sealNftFiles(
  c: CollectionUpload,
  quality: Quality,
  target: UploadTarget,
  key: Uint8Array,
  plan: ReturnType<typeof counter>
): Promise<{ manifest: DataItem; packages: string[]; files: number[] }> {
  const limit = packageLimit(target.paid);
  const packages: string[] = [];
  const files: number[] = [];
  let pending: DataItem[] = [];
  let used = 0;
  const flush = async () => {
    if (pending.length === 0) return;
    packages.push(await sealAndUpload(key, pending, target));
    plan.step();
    pending = [];
    used = 0;
  };
  const add = async (item: DataItem) => {
    const record = 4 + item.bytes.length;
    if (pending.length > 0 && used + record > limit) await flush();
    pending.push(item);
    used += record;
    files.push(item.bytes.length);
  };

  const images = new Map<PreparedImage, { url: string; type: string }>();
  for (const image of nftImages(c)) {
    const file = await imageFile(image, quality);
    const item = signFile(file.bytes, file.type, target.key);
    images.set(image, { url: `${target.gateway}/${item.id}`, type: file.type });
    await add(item);
  }
  const ids: string[] = [];
  for (const nft of c.nfts) {
    const image = images.get(nft.image)!;
    const item = signFile(jsonBytes(nftJson(c, nft, image.url, image.type)), "application/json", target.key);
    ids.push(item.id);
    await add(item);
  }
  const manifest = signFile(
    jsonBytes(manifestOf(Object.fromEntries(ids.map((id, i) => [`${i}.json`, id])))),
    MANIFEST_TYPE,
    target.key
  );
  await add(manifest);
  await flush();
  return { manifest, packages, files };
}

/** The folder id in a hidden drop's committed link (`<gateway>/<id>/`). */
export function committedManifest(itemUri: string): string | null {
  const match = itemUri.match(/\/([A-Za-z0-9_-]{43})\/$/);
  return match ? match[1] : null;
}

/**
 * Publishes a hidden drop's art: opens each sealed package with the seller's
 * key and uploads the signed files in it, exactly as they were signed, so
 * they appear at the addresses committed on chain. The last file must be
 * the folder `itemUri` names.
 */
export async function publishSealedArt(
  index: SealedIndex,
  key: Uint8Array,
  itemUri: string,
  target: UploadTarget,
  progress: Progress
): Promise<void> {
  const committed = committedManifest(itemUri);
  if (!committed || committed !== index.manifest) {
    throw new Error("The sealed art does not match the link committed on chain, so it was not published.");
  }
  const gateway = gatewayOf(index.upload);
  let done = 0;
  let bytes = 0;
  let last: DataItem | null = null;
  progress(0, index.files);
  for (const id of index.packages) {
    const opened = await openPackage(key, await downloadFile(id, gateway));
    const items = unpackRecords(opened).map(dataItemFromBytes);
    await mapLimited(items, PARALLEL_UPLOADS, async (item) => {
      await sendSigned(item, target);
      progress(++done, index.files);
    });
    bytes += items.reduce((sum, item) => sum + item.bytes.length, 0);
    if (items.length > 0) last = items[items.length - 1];
  }
  if (done !== index.files || bytes !== index.bytes || !last || last.id !== committed) {
    throw new Error("The sealed art was incomplete, so the collection was not revealed.");
  }
}
