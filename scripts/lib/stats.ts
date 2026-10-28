/**
 * All-time totals and points, read from the program's transaction history.
 *
 * Sales and bids close their accounts when they finish, so the chain's
 * current state forgets them. Their transactions stay: this reads every
 * transaction that touched the program, oldest first, picks out the events
 * the program logs (`AuctionCreated`, `BidPlaced`, `BidSettled`,
 * `CrankPaid`, ...) and adds them up. It keeps its place in a state file, so
 * each run only reads what is new.
 *
 * Points, per wallet:
 *   - buying:   100 per SOL paid at a sale's final price
 *   - selling:   50 per SOL a sale of yours raised
 *   - bidding:    5 per bid, at most 3 bids per sale counted
 *   - helping:    5 per finishing step you ran (from the site's "Finish the
 *                 sale" button or your own crank); the platform's own keeper
 *                 wallets earn none
 * Points have no cash value; the rules can change.
 */
import { BorshCoder, EventParser } from "@anchor-lang/core";
import { Connection, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export const POINTS = { perSolBought: 100, perSolRaised: 50, perBid: 5, bidsPerSale: 3, perStep: 5 };

const LAMPORTS = 1e9;
/** The site's "Finish the sale" sessions name the wallet that funded them. */
const HELPER_MEMO = /Memo \(len \d+\): "veiling:helper:([1-9A-HJ-NP-Za-km-z]{32,44})"/;

interface WalletRow {
  /** Lamports paid for what this wallet won. */
  paid: number;
  /** Lamports this wallet's sales raised. */
  raised: number;
  bids: number;
  /** Bids that count for points (at most `bidsPerSale` per sale). */
  countedBids: number;
  steps: number;
  sales: number;
  firstSeen: number;
}

interface SaleRow {
  seller: string;
  kind: string;
  createdAt: number;
  raised: number;
  bids: number;
  bidders: Record<string, number>;
  graduated: boolean;
}

interface DayRow {
  sales: number;
  bids: number;
  volume: number;
  newUsers: number;
}

export interface StatsState {
  version: 1;
  programId: string;
  /** The newest transaction already read. */
  newest: string | null;
  transactions: number;
  wallets: Record<string, WalletRow>;
  sales: Record<string, SaleRow>;
  /** A "Finish the sale" session key, and the wallet it works for. */
  helpers: Record<string, string>;
  days: Record<string, DayRow>;
  deposited: number;
}

export interface StatsSnapshot {
  updatedAt: number;
  network: string;
  points: typeof POINTS;
  totals: {
    sales: number;
    newTokens: number;
    tokensMade: number;
    collections: number;
    bids: number;
    users: number;
    bidders: number;
    sellers: number;
    volumeSol: number;
    depositedSol: number;
    stepsRun: number;
  };
  /** Per UTC day, oldest first; `users` is the running total. */
  days: { day: string; sales: number; bids: number; volumeSol: number; newUsers: number; users: number }[];
  /** The top wallets by points. */
  leaderboard: WalletPoints[];
  /** Every wallet's points, for "your points": [points, bought SOL, raised SOL, bids, steps]. */
  wallets: Record<string, [number, number, number, number, number]>;
}

export interface WalletPoints {
  wallet: string;
  points: number;
  boughtSol: number;
  raisedSol: number;
  bids: number;
  steps: number;
}

const emptyState = (programId: PublicKey): StatsState => ({
  version: 1,
  programId: programId.toBase58(),
  newest: null,
  transactions: 0,
  wallets: {},
  sales: {},
  helpers: {},
  days: {},
  deposited: 0,
});

export function loadState(path: string, programId: PublicKey): StatsState {
  if (!existsSync(path)) return emptyState(programId);
  const state = JSON.parse(readFileSync(path, "utf8")) as StatsState;
  // A new program (or a redeploy at a new address) starts over.
  return state.programId === programId.toBase58() ? state : emptyState(programId);
}

function saveJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

export const saveState = saveJson;

/** An event field, whichever case the coder used for it. */
function field(data: any, name: string): any {
  if (name in data) return data[name];
  const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return data[camel];
}

const str = (v: any) => (v && typeof v.toBase58 === "function" ? v.toBase58() : String(v));
const num = (v: any) => (v && typeof v.toNumber === "function" ? Number(v.toString()) : Number(v ?? 0));
/** An enum variant, as "token", "launch" or "collection". */
const kindOf = (v: any) => (v && typeof v === "object" ? Object.keys(v)[0] : String(v)).toLowerCase();
const dayOf = (unixSecs: number) => new Date(unixSecs * 1000).toISOString().slice(0, 10);

/**
 * Reads every transaction since the last run into `state`. Returns how many
 * were read. `log` reports progress on long first runs.
 */
export async function indexHistory(
  connection: Connection,
  programId: PublicKey,
  idl: any,
  state: StatsState,
  log: (line: string) => void = () => {},
  checkpoint: () => void = () => {}
): Promise<number> {
  // Newest first, page by page, back to where the last run stopped.
  const fresh: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(
      programId,
      { before, until: state.newest ?? undefined, limit: 1000 },
      "confirmed"
    );
    fresh.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
    if (fresh.length % 5000 === 0) log(`stats: ${fresh.length} transactions found so far...`);
  }
  if (fresh.length === 0) return 0;
  fresh.reverse();
  if (fresh.length > 200) log(`stats: reading ${fresh.length} transactions...`);

  const parser = new EventParser(programId, new BorshCoder(idl));
  const seen = (wallet: string, at: number) => {
    let row = state.wallets[wallet];
    if (!row) {
      row = state.wallets[wallet] = { paid: 0, raised: 0, bids: 0, countedBids: 0, steps: 0, sales: 0, firstSeen: at };
    }
    return row;
  };
  const day = (at: number) => (state.days[dayOf(at)] ??= { sales: 0, bids: 0, volume: 0, newUsers: 0 });
  // A wallet counts as a user once it bids or opens a sale.
  const user = (wallet: string, at: number) => {
    const isNew = !state.wallets[wallet] || (state.wallets[wallet].bids === 0 && state.wallets[wallet].sales === 0);
    const row = seen(wallet, at);
    if (isNew) {
      row.firstSeen = at;
      day(at).newUsers++;
    }
    return row;
  };

  const AT_ONCE = 4;
  for (let i = 0; i < fresh.length; i += AT_ONCE) {
    const chunk = fresh.slice(i, i + AT_ONCE);
    const txs = await Promise.all(
      chunk.map((s) =>
        connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      )
    );
    for (let k = 0; k < chunk.length; k++) {
      const info = chunk[k];
      const tx = txs[k];
      state.newest = info.signature;
      state.transactions++;
      if (!tx || tx.meta?.err || !tx.meta?.logMessages) continue;
      const at = tx.blockTime ?? info.blockTime ?? Math.floor(Date.now() / 1000);
      const logs = tx.meta.logMessages;
      // A session key's memo says which wallet it works for.
      const feePayer = tx.transaction.message.staticAccountKeys[0]?.toBase58();
      for (const line of logs) {
        const m = HELPER_MEMO.exec(line);
        if (m && feePayer && m[1] !== feePayer) state.helpers[feePayer] = m[1];
      }
      let events: { name: string; data: any }[] = [];
      try {
        events = [...parser.parseLogs(logs)];
      } catch {
        events = [];
      }
      for (const { name, data } of events) {
        const auction = str(field(data, "auction"));
        switch (name) {
          case "AuctionCreated": {
            const seller = str(field(data, "seller"));
            state.sales[auction] = {
              seller,
              kind: kindOf(field(data, "kind")),
              createdAt: at,
              raised: 0,
              bids: 0,
              bidders: {},
              graduated: false,
            };
            user(seller, at).sales++;
            day(at).sales++;
            break;
          }
          case "BidPlaced": {
            const bidder = str(field(data, "bidder"));
            const row = user(bidder, at);
            row.bids++;
            const sale = state.sales[auction];
            if (sale) {
              sale.bids++;
              sale.bidders[bidder] = (sale.bidders[bidder] ?? 0) + 1;
              if (sale.bidders[bidder] <= POINTS.bidsPerSale) row.countedBids++;
            } else {
              row.countedBids++;
            }
            const deposit = num(field(data, "deposit"));
            state.deposited += deposit;
            day(at).bids++;
            break;
          }
          case "BidSettled": {
            const payment = num(field(data, "payment"));
            if (payment <= 0) break;
            seen(str(field(data, "bidder")), at).paid += payment;
            const sale = state.sales[auction];
            if (sale) {
              sale.raised += payment;
              seen(sale.seller, at).raised += payment;
            }
            day(at).volume += payment;
            break;
          }
          case "CrankPaid": {
            const cranker = str(field(data, "cranker"));
            seen(state.helpers[cranker] ?? cranker, at).steps++;
            break;
          }
          case "LaunchGraduated": {
            const sale = state.sales[auction];
            if (sale) sale.graduated = true;
            break;
          }
        }
      }
    }
    // A long first run keeps its place as it goes.
    if ((i / AT_ONCE) % 125 === 124) {
      checkpoint();
      log(`stats: ${i + chunk.length} of ${fresh.length} read`);
    }
  }
  return fresh.length;
}

export function pointsOf(row: WalletRow): number {
  return Math.round(
    (row.paid / LAMPORTS) * POINTS.perSolBought +
      (row.raised / LAMPORTS) * POINTS.perSolRaised +
      row.countedBids * POINTS.perBid +
      row.steps * POINTS.perStep
  );
}

const sol = (lamports: number) => Math.round((lamports / LAMPORTS) * 1e4) / 1e4;

/** What the site shows: totals, a day-by-day history and the points. */
export function snapshot(state: StatsState, network: string, exclude: Set<string>): StatsSnapshot {
  const sales = Object.values(state.sales);
  const rows = Object.entries(state.wallets);
  const users = rows.filter(([, r]) => r.bids > 0 || r.sales > 0);
  const all: WalletPoints[] = rows
    .filter(([wallet]) => !exclude.has(wallet))
    .map(([wallet, r]) => ({
      wallet,
      points: pointsOf(r),
      boughtSol: sol(r.paid),
      raisedSol: sol(r.raised),
      bids: r.bids,
      steps: r.steps,
    }))
    .filter((w) => w.points > 0)
    .sort((a, b) => b.points - a.points || b.boughtSol - a.boughtSol);
  let running = 0;
  const days = Object.keys(state.days)
    .sort()
    .map((day) => {
      const d = state.days[day];
      running += d.newUsers;
      return { day, sales: d.sales, bids: d.bids, volumeSol: sol(d.volume), newUsers: d.newUsers, users: running };
    });
  return {
    updatedAt: Math.floor(Date.now() / 1000),
    network,
    points: POINTS,
    totals: {
      sales: sales.length,
      newTokens: sales.filter((s) => s.kind.toLowerCase() === "launch").length,
      tokensMade: sales.filter((s) => s.graduated).length,
      collections: sales.filter((s) => s.kind.toLowerCase() === "collection").length,
      bids: sales.reduce((n, s) => n + s.bids, 0),
      users: users.length,
      bidders: users.filter(([, r]) => r.bids > 0).length,
      sellers: users.filter(([, r]) => r.sales > 0).length,
      volumeSol: sol(sales.reduce((n, s) => n + s.raised, 0)),
      depositedSol: sol(state.deposited),
      stepsRun: rows.reduce((n, [, r]) => n + r.steps, 0),
    },
    days,
    leaderboard: all.slice(0, 100),
    wallets: Object.fromEntries(all.map((w) => [w.wallet, [w.points, w.boughtSol, w.raisedSol, w.bids, w.steps]])),
  };
}

export const saveSnapshot = saveJson;
