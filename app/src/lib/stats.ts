import { STATS_URL } from "../config";

/** What the keeper serves at STATS_URL (scripts/lib/stats.ts writes it). */
export interface StatsSnapshot {
  updatedAt: number;
  network: string;
  points: {
    perSolBought: number;
    perSolRaised: number;
    perBid: number;
    bidsPerSale: number;
    perStep: number;
    /** Added with invites; an older keeper leaves them out. */
    perInvite?: number;
    inviteShare?: number;
  };
  /** The running season's own leaderboard (Season 0 on devnet), or null. */
  season?: {
    name: string;
    start: number;
    end: number;
    players: number;
    leaderboard: WalletPoints[];
    wallets: Record<string, number>;
  } | null;
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
  days: { day: string; sales: number; bids: number; volumeSol: number; newUsers: number; users: number }[];
  leaderboard: WalletPoints[];
  /** wallet: [points, bought SOL, raised SOL, bids, steps] */
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

const MOCK = import.meta.env.DEV && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("mock");

/** All-time totals and points, or null when the site has no stats address. */
export async function fetchStats(): Promise<StatsSnapshot | null> {
  if (MOCK) return (await import("./mock")).mockStats();
  if (!STATS_URL) return null;
  const res = await fetch(STATS_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error("The totals could not be loaded right now.");
  return (await res.json()) as StatsSnapshot;
}

/** A wallet's place on the leaderboard (1 is first), or null without points. */
export function rankOf(stats: StatsSnapshot, wallet: string): number | null {
  const mine = stats.wallets[wallet];
  if (!mine) return null;
  return Object.values(stats.wallets).filter(([points]) => points > mine[0]).length + 1;
}

/** One wallet's own history (scripts/lib/stats.ts, walletView). Amounts are lamports or base units, as strings. */
export interface WalletView {
  wallet: string;
  updatedAt: number;
  points: number;
  rank: number | null;
  season?: { name: string; points: number; rank: number | null } | null;
  invites?: { joined: number; active: number; points: number };
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
  joined: JoinedSale[];
  launched: LaunchedSale[];
}

export interface SaleRef {
  auction: string;
  kind: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  at: number;
  endTime: number;
}

export interface JoinedSale extends SaleRef {
  bids: number;
  deposited: string;
  paid: string;
  won: string;
  refunded: string;
  result: "won" | "lost" | "refunded" | "cancelled" | "open";
}

export interface LaunchedSale extends SaleRef {
  bids: number;
  bidders: number;
  raised: string;
  result: "sold" | "made" | "failed" | "cancelled" | "open";
}

/** A wallet's own history, or null when the site has no stats address or the wallet has none. */
export async function fetchWalletView(wallet: string): Promise<WalletView | null> {
  if (MOCK) return (await import("./mock")).mockWalletView(wallet);
  if (!STATS_URL) return null;
  const url = STATS_URL.replace(/stats\.json(\?.*)?$/, `wallet/${wallet}.json`);
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("Your history could not be loaded right now.");
  return (await res.json()) as WalletView | null;
}
