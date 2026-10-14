import type { PublicKey } from "@solana/web3.js";

/**
 * A bidder's own price and size, kept in this browser so the page can remind
 * them what they sealed. Notes are deleted once the bid is closed and expire
 * after `NOTE_TTL_DAYS`, so plaintext bids do not pile up in storage. The
 * same note is also stored encrypted on chain (`bidNotes.ts`), which is how
 * another device gets it back.
 */
export interface BidNote {
  /** The most the bid pays, in the auction's price ticks (a decimal string). */
  price: string;
  /** NFTs asked for; 0 for a token bid, whose size is its deposit. */
  quantity: number;
  auction: string;
  savedAt: number;
}

// Notes of the earlier price-ladder bids used another key and are pruned.
const PREFIX = "veiling.bid2.";
const OLD_PREFIX = "veiling.bid.";
const NOTE_TTL_DAYS = 30;
/** This page's notes, for browsers that keep no storage. */
const memory = new Map<string, BidNote>();

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function saveNote(bid: PublicKey, auction: PublicKey, price: bigint, quantity: number) {
  const note: BidNote = { price: price.toString(), quantity, auction: auction.toBase58(), savedAt: Date.now() };
  memory.set(bid.toBase58(), note);
  try {
    storage()?.setItem(PREFIX + bid.toBase58(), JSON.stringify(note));
  } catch {
    // Optional convenience only.
  }
}

function isNote(value: unknown): value is BidNote {
  const note = value as BidNote | null;
  return (
    typeof note === "object" &&
    note !== null &&
    typeof note.price === "string" &&
    /^\d+$/.test(note.price) &&
    typeof note.quantity === "number" &&
    typeof note.auction === "string" &&
    typeof note.savedAt === "number"
  );
}

export function readNote(bid: PublicKey): BidNote | null {
  const kept = memory.get(bid.toBase58());
  if (kept) return kept;
  try {
    const raw = storage()?.getItem(PREFIX + bid.toBase58());
    const note: unknown = raw ? JSON.parse(raw) : null;
    return isNote(note) ? note : null;
  } catch {
    return null;
  }
}

export function forgetNote(bid: PublicKey) {
  memory.delete(bid.toBase58());
  try {
    storage()?.removeItem(PREFIX + bid.toBase58());
  } catch {
    // Nothing to clean up.
  }
}

function allNotes(): [string, BidNote | null][] {
  const store = storage();
  if (!store) return [];
  const out: [string, BidNote | null][] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key || !(key.startsWith(PREFIX) || key.startsWith(OLD_PREFIX))) continue;
      let note: BidNote | null = null;
      try {
        const value: unknown = key.startsWith(PREFIX) ? JSON.parse(store.getItem(key) ?? "null") : null;
        note = isNote(value) ? value : null;
      } catch {
        note = null;
      }
      out.push([key, note]);
    }
  } catch {
    return [];
  }
  return out;
}

/** Removes expired, outdated or unreadable notes. */
export function pruneNotes() {
  const cutoff = Date.now() - NOTE_TTL_DAYS * 24 * 60 * 60 * 1000;
  for (const [key, note] of allNotes()) {
    if (!note || typeof note.savedAt !== "number" || note.savedAt < cutoff) {
      try {
        storage()?.removeItem(key);
      } catch {
        // Ignore.
      }
    }
  }
}

/**
 * Deletes the notes of `auction` whose bid accounts no longer exist and
 * returns how many there were. While bidding is open the only way a bid
 * disappears is being replaced by a larger deposit in a full auction.
 */
export function forgetClosedBids(auction: PublicKey, liveBids: PublicKey[]): number {
  const live = new Set(liveBids.map((b) => b.toBase58()));
  const id = auction.toBase58();
  // A bid placed moments ago may not show up in every RPC node's results yet.
  const settledBefore = Date.now() - 2 * 60 * 1000;
  let removed = 0;
  for (const [key, note] of allNotes()) {
    if (note?.auction === id && note.savedAt < settledBefore && !live.has(key.slice(PREFIX.length))) {
      memory.delete(key.slice(PREFIX.length));
      try {
        storage()?.removeItem(key);
        removed++;
      } catch {
        // Ignore.
      }
    }
  }
  return removed;
}
