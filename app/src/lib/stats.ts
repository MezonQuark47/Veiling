import { STATS_URL } from "../config";

/** What the keeper serves at STATS_URL (scripts/lib/stats.ts writes it). */
export interface StatsSnapshot {
  updatedAt: number;
  network: string;
  points: { perSolBought: number; perSolRaised: number; perBid: number; bidsPerSale: number; perStep: number };
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
