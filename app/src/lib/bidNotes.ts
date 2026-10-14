// A bidder's note of what they sealed, kept on chain next to the bid (the
// program's `BidNote` account), so it shows on every device the wallet is
// used on. The program stores 32 opaque bytes; this file encrypts the bid's
// price and size into them with AES-256-GCM under a key made from the
// wallet's signature of a fixed message. Ed25519 signatures are
// deterministic, so the same wallet makes the same key everywhere, and
// nobody without the wallet can.
//
// Layout of the 32 bytes: version (2), then the ciphertext of price (u32 LE,
// price ticks) and size (u64 LE: a token bid's budget in lamports, or NFTs)
// with its 16-byte tag (28), then zeros. Version 1 notes held the size as a
// u32 and are still read.
// The IV comes from the bid's address, which is unique, and the address is
// also bound in as associated data, so a note cannot be moved to another bid.
import { utils } from "@anchor-lang/core";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { type AccountInfo, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID } from "../config";
import { connection, program } from "./chain";
import { readNote, saveNote } from "./notes";
import type { WalletSigner } from "./tx";

export const BID_NOTE_LEN = 32;
const VERSION = 2;
/** Plaintext bytes by version: price u32 and size u32 (1), or size u64 (2). */
const PLAIN_LEN: Record<number, number> = { 1: 8, 2: 12 };
const TAG_LEN = 16;
const DISCRIMINATOR = utf8ToBytes("VNote_01");
/** Discriminator, bid, bidder, note, bump. */
const ACCOUNT_LEN = 8 + 32 + 32 + BID_NOTE_LEN + 1;
const BIDDER_OFFSET = 8 + 32;
const NOTE_OFFSET = 8 + 32 + 32;

/** A copy backed by a plain ArrayBuffer, as WebCrypto takes it. */
const plainBytes = (bytes: Uint8Array) => new Uint8Array(bytes);

export const noteAddress = (bid: PublicKey) =>
  PublicKey.findProgramAddressSync([utf8ToBytes("note"), bid.toBytes()], PROGRAM_ID)[0];

/** What the wallet is asked to sign; the wallet shows it. */
export function noteKeyMessage(wallet: PublicKey): Uint8Array {
  return utf8ToBytes(
    "Veiling bid notes\n\n" +
      "Sign to let this site save the price and size of your bids encrypted on chain, and show them to you on any " +
      "device. Only this wallet can read them. Signing costs nothing and cannot move anything from your wallet. " +
      "Only sign this on the Veiling site.\n\n" +
      `Wallet: ${wallet.toBase58()}`
  );
}

const keys = new Map<string, Promise<CryptoKey>>();

/** Whether this page already holds the wallet's note key, so using it asks for nothing. */
export const hasNoteKey = (wallet: PublicKey) => keys.has(wallet.toBase58());

/** The wallet's note key. Asks the wallet to sign once per page. */
export function walletNoteKey(signer: WalletSigner): Promise<CryptoKey> {
  const id = signer.publicKey.toBase58();
  let entry = keys.get(id);
  if (!entry) {
    entry = (async () => {
      if (!signer.signMessage) throw new Error("This wallet cannot sign messages.");
      const { signedMessage, signature } = await signer.signMessage(noteKeyMessage(signer.publicKey));
      if (!ed25519.verify(signature, signedMessage, signer.publicKey.toBytes())) {
        throw new Error("The wallet's signature did not check out.");
      }
      const raw = sha256(concatBytes(utf8ToBytes("veiling/bid-note-key/v1"), signature));
      return crypto.subtle.importKey("raw", plainBytes(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
    })();
    keys.set(id, entry);
    entry.catch(() => keys.delete(id));
  }
  return entry;
}

const ivOf = (bid: PublicKey) => plainBytes(sha256(concatBytes(utf8ToBytes("veiling/bid-note-iv/v1"), bid.toBytes())).slice(0, 12));

/**
 * The 32 bytes stored for a bid at up to `price` ticks, of `quantity`: a
 * token bid's budget in lamports, or a collection bid's NFTs.
 */
export async function sealBidNote(key: CryptoKey, bid: PublicKey, price: bigint, quantity: bigint): Promise<Uint8Array> {
  if (price < 0n || price > 0xffff_ffffn) throw new Error("Price out of range");
  if (quantity < 0n || quantity > 0xffff_ffff_ffff_ffffn) throw new Error("Size out of range");
  const plain = new Uint8Array(PLAIN_LEN[VERSION]);
  const view = new DataView(plain.buffer);
  view.setUint32(0, Number(price), true);
  view.setBigUint64(4, quantity, true);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivOf(bid), additionalData: plainBytes(bid.toBytes()) }, key, plain)
  );
  const out = new Uint8Array(BID_NOTE_LEN);
  out[0] = VERSION;
  out.set(sealed, 1);
  return out;
}

/** Opens a stored note; null if it is not one this key made for this bid. */
export async function openBidNote(
  key: CryptoKey,
  bid: PublicKey,
  bytes: Uint8Array
): Promise<{ price: bigint; quantity: bigint } | null> {
  const length = PLAIN_LEN[bytes[0]];
  if (bytes.length !== BID_NOTE_LEN || !length) return null;
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ivOf(bid), additionalData: plainBytes(bid.toBytes()) },
        key,
        plainBytes(bytes.slice(1, 1 + length + TAG_LEN))
      )
    );
    const view = new DataView(plain.buffer);
    const quantity = length === 8 ? BigInt(view.getUint32(4, true)) : view.getBigUint64(4, true);
    return { price: BigInt(view.getUint32(0, true)), quantity };
  } catch {
    return null;
  }
}

export function saveNoteInstruction(bidder: PublicKey, bid: PublicKey, note: Uint8Array): Promise<TransactionInstruction> {
  return program.methods
    .saveBidNote(Array.from(note))
    .accountsPartial({ bidder, bid, note: noteAddress(bid) })
    .instruction();
}

export function closeNoteInstruction(closer: PublicKey, bidder: PublicKey, bid: PublicKey): Promise<TransactionInstruction> {
  return program.methods
    .closeBidNote()
    .accountsPartial({ closer, bidder, bid, note: noteAddress(bid) })
    .instruction();
}

/**
 * The note instruction for a bid about to be placed, or null when the wallet
 * cannot or will not sign for the key; the bid then goes ahead with a note in
 * this browser only.
 */
export async function noteForNewBid(
  signer: WalletSigner,
  bid: PublicKey,
  price: bigint,
  quantity: bigint
): Promise<TransactionInstruction | null> {
  try {
    const key = await walletNoteKey(signer);
    return await saveNoteInstruction(signer.publicKey, bid, await sealBidNote(key, bid, price, quantity));
  } catch {
    return null;
  }
}

function parse(data: Uint8Array): { bidder: PublicKey; note: Uint8Array } | null {
  if (data.length < ACCOUNT_LEN || !DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  return {
    bidder: new PublicKey(data.slice(BIDDER_OFFSET, BIDDER_OFFSET + 32)),
    note: data.slice(NOTE_OFFSET, NOTE_OFFSET + BID_NOTE_LEN),
  };
}

/** The stored notes of these bids, by bid address. */
export async function fetchBidNotes(bids: PublicKey[]): Promise<Map<string, Uint8Array>> {
  const found = new Map<string, Uint8Array>();
  for (let i = 0; i < bids.length; i += 100) {
    const chunk = bids.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk.map(noteAddress));
    infos.forEach((info, j) => {
      const parsed = info && info.owner.equals(PROGRAM_ID) ? parse(info.data) : null;
      if (parsed) found.set(chunk[j].toBase58(), parsed.note);
    });
  }
  return found;
}

/** Whether `bid` has a note on chain. */
export async function hasChainNote(bid: PublicKey): Promise<boolean> {
  const info = await connection.getAccountInfo(noteAddress(bid));
  return Boolean(info && info.owner.equals(PROGRAM_ID));
}

/**
 * Opens the stored notes of `bids` that this browser has no note for and
 * keeps them here. Returns how many it opened.
 */
export async function restoreNotes(
  signer: WalletSigner,
  bids: { address: PublicKey; auction: PublicKey }[]
): Promise<number> {
  const missing = bids.filter((b) => !readNote(b.address));
  if (missing.length === 0) return 0;
  const stored = await fetchBidNotes(missing.map((b) => b.address));
  if (stored.size === 0) return 0;
  const key = await walletNoteKey(signer);
  let opened = 0;
  for (const b of missing) {
    const bytes = stored.get(b.address.toBase58());
    const note = bytes ? await openBidNote(key, b.address, bytes) : null;
    if (note) {
      saveNote(b.address, b.auction, note.price, note.quantity);
      opened++;
    }
  }
  return opened;
}

/**
 * The wallet's notes whose bids are closed, for example bids replaced in a
 * full auction: each still holds a little rent that can come back.
 */
export async function fetchLeftoverNotes(bidder: PublicKey): Promise<{ note: PublicKey; bid: PublicKey; lamports: number }[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: ACCOUNT_LEN },
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(DISCRIMINATOR) } },
      { memcmp: { offset: BIDDER_OFFSET, bytes: bidder.toBase58() } },
    ],
  });
  if (accounts.length === 0) return [];
  const bids = accounts.map((a) => new PublicKey(a.account.data.slice(8, 40)));
  const bidInfos: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < bids.length; i += 100) {
    bidInfos.push(...(await connection.getMultipleAccountsInfo(bids.slice(i, i + 100))));
  }
  return accounts
    .map((a, i) => ({ note: a.pubkey, bid: bids[i], lamports: a.account.lamports, open: bidInfos[i] !== null }))
    .filter((n) => !n.open)
    .map(({ note, bid, lamports }) => ({ note, bid, lamports }));
}
