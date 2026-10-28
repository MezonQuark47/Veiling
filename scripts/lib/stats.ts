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
  /** Every sale this wallet bid in, by sale address. */
  joined: Record<string, Part>;
}

/** One wallet's part in one sale. */
interface Part {
  bids: number;
  /** Each bid's whole deposit, by bid address. */
  deposits: Record<string, number>;
  /** Lamports paid at the final price. */
  paid: number;
  /** Base units or NFTs won. */
  won: number;
  /** Lamports that came back: unused deposits and refunds. */
  refunded: number;
  /** Bids worked out so far. */
  settled: number;
  firstAt: number;
  lastAt: number;
}

interface SaleRow {
  seller: string;
  kind: string;
  mint: string;
  createdAt: number;
  endTime: number;
  raised: number;
  bids: number;
  bidders: Record<string, number>;
  graduated: boolean;
  /** A new token's name and symbol, from `LaunchOpened`. */
  name?: string;
  symbol?: string;
  /** The final price was found (`AuctionCleared`). */
  cleared?: boolean;
  /** The sale missed its target, so every bid was refunded. */
  failed?: boolean;
  cancelled?: boolean;
}

interface DayRow {
  sales: number;
  bids: number;
  volume: number;
  newUsers: number;
}

export interface StatsState {
  version: 2;
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
  version: 2,
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
  // So does an older state file, which lacks what newer versions keep.
  return state.programId === programId.toBase58() && state.version === 2 ? state : emptyState(programId);
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
      row = state.wallets[wallet] = {
        paid: 0,
        raised: 0,
        bids: 0,
        countedBids: 0,
        steps: 0,
        sales: 0,
        firstSeen: at,
        joined: {},
      };
    }
    return row;
  };
  const part = (wallet: string, auction: string, at: number) => {
    const row = seen(wallet, at);
    const p = (row.joined[auction] ??= {
      bids: 0,
      deposits: {},
      paid: 0,
      won: 0,
      refunded: 0,
      settled: 0,
      firstAt: at,
      lastAt: at,
    });
    p.lastAt = at;
    return p;
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
              mint: str(field(data, "mint")),
              createdAt: at,
              endTime: num(field(data, "end_time")),
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
            const mine = part(bidder, auction, at);
            mine.bids++;
            mine.deposits[str(field(data, "bid"))] = deposit;
            day(at).bids++;
            break;
          }
          case "BidIncreased": {
            const mine = part(str(field(data, "bidder")), auction, at);
            const bid = str(field(data, "bid"));
            const deposit = num(field(data, "deposit"));
            state.deposited += Math.max(0, deposit - (mine.deposits[bid] ?? 0));
            mine.deposits[bid] = deposit;
            break;
          }
          case "BidSettled": {
            const payment = num(field(data, "payment"));
            const mine = part(str(field(data, "bidder")), auction, at);
            mine.settled++;
            mine.won += num(field(data, "won"));
            mine.paid += payment;
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
          case "LaunchOpened": {
            const sale = state.sales[auction];
            if (sale) {
              sale.kind = "launch";
              sale.mint = str(field(data, "mint"));
              sale.name = String(field(data, "name") ?? "");
              sale.symbol = String(field(data, "symbol") ?? "");
            }
            break;
          }
          case "AuctionCleared": {
            const sale = state.sales[auction];
            if (sale) sale.cleared = true;
            break;
          }
          case "MinimumRaiseMissed": {
            const sale = state.sales[auction];
            if (sale) sale.failed = true;
            break;
          }
          case "AuctionCancelled": {
            const sale = state.sales[auction];
            if (sale) sale.cancelled = true;
            break;
          }
          // What came back to a bidder: unused deposit, a refund, or a bid pushed out.
          case "BidClosed":
          case "BidRefunded":
          case "BidEvicted": {
            const amount = num(field(data, name === "BidClosed" ? "refund" : name === "BidEvicted" ? "refund" : "amount"));
            part(str(field(data, "bidder")), auction, at).refunded += amount;
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

/** One wallet's own history, for its dashboard. Amounts in lamports and base units, as strings. */
export interface WalletView {
  wallet: string;
  updatedAt: number;
  points: number;
  /** Place on the leaderboard (1 is first), or null without points. */
  rank: number | null;
  totals: {
    bids: number;
    salesJoined: number;
    salesWon: number;
    paid: string;
    deposited: string;
    refunded: string;
    salesLaunched: number;
    raised: string;
    steps: number;
  };
  joined: {
    auction: string;
    kind: string;
    mint: string;
    name: string | null;
    symbol: string | null;
    at: number;
    endTime: number;
    bids: number;
    deposited: string;
    paid: string;
    won: string;
    refunded: string;
    /** won, not won, refunded (the sale did not go ahead), cancelled, or open. */
    result: "won" | "lost" | "refunded" | "cancelled" | "open";
  }[];
  launched: {
    auction: string;
    kind: string;
    mint: string;
    name: string | null;
    symbol: string | null;
    at: number;
    endTime: number;
    bids: number;
    bidders: number;
    raised: string;
    /** sold, token made, missed its target, cancelled, or open. */
    result: "sold" | "made" | "failed" | "cancelled" | "open";
  }[];
}

export function walletView(state: StatsState, wallet: string, latest: StatsSnapshot | null): WalletView | null {
  const row = state.wallets[wallet];
  const launchedSales = Object.entries(state.sales).filter(([, s]) => s.seller === wallet);
  if (!row && launchedSales.length === 0) return null;
  const parts = Object.entries(row?.joined ?? {});
  const sum = (f: (p: Part) => number) => parts.reduce((n, [, p]) => n + f(p), 0);
  const deposited = (p: Part) => Object.values(p.deposits).reduce((n, d) => n + d, 0);
  const points = latest?.wallets[wallet]?.[0] ?? (row ? pointsOf(row) : 0);
  const rank =
    latest && latest.wallets[wallet]
      ? Object.values(latest.wallets).filter(([p]) => p > latest.wallets[wallet][0]).length + 1
      : null;
  return {
    wallet,
    updatedAt: Math.floor(Date.now() / 1000),
    points,
    rank,
    totals: {
      bids: row?.bids ?? 0,
      salesJoined: parts.length,
      salesWon: parts.filter(([, p]) => p.paid > 0).length,
      paid: String(sum((p) => p.paid)),
      deposited: String(sum(deposited)),
      refunded: String(sum((p) => p.refunded)),
      salesLaunched: launchedSales.length,
      raised: String(row?.raised ?? 0),
      steps: row?.steps ?? 0,
    },
    joined: parts
      .map(([auction, p]) => {
        const sale = state.sales[auction];
        const result: WalletView["joined"][number]["result"] = sale?.cancelled
          ? "cancelled"
          : sale?.failed
            ? "refunded"
            : p.paid > 0 || p.won > 0
              ? "won"
              : p.settled > 0 || (sale?.cleared && p.refunded > 0)
                ? "lost"
                : "open";
        return {
          auction,
          kind: sale?.kind ?? "token",
          mint: sale?.mint ?? "",
          name: sale?.name || null,
          symbol: sale?.symbol || null,
          at: p.firstAt,
          endTime: sale?.endTime ?? 0,
          bids: p.bids,
          deposited: String(deposited(p)),
          paid: String(p.paid),
          won: String(p.won),
          refunded: String(p.refunded),
          result,
        };
      })
      .sort((a, b) => b.at - a.at),
    launched: launchedSales
      .map(([auction, s]) => ({
        auction,
        kind: s.kind,
        mint: s.mint,
        name: s.name || null,
        symbol: s.symbol || null,
        at: s.createdAt,
        endTime: s.endTime,
        bids: s.bids,
        bidders: Object.keys(s.bidders).length,
        raised: String(s.raised),
        result: (s.cancelled
          ? "cancelled"
          : s.failed
            ? "failed"
            : s.graduated
              ? "made"
              : s.raised > 0
                ? "sold"
                : "open") as WalletView["launched"][number]["result"],
      }))
      .sort((a, b) => b.at - a.at),
  };
}
