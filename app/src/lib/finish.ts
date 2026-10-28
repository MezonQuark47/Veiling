/**
 * "Finish the sale": anyone can take a sale through every public step after
 * bidding (the same ones the keeper runs, scripts/lib/finish.ts) with one
 * approval.
 *
 * The browser makes a one-time wallet (a session key), the person sends it a
 * little SOL for network fees, and the page signs each step with it, no
 * wallet pop-ups. The steps' rewards land in it too; when it is done (or
 * stopped, or the page is reopened later) everything left goes back to the
 * person who funded it. Each step it queues carries a memo naming that
 * person, so the points for it are theirs.
 */
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { NFT_MINT_COST_LAMPORTS, PENDING_TIMEOUT_SECS } from "../config";
import {
  buildBootstrapLiquidity,
  buildCheckBatch,
  buildCollect,
  buildDrawSeed,
  buildFinalizeShares,
  buildFindClearing,
  buildGraduateLaunch,
  buildRefundFailedBid,
  buildSettle,
} from "./actions";
import {
  type Auction,
  type Bid,
  connection,
  fetchAuction,
  fetchBid,
  fetchBidsForAuction,
  fetchLaunchToken,
  hasPending,
  needsShuffle,
  nftsReady,
  revealMissed,
  saleFailed,
  sharesAreFinal,
} from "./chain";
import { formatSol, nowSecs } from "./format";
import { type WalletSigner, sendTransaction, waitUntil } from "./tx";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const STORE = "veiling:finish-session";
/** Lamports one signature costs. */
const FEE = 5_000;

/** Bids whose tokens, NFTs or refund can be sent out now. */
export function deliverableBids(auction: Auction, bids: Bid[], now: number): Bid[] {
  const collection = auction.kind === "collection";
  const ready = nftsReady(auction, now);
  const missed = revealMissed(auction, now);
  return bids.filter(
    (b) =>
      b.status === "settled" &&
      ((auction.kind === "token" && (!auction.launch || auction.liquidity === "pooled" || b.won === 0n)) ||
        (collection && (b.won === 0n || b.delivered || missed || (ready && !auction.unrevealed))))
  );
}

type Step =
  | { kind: "wait"; text: string }
  | { kind: "check" }
  | { kind: "clear" }
  | { kind: "refund"; bid: Bid }
  | { kind: "settle"; bid: Bid }
  | { kind: "split"; bids: Bid[] }
  | { kind: "graduate" }
  | { kind: "pool" }
  | { kind: "shuffle" }
  | { kind: "deliver"; bid: Bid }
  | { kind: "done" };

/** What the sale needs next, if anything. */
async function nextStep(auction: Auction, bids: Bid[], now: number): Promise<Step> {
  if (hasPending(auction.pendingComputation, auction.pendingSince, now, PENDING_TIMEOUT_SECS)) {
    return { kind: "wait", text: "Waiting for Arcium" };
  }
  if (auction.status === "open") {
    if (now < auction.endTime || auction.bidCount === 0) return { kind: "done" };
    return auction.checkedCount < auction.bidCount ? { kind: "check" } : { kind: "clear" };
  }
  if (auction.status !== "settling") return { kind: "done" };
  const sealed = bids.filter((b) => b.status === "sealed");
  if (saleFailed(auction)) {
    if (sealed.length > 0) return { kind: "refund", bid: sealed[0] };
  } else {
    const free = sealed.filter((b) => !hasPending(b.pendingComputation, b.pendingSince, now, PENDING_TIMEOUT_SECS));
    if (free.length > 0) return { kind: "settle", bid: free[0] };
    if (sealed.length > 0) return { kind: "wait", text: "Waiting for Arcium" };
    const atClearing = bids.filter((b) => b.status === "atClearing");
    if (atClearing.length > 0 && sharesAreFinal(auction)) return { kind: "split", bids: atClearing };
    if (auction.liquidity === "planned" && auction.resolvedCount === auction.bidCount) {
      if (auction.launch && (await fetchLaunchToken(auction.address))) return { kind: "graduate" };
      return { kind: "pool" };
    }
    if (needsShuffle(auction)) return { kind: "shuffle" };
  }
  const deliver = deliverableBids(auction, bids, now);
  return deliver.length > 0 ? { kind: "deliver", bid: deliver[0] } : { kind: "done" };
}

/** Whether "Finish the sale" has anything to do here. */
export async function hasWorkLeft(auction: Auction, bids: Bid[], now: number): Promise<boolean> {
  return (await nextStep(auction, bids, now)).kind !== "done";
}

/**
 * Lamports to put in the session wallet. Each private step is paid for up
 * front and paid back with its reward when Arcium answers; finding the price
 * is the dearest (about 0.023 SOL on devnet). Then the accounts winners need
 * and the NFTs it creates. Most of it comes back.
 */
export function sessionBudget(auction: Auction, bids: Bid[]): bigint {
  const winners = bids.filter((b) => b.status !== "settled" || (b.won > 0n && !b.delivered));
  let lamports = 35_000_000n;
  if (auction.kind === "collection") {
    const nfts = bids.reduce((n, b) => n + (b.delivered ? 0n : b.won), 0n);
    lamports += nfts * (NFT_MINT_COST_LAMPORTS + 50_000n);
  } else {
    // A token account for each winner who has none yet.
    lamports += BigInt(winners.length) * 1_600_000n;
  }
  if (auction.liquidity === "planned") lamports += 60_000_000n;
  // Round up to 0.005 SOL.
  const step = 5_000_000n;
  return ((lamports + step - 1n) / step) * step;
}

function signerFor(key: Keypair): WalletSigner {
  return {
    publicKey: key.publicKey,
    async signTransaction(tx) {
      tx.partialSign(key);
      return tx;
    },
    async signTransactions(txs) {
      for (const tx of txs) tx.partialSign(key);
      return txs;
    },
  };
}

const memo = (owner: PublicKey) =>
  new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(`veiling:helper:${owner.toBase58()}`) });

interface Saved {
  secret: number[];
  owner: string;
}

function save(key: Keypair, owner: PublicKey) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ secret: Array.from(key.secretKey), owner: owner.toBase58() } satisfies Saved));
  } catch {
    // Without storage, the run still returns what is left when it ends.
  }
}

function forget() {
  try {
    localStorage.removeItem(STORE);
  } catch {
    // Nothing to forget.
  }
}

/** Sends everything in the session wallet back to its owner. Returns lamports sent. */
async function sweep(key: Keypair, owner: PublicKey): Promise<bigint> {
  const balance = await connection.getBalance(key.publicKey, "confirmed");
  if (balance <= FEE) return 0n;
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: owner, lamports: balance - FEE })
  );
  await sendTransaction(tx, signerFor(key));
  return BigInt(balance - FEE);
}

/**
 * A session left by a run that was cut off (a closed tab, say): sends what is
 * in it back to its owner. Returns lamports sent.
 */
export async function returnLeftovers(): Promise<bigint> {
  let saved: Saved | null = null;
  try {
    const raw = localStorage.getItem(STORE);
    saved = raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return 0n;
  }
  if (!saved) return 0n;
  const key = Keypair.fromSecretKey(Uint8Array.from(saved.secret));
  const sent = await sweep(key, new PublicKey(saved.owner));
  forget();
  return sent;
}

export interface FinishResult {
  steps: number;
  returned: bigint;
  stoppedEarly: boolean;
}

/**
 * Funds a session wallet from `wallet` (one approval), runs every step the
 * sale needs, then returns what is left. `progress` gets a short line for
 * each step; `stop()` returning true ends the run after the current step.
 */
export async function finishSale(
  address: PublicKey,
  wallet: WalletSigner,
  progress: (line: string) => void,
  stop: () => boolean
): Promise<FinishResult> {
  // Anything left from an earlier run goes home first.
  await returnLeftovers().catch(() => 0n);
  const first = await fetchAuction(address);
  if (!first) throw new Error("This sale no longer exists.");
  const budget = sessionBudget(first, await fetchBidsForAuction(address));
  const key = Keypair.generate();
  save(key, wallet.publicKey);
  progress(`Adding ${formatSol(budget)} SOL for network fees…`);
  await sendTransaction(
    new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: key.publicKey, lamports: budget })),
    wallet
  );
  const session = signerFor(key);
  const tagged = (tx: Transaction) => tx.add(memo(wallet.publicKey));

  let steps = 0;
  let stoppedEarly = false;
  let last = "";
  let repeats = 0;
  let returned = 0n;
  try {
    for (;;) {
      if (stop()) {
        stoppedEarly = true;
        break;
      }
      const auction = await fetchAuction(address);
      if (!auction) break;
      const bids = await fetchBidsForAuction(address);
      const now = nowSecs();
      const step = await nextStep(auction, bids, now);
      if (step.kind === "done") break;
      // The same step over and over means it cannot go through right now.
      const id = `${step.kind}:${"bid" in step ? step.bid.address.toBase58() : ""}:${auction.checkedCount}:${auction.resolvedCount}`;
      repeats = id === last ? repeats + 1 : 0;
      last = id;
      if (repeats >= 3) throw new Error("A step keeps failing. Try again in a few minutes.");

      switch (step.kind) {
        case "wait":
          progress(`${step.text}…`);
          await waitUntil(
            () => fetchAuction(address),
            (a) => !a || !hasPending(a.pendingComputation, a.pendingSince, nowSecs(), PENDING_TIMEOUT_SECS),
            240_000
          );
          continue;
        case "check": {
          const { tx, count } = await buildCheckBatch(key.publicKey, auction, bids);
          progress(`Checking bids ${auction.checkedCount + 1} to ${auction.checkedCount + count} of ${auction.bidCount}…`);
          await sendTransaction(tagged(tx), session);
          await waitUntil(
            () => fetchAuction(address),
            (a) => !a || a.checkedCount > auction.checkedCount || a.pendingComputation.equals(PublicKey.default)
          );
          break;
        }
        case "clear":
          progress("Finding the final price…");
          await sendTransaction(tagged(await buildFindClearing(key.publicKey, auction)), session);
          await waitUntil(
            () => fetchAuction(address),
            (a) => !a || a.status !== "open" || a.pendingComputation.equals(PublicKey.default)
          );
          break;
        case "refund":
          progress(`Refunding bid ${step.bid.index + 1}…`);
          await sendTransaction(await buildRefundFailedBid(key.publicKey, step.bid), session);
          break;
        case "settle":
          progress(`Working out bid ${step.bid.index + 1} of ${auction.bidCount}…`);
          await sendTransaction(tagged(await buildSettle(key.publicKey, auction, step.bid, bids)), session);
          await waitUntil(
            () => fetchBid(step.bid.address),
            (b) => !b || b.status !== "sealed" || b.pendingComputation.equals(PublicKey.default)
          );
          break;
        case "split":
          progress("Splitting the shares at the final price…");
          for (const tx of await buildFinalizeShares(auction, step.bids)) await sendTransaction(tx, session);
          break;
        case "graduate":
          progress("Making the token…");
          await sendTransaction(await buildGraduateLaunch(key.publicKey, auction), session);
          break;
        case "pool": {
          progress("Opening the trading pool…");
          const { tx, signers } = await buildBootstrapLiquidity(key.publicKey, auction);
          await sendTransaction(tx, session, signers);
          break;
        }
        case "shuffle":
          progress("Drawing who gets which NFT…");
          await sendTransaction(tagged(await buildDrawSeed(key.publicKey, auction)), session);
          await waitUntil(
            () => fetchAuction(address),
            (a) => !a || a.seedDrawn || a.pendingComputation.equals(PublicKey.default)
          );
          break;
        case "deliver": {
          progress(`Sending out bid ${step.bid.index + 1}…`);
          const latest = await fetchBid(step.bid.address);
          if (latest) {
            for (const tx of await buildCollect(key.publicKey, auction, latest, nowSecs())) await sendTransaction(tx, session);
          }
          break;
        }
      }
      steps++;
    }
  } finally {
    // On success or failure alike, what is left goes back.
    progress("Returning what is left to your wallet…");
    try {
      returned = await sweep(key, wallet.publicKey);
      forget();
    } catch {
      // Kept in storage: the next visit returns it (returnLeftovers).
    }
  }
  return { steps, returned, stoppedEarly };
}
