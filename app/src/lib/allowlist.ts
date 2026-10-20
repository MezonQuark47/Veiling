import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";
import { type UploadTarget, uploadJson } from "./arweave";

/**
 * A token sale's allowlist: the wallets allowed to bid. The program keeps only
 * the root of a Merkle tree of them (`Allowlist::root`) and a link to the list
 * itself; each wallet joins with its proof (`join_auction`). Mirrors
 * `allowlist_leaf` and `allowlist_node` in the program.
 */

/** Most wallets an allowlist can hold here; the tree itself allows far more. */
export const MAX_ALLOWLIST = 20_000;
/** Wallets per published chunk, so each file stays inside free storage. */
const CHUNK = 2_000;
const FORMAT = "veiling-allowlist/v1";

const LEAF_TAG = Uint8Array.of(0);
const NODE_TAG = Uint8Array.of(1);

export const allowlistLeaf = (wallet: PublicKey) => sha256(concatBytes(LEAF_TAG, wallet.toBytes()));

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function allowlistNode(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [low, high] = compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(concatBytes(NODE_TAG, low, high));
}

/** Every level of the tree, leaves first: neighbours pair up, an odd node is carried up. */
function levels(wallets: PublicKey[]): Uint8Array[][] {
  if (wallets.length === 0) throw new Error("An allowlist needs at least one wallet.");
  const out = [wallets.map(allowlistLeaf)];
  while (out[out.length - 1].length > 1) {
    const level = out[out.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? allowlistNode(level[i], level[i + 1]) : level[i]);
    out.push(next);
  }
  return out;
}

/** The list in the order the tree uses: sorted, without repeats. */
export function canonicalList(wallets: PublicKey[]): PublicKey[] {
  const unique = new Map(wallets.map((w) => [w.toBase58(), w]));
  return [...unique.values()].sort((a, b) => compare(a.toBytes(), b.toBytes()));
}

/** The root the program keeps for `wallets` (in `canonicalList` order). */
export const allowlistRoot = (wallets: PublicKey[]): Uint8Array => levels(wallets).at(-1)![0];

/** `wallet`'s proof, or null when the list does not hold it. */
export function allowlistProof(wallets: PublicKey[], wallet: PublicKey): Uint8Array[] | null {
  let at = wallets.findIndex((w) => w.equals(wallet));
  if (at < 0) return null;
  const proof: Uint8Array[] = [];
  for (const level of levels(wallets).slice(0, -1)) {
    const sibling = at ^ 1;
    if (sibling < level.length) proof.push(level[sibling]);
    at = Math.floor(at / 2);
  }
  return proof;
}

/** The root a proof leads to, as the program checks it. */
export const rootOfProof = (wallet: PublicKey, proof: Uint8Array[]) =>
  proof.reduce((node, sibling) => allowlistNode(node, sibling), allowlistLeaf(wallet));

/**
 * Reads wallet addresses typed or pasted by a seller, one per line or
 * separated by commas, spaces or semicolons (a CSV's first column works too).
 * Returns the valid wallets, in list order, and what could not be read.
 */
export function parseWallets(text: string): { wallets: PublicKey[]; invalid: string[] } {
  const wallets: PublicKey[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const word = raw.trim().replace(/^["']|["']$/g, "");
    if (!word) continue;
    try {
      const key = new PublicKey(word);
      if (key.toBase58() !== word) throw new Error("not canonical");
      wallets.push(key);
    } catch {
      invalid.push(word);
    }
  }
  return { wallets: canonicalList(wallets), invalid };
}

interface ListIndex {
  format: string;
  root: string;
  count: number;
  chunks: string[];
}

/**
 * Publishes the list: chunks of `CHUNK` addresses, then an index naming the
 * root and the chunks. Returns the index's link, which `set_allowlist`
 * records next to the root.
 */
export async function publishAllowlist(wallets: PublicKey[], target: UploadTarget): Promise<string> {
  const list = canonicalList(wallets);
  if (list.length > MAX_ALLOWLIST) throw new Error(`An allowlist holds at most ${MAX_ALLOWLIST.toLocaleString("en-US")} wallets.`);
  const chunks: string[] = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    chunks.push((await uploadJson(list.slice(i, i + CHUNK).map((w) => w.toBase58()), target)).url);
  }
  const index: ListIndex = { format: FORMAT, root: bytesToHex(allowlistRoot(list)), count: list.length, chunks };
  return (await uploadJson(index, target)).url;
}

const lists = new Map<string, Promise<PublicKey[]>>();

/**
 * Downloads a sale's list from its link and checks it against the root the
 * program keeps, so a link that serves another list is refused.
 */
export function fetchAllowlist(uri: string, root: Uint8Array): Promise<PublicKey[]> {
  const key = `${uri}\n${bytesToHex(root)}`;
  let pending = lists.get(key);
  if (!pending) {
    pending = (async () => {
      const index = (await (await fetch(uri)).json()) as ListIndex;
      if (index.format !== FORMAT || !Array.isArray(index.chunks)) throw new Error("The allowlist could not be read.");
      const words: string[] = [];
      for (const chunk of index.chunks) words.push(...((await (await fetch(chunk)).json()) as string[]));
      const wallets = words.map((w) => new PublicKey(w));
      if (bytesToHex(allowlistRoot(wallets)) !== bytesToHex(root)) {
        throw new Error("The published allowlist does not match the one this sale committed to.");
      }
      return wallets;
    })();
    lists.set(key, pending);
    pending.catch(() => lists.delete(key));
  }
  return pending;
}
