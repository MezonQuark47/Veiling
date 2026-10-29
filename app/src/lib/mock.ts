// Sample data for design previews in development (`?mock` in the URL).
// Production builds drop this file entirely.
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MPL_CORE_ID } from "../config";
import type { Auction, Bid, CollectionInfo, CollectionMetadata, ItemList, LiquidityPlan, NftMetadata, TokenInfo } from "./chain";
import { type ListedItem, entriesOf, itemIndexOf, itemNftName } from "./items";

const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
const now = () => Math.floor(Date.now() / 1000);
const TOKEN = 1_000_000_000n; // 9 decimals

// Token prices are lamports per 10^6 base units (a thousandth of a token):
// 25_000 ticks = 0.025 SOL per token.
const base = (seed: number, overrides: Partial<Auction>): Auction => ({
  address: key(seed),
  kind: "token",
  seed: new BN(seed),
  seller: key(100 + seed),
  mint: key(200 + seed),
  tokenProgram: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
  supply: 500_000n * TOKEN,
  priceUnit: 1_000_000n,
  priceScale: 1n,
  minPrice: 25_000n,
  minDeposit: 50_000_000n,
  maxPerBid: 0,
  startTime: now() - 3600,
  endTime: now() + 7_980,
  status: "open",
  featured: false,
  hidden: false,
  bidCount: 0,
  checkedCount: 0,
  resolvedCount: 0,
  liveBids: 0,
  pendingComputation: PublicKey.default,
  pendingSince: 0,
  clearingPrice: 25_000n,
  filled: false,
  weightAbove: 0n,
  weightAt: 0n,
  atRevealed: 0n,
  sold: 0n,
  delivered: 0n,
  proceeds: 0n,
  totalDeposited: 0n,
  saleFeeBps: 100,
  treasury: key(250),
  royaltyBps: 0,
  uriPerItem: false,
  itemName: "",
  itemUri: "",
  assignedPositions: 0,
  nftSeed: 0n,
  seedDrawn: false,
  namedItems: false,
  unrevealed: false,
  crankRewards: { checkBatch: 6_000_000n, clearing: 25_000_000n, settlement: 4_600_000n, seedDraw: 3_000_000n },
  crankPool: 31_000_000n,
  extraPages: 0,
  liquidity: "none",
  liquidityFloor: 0n,
  extendedSecs: 0,
  prepaidPages: 0,
  minRaise: 0n,
  walletCap: 0n,
  allowlist: false,
  raiseMissed: false,
  launch: false,
  ...overrides,
});

/** A plan for the mock sales that have one: 30% of the net proceeds, at least 5 SOL, a 1% pool. */
export function mockLiquidityPlan(auction: Auction): LiquidityPlan {
  const pooled = auction.liquidity === "pooled";
  return {
    address: key(240),
    auction: auction.address,
    seller: auction.seller,
    treasury: auction.treasury,
    mint: auction.mint,
    tokenProgram: auction.tokenProgram,
    lpBps: auction.launch ? 10_000 : 3_000,
    floor: auction.liquidityFloor,
    tradeFeeBps: 100,
    reserve: auction.supply,
    poolSol: pooled ? 8_910_000_000n : 0n,
    poolTokens: pooled ? 297_000n * TOKEN : 0n,
    pool: pooled ? key(241) : PublicKey.default,
    position: pooled ? key(242) : PublicKey.default,
    positionNftMint: pooled ? key(243) : PublicKey.default,
    feesToSeller: pooled ? 412_000_000n : 0n,
    feesToPlatform: pooled ? 103_000_000n : 0n,
  };
}

export function mockAuctions(): Auction[] {
  // `?mock&nofeature` previews the front page without a featured auction.
  const featured = !new URLSearchParams(window.location.search).has("nofeature");
  return [
    // A fair launch: a billion LNTN made with the sale, half sold, a 10 SOL
    // target (20 lamports a token), 1 hour.
    base(11, {
      launch: true,
      supply: 500_000_000_000_000n,
      priceUnit: 1_000_000_000n,
      minPrice: 20_000n,
      minDeposit: 100_000_000n,
      minRaise: 10_000_000_000n,
      startTime: now() - 1_500,
      endTime: now() + 2_100,
      bidCount: 214,
      liveBids: 214,
      totalDeposited: 7_400_000_000n,
      liquidity: "planned",
      liquidityFloor: 1n,
    }),
    // A new token that missed its target: every bid is being refunded.
    base(12, {
      launch: true,
      supply: 500_000_000_000_000n,
      priceUnit: 1_000_000_000n,
      minPrice: 20_000n,
      minDeposit: 100_000_000n,
      minRaise: 10_000_000_000n,
      startTime: now() - 7_200,
      endTime: now() - 3_600,
      status: "settling",
      bidCount: 6,
      checkedCount: 6,
      resolvedCount: 2,
      liveBids: 4,
      clearingPrice: 20_000n,
      raiseMissed: true,
      totalDeposited: 2_100_000_000n,
      liquidity: "failed",
      liquidityFloor: 1n,
    }),
    // A new token that sold out: settled, its token still to be made.
    base(13, {
      launch: true,
      supply: 500_000_000_000_000n,
      priceUnit: 1_000_000_000n,
      minPrice: 20_000n,
      minDeposit: 100_000_000n,
      minRaise: 10_000_000_000n,
      startTime: now() - 7_200,
      endTime: now() - 3_600,
      status: "settling",
      bidCount: 6,
      checkedCount: 6,
      resolvedCount: 6,
      liveBids: 6,
      clearingPrice: 22_000n,
      filled: true,
      weightAbove: 11_000_000_000n,
      sold: 500_000_000_000_000n,
      proceeds: 11_000_000_000n,
      totalDeposited: 11_000_000_000n,
      liquidity: "planned",
      liquidityFloor: 1n,
    }),
    base(1, {
      featured,
      bidCount: 37,
      liveBids: 37,
      totalDeposited: 41_250_000_000n,
      liquidity: "planned",
      liquidityFloor: 5_000_000_000n,
    }),
    base(6, {
      kind: "collection",
      tokenProgram: MPL_CORE_ID,
      mint: key(206),
      supply: 333n,
      priceUnit: 1n,
      priceScale: 1_000n,
      minPrice: 400_000n,
      minDeposit: 400_000_000n,
      maxPerBid: 5,
      endTime: now() + 50_000,
      bidCount: 58,
      liveBids: 58,
      totalDeposited: 96_400_000_000n,
      royaltyBps: 500,
      uriPerItem: true,
      itemName: "Delft Tile",
      itemUri: "https://example.com/tiles/",
    }),
    base(7, {
      kind: "collection",
      tokenProgram: MPL_CORE_ID,
      mint: key(207),
      supply: 48n,
      priceUnit: 1n,
      priceScale: 1_000n,
      minPrice: 250_000n,
      minDeposit: 250_000_000n,
      maxPerBid: 3,
      endTime: now() + 30_000,
      bidCount: 21,
      liveBids: 21,
      totalDeposited: 14_750_000_000n,
      royaltyBps: 500,
      uriPerItem: true,
      itemName: "Veiled Tulip",
      itemUri: `https://arweave.net/${"V".repeat(43)}/`,
      unrevealed: true,
    }),
    base(8, {
      kind: "collection",
      tokenProgram: MPL_CORE_ID,
      mint: key(208),
      supply: BigInt(STUDIO_ITEMS.reduce((sum, item) => sum + item.supply, 0)),
      priceUnit: 1n,
      priceScale: 1_000n,
      minPrice: 1_000_000n,
      minDeposit: 1_000_000_000n,
      maxPerBid: 2,
      endTime: now() + 64_000,
      bidCount: 9,
      liveBids: 9,
      totalDeposited: 23_500_000_000n,
      royaltyBps: 750,
      uriPerItem: true,
      itemName: "Delft Studio",
      itemUri: "https://example.com/studio/",
      namedItems: true,
    }),
    base(2, {
      supply: 10_000n * TOKEN,
      minPrice: 1_500n,
      minDeposit: 1_000_000n,
      endTime: now() + 300,
      // Two pages of bids, every place taken.
      extraPages: 1,
      bidCount: 512,
      liveBids: 512,
      totalDeposited: 3_900_000_000n,
    }),
    // Scheduled: bidding opens tomorrow.
    base(9, {
      mint: key(203),
      supply: 2_000_000n * TOKEN,
      minPrice: 10_000n,
      startTime: now() + 93_600,
      endTime: now() + 93_600 + 259_200,
    }),
    base(3, { endTime: now() - 600, bidCount: 23, checkedCount: 12, liveBids: 23, totalDeposited: 18_000_000_000n }),
    // Every bid checked across three pages: the price is found a page at a time.
    base(10, {
      mint: key(204),
      endTime: now() - 1_800,
      extraPages: 2,
      bidCount: 700,
      checkedCount: 700,
      liveBids: 700,
      totalDeposited: 912_000_000_000n,
    }),
    base(4, {
      status: "settling",
      endTime: now() - 7200,
      bidCount: 18,
      checkedCount: 18,
      resolvedCount: 7,
      liveBids: 18,
      clearingPrice: 41_250n,
      filled: true,
      weightAbove: 14_000_000_000_000n,
      weightAt: 9_000_000_000_000n,
      sold: 260_000n * TOKEN,
      delivered: 40_000n * TOKEN,
      proceeds: 10_725_000_000_000n,
      totalDeposited: 26_000_000_000_000n,
    }),
    base(5, {
      status: "finished",
      endTime: now() - 86_400 * 2,
      bidCount: 64,
      checkedCount: 64,
      resolvedCount: 64,
      liveBids: 0,
      clearingPrice: 80_000n,
      filled: true,
      weightAbove: 30_000_000_000_000n,
      weightAt: 12_000_000_000_000n,
      sold: 500_000n * TOKEN,
      delivered: 500_000n * TOKEN,
      proceeds: 40_000_000_000_000n,
      totalDeposited: 77_000_000_000_000n,
      liquidity: "pooled",
      liquidityFloor: 5_000_000_000n,
    }),
  ];
}

export function mockBids(auction: PublicKey, owner: PublicKey | null): Bid[] {
  return Array.from({ length: 6 }, (_, i) => ({
    address: key(50 + i),
    auction,
    bidder: i === 2 && owner ? owner : key(60 + i),
    index: i,
    deposit: BigInt(1_000_000_000 + i * 250_000_000),
    status: i < 2 ? "settled" : "sealed",
    pendingComputation: PublicKey.default,
    pendingSince: 0,
    outcome: i < 2 ? 1 : 0,
    won: i < 2 ? 24n * TOKEN : 0n,
    payment: i < 2 ? 990_000_000n : 0n,
    delivered: i === 0,
    nftsClaimed: 0,
    firstPosition: 0,
  }));
}

const NAMES: Record<number, [string, string]> = {
  1: ["Tulip Coin", "TULIP"],
  2: ["Aalsmeer Credits", "AALS"],
  3: ["Delft Blue", "DELFT"],
  4: ["Windmill Energy", "MILL"],
  5: ["Gouda Rewards", "GOUDA"],
  11: ["Lantern", "LNTN"],
  12: ["Ember", "EMBR"],
  13: ["Harbor", "HRBR"],
};

export function mockToken(mint: PublicKey): TokenInfo {
  const seed = [1, 2, 3, 4, 5, 11, 12, 13].find((s) => key(200 + s).equals(mint)) ?? 1;
  const [name, symbol] = NAMES[seed];
  return {
    mint,
    programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    decimals: seed >= 11 ? 6 : 9,
    supply: 1_000_000_000_000_000n,
    mintAuthority: null,
    freezeAuthority: null,
    name,
    symbol,
    uri: null,
  };
}

/** The sample fair launch's token-to-be. */
export function mockLaunchToken(auction: PublicKey) {
  const seed = [11, 12, 13].find((s) => key(s).equals(auction));
  return seed ? { name: NAMES[seed][0], symbol: NAMES[seed][1], uri: "" } : null;
}

const COLLECTIONS: Record<number, [string, string]> = {
  6: ["Delft Tiles", "https://example.com/tiles/collection.json"],
  7: ["Veiled Tulips", "https://example.com/tulips/collection.json"],
  8: ["Delft Studio", "https://example.com/studio/collection.json"],
};

export function mockCollection(address: PublicKey): CollectionInfo {
  const seed = [6, 7, 8].find((s) => key(200 + s).equals(address)) ?? 6;
  const [name, uri] = COLLECTIONS[seed];
  return { address, name, uri, updateAuthority: key(seed), minted: 0 };
}

/** The items of the sample collection made item by item. */
const STUDIO_ITEMS: (ListedItem & { color: string; traits: [string, string][] })[] = [
  { name: "Windmill at Dusk", supply: 3, color: "#2146a3", traits: [["Scene", "Polder"], ["Glaze", "Cobalt"]] },
  { name: "Tulip Field", supply: 1, color: "#ce2939", traits: [["Scene", "Field"], ["Glaze", "Manganese"]] },
  { name: "Canal House", supply: 4, color: "#13774a", traits: [["Scene", "City"], ["Glaze", "Cobalt"]] },
  { name: "Blue Vase", supply: 2, color: "#1b3d92", traits: [["Scene", "Still life"], ["Glaze", "Cobalt"]] },
  { name: "Harbour Light", supply: 2, color: "#8a5a00", traits: [["Scene", "Coast"], ["Glaze", "Ochre"]] },
];

export function mockItemList(auction: PublicKey): ItemList | null {
  if (!auction.equals(key(8))) return null;
  const entries = entriesOf(STUDIO_ITEMS);
  return { address: key(98), count: entries.length, total: entries[entries.length - 1].end, sealed: true, entries };
}

/** A small Delft-style tile, drawn from a number and a colour. */
function tile(n: number, color: string): string {
  const petals = 4 + (n % 4);
  const r = 18 + (n % 3) * 4;
  const shapes = Array.from({ length: petals }, (_, i) => {
    const a = (i / petals) * Math.PI * 2 + n;
    return `<ellipse cx="${50 + Math.cos(a) * r}" cy="${50 + Math.sin(a) * r}" rx="9" ry="16" transform="rotate(${(a * 180) / Math.PI + 90} ${50 + Math.cos(a) * r} ${50 + Math.sin(a) * r})" fill="${color}" opacity="0.85"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#f4f1ea"/><rect x="4" y="4" width="92" height="92" fill="none" stroke="${color}" stroke-width="3"/>${shapes}<circle cx="50" cy="50" r="7" fill="${color}"/><path d="M4 14 L14 4 M86 4 L96 14 M4 86 L14 96 M86 96 L96 86" stroke="${color}" stroke-width="3"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const VEIL = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1b3d92"/><g fill="none" stroke="#c6d2f1" stroke-width="2" opacity="0.6"><circle cx="50" cy="50" r="30"/><circle cx="50" cy="50" r="20"/></g><text x="50" y="58" font-family="sans-serif" font-size="26" font-weight="700" text-anchor="middle" fill="#ffffff">?</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
})();

export function mockCollectionMetadata(uri: string): CollectionMetadata {
  if (uri.includes("tulips")) {
    return {
      description: "Forty-eight tulips painted by hand. The art stays hidden until bidding ends; each winner's tulips are drawn at random.",
      image: tile(3, "#ce2939"),
      banner: null,
      website: "https://example.com",
      x: "https://x.com/example",
      kind: "drop",
      hidden: true,
      preview: VEIL,
      sealed: "S".repeat(43),
    };
  }
  if (uri.includes("studio")) {
    return {
      description: "Five scenes from a Delft workshop, each in a few editions.",
      image: tile(1, "#1b3d92"),
      banner: null,
      website: "https://example.com",
      x: null,
      kind: "collection",
      hidden: false,
      preview: null,
      sealed: null,
    };
  }
  return {
    description: "333 hand-painted tiles in Delft blue, each one of a kind.",
    image: tile(6, "#2146a3"),
    banner: null,
    website: null,
    x: null,
    kind: "drop",
    hidden: false,
    preview: null,
    sealed: null,
  };
}

export function mockNftMetadata(uri: string): NftMetadata | null {
  const number = Number(uri.match(/(\d+)\.json$/)?.[1] ?? "0");
  if (uri.includes("studio")) {
    const entries = entriesOf(STUDIO_ITEMS);
    const item = STUDIO_ITEMS[itemIndexOf(entries, number)];
    return {
      name: itemNftName(entries, number),
      description: null,
      image: tile(STUDIO_ITEMS.indexOf(item) * 3 + 1, item.color),
      externalUrl: null,
      attributes: item.traits.map(([trait, value]) => ({ trait, value })),
    };
  }
  const colors = ["#2146a3", "#1b3d92", "#13774a", "#ce2939"];
  const backgrounds = ["Glazed white", "Cream", "Sky"];
  return {
    name: `Delft Tile #${number + 1}`,
    description: null,
    image: tile(number, colors[number % colors.length]),
    externalUrl: null,
    attributes: [
      { trait: "Background", value: backgrounds[number % backgrounds.length] },
      { trait: "Petals", value: String(4 + (number % 4)) },
    ],
  };
}

/** Totals and points for the Stats page, as the keeper would serve them. */
export function mockStats(): import("./stats").StatsSnapshot {
  const days = [];
  let users = 0;
  const start = Date.UTC(2026, 8, 1) / 1000;
  for (let d = 0; d < 56; d++) {
    const wave = Math.sin(d / 5) * 0.5 + 1;
    const newUsers = Math.round((3 + d * 0.9) * wave);
    users += newUsers;
    const bids = Math.round(newUsers * 4.2 + d * 2);
    days.push({
      day: new Date((start + d * 86_400) * 1000).toISOString().slice(0, 10),
      sales: d % 3 === 0 ? 2 : 1,
      bids,
      volumeSol: Math.round(bids * 0.37 * wave * 100) / 100,
      newUsers,
      users,
    });
  }
  const names = Array.from({ length: 40 }, (_, i) => key(100 + i).toBase58());
  const leaderboard = names
    .map((wallet, i) => {
      const boughtSol = Math.round((90 / (i + 1.4)) * 100) / 100;
      const raisedSol = i % 7 === 2 ? Math.round((260 / (i + 2)) * 100) / 100 : 0;
      const bids = 6 + ((i * 7) % 23);
      const steps = i % 4 === 1 ? 12 - (i % 9) : 0;
      return {
        wallet,
        boughtSol,
        raisedSol,
        bids,
        steps,
        points: Math.round(boughtSol * 100 + raisedSol * 50 + Math.min(bids, 9) * 5 + steps * 5),
      };
    })
    .sort((a, b) => b.points - a.points);
  // The wallet a preview is seen as (?mock&as=) has a place on the board too.
  const as = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("as") : null;
  if (as && !leaderboard.some((w) => w.wallet === as)) {
    leaderboard.push({ wallet: as, boughtSol: 2.42, raisedSol: 0, bids: 9, steps: 4, points: 312 });
    leaderboard.sort((a, b) => b.points - a.points);
  }
  return {
    updatedAt: Math.floor(Date.now() / 1000) - 40,
    network: "devnet",
    points: { perSolBought: 100, perSolRaised: 50, perBid: 5, bidsPerSale: 3, perStep: 5, perInvite: 25, inviteShare: 0.1 },
    season: {
      name: "Season 0",
      start: Date.UTC(2026, 9, 30) / 1000,
      end: Date.UTC(2026, 11, 15) / 1000,
      players: leaderboard.length,
      leaderboard: leaderboard.map((w) => ({ ...w, points: Math.round(w.points * 0.4) })),
      wallets: Object.fromEntries(leaderboard.map((w) => [w.wallet, Math.round(w.points * 0.4)])),
    },
    totals: {
      sales: days.reduce((n, d) => n + d.sales, 0),
      newTokens: 41,
      tokensMade: 29,
      collections: 34,
      bids: days.reduce((n, d) => n + d.bids, 0),
      users,
      bidders: users - 31,
      sellers: 52,
      volumeSol: Math.round(days.reduce((n, d) => n + d.volumeSol, 0) * 100) / 100,
      depositedSol: 9_412.6,
      stepsRun: 3_870,
    },
    days,
    leaderboard,
    wallets: Object.fromEntries(leaderboard.map((w) => [w.wallet, [w.points, w.boughtSol, w.raisedSol, w.bids, w.steps]])),
  };
}

/** A wallet's history for the dashboard, as the keeper would serve it. */
export function mockWalletView(wallet: string): import("./stats").WalletView {
  const now = Math.floor(Date.now() / 1000);
  const day = 86_400;
  const sol = (v: number) => String(Math.round(v * 1e9));
  const joined: import("./stats").JoinedSale[] = [
    { auction: key(11).toBase58(), kind: "launch", mint: key(211).toBase58(), name: "Lantern", symbol: "LNTN", at: now - 3_600, endTime: now + 2_000, bids: 2, deposited: sol(1.5), paid: "0", won: "0", refunded: "0", result: "open" },
    { auction: key(13).toBase58(), kind: "launch", mint: key(213).toBase58(), name: "Harbor", symbol: "HRBR", at: now - 2 * day, endTime: now - 2 * day + 3_600, bids: 1, deposited: sol(2), paid: sol(1.62), won: "12400000000", refunded: sol(0.38), result: "won" },
    { auction: key(12).toBase58(), kind: "launch", mint: key(212).toBase58(), name: "Ember", symbol: "EMBR", at: now - 5 * day, endTime: now - 5 * day + 3_600, bids: 1, deposited: sol(0.5), paid: "0", won: "0", refunded: sol(0.5), result: "refunded" },
    { auction: key(3).toBase58(), kind: "collection", mint: key(203).toBase58(), name: null, symbol: null, at: now - 9 * day, endTime: now - 8 * day, bids: 3, deposited: sol(1.2), paid: sol(0.8), won: "2", refunded: sol(0.4), result: "won" },
    { auction: key(1).toBase58(), kind: "token", mint: key(201).toBase58(), name: null, symbol: null, at: now - 14 * day, endTime: now - 13 * day, bids: 2, deposited: sol(0.6), paid: "0", won: "0", refunded: sol(0.6), result: "lost" },
  ];
  return {
    wallet,
    updatedAt: now - 30,
    points: 312,
    rank: 18,
    season: { name: "Season 0", points: 125, rank: 14 },
    invites: { joined: 4, active: 2, points: 63 },
    totals: {
      bids: 9,
      salesJoined: joined.length,
      salesWon: 2,
      paid: sol(2.42),
      deposited: sol(5.8),
      refunded: sol(1.88),
      salesLaunched: 1,
      raised: sol(11),
      steps: 4,
    },
    joined,
    launched: [
      { auction: key(12).toBase58(), kind: "launch", mint: key(212).toBase58(), name: "Ember", symbol: "EMBR", at: now - 6 * day, endTime: now - 5 * day, bids: 6, bidders: 5, raised: "0", result: "failed" },
    ],
  };
}
