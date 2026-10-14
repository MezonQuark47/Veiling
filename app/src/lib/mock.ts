// Sample data for design previews in development (`?mock` in the URL).
// Production builds drop this file entirely.
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MPL_CORE_ID } from "../config";
import type { Auction, Bid, CollectionInfo, CollectionMetadata, ItemList, NftMetadata, TokenInfo } from "./chain";
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
  ...overrides,
});

export function mockAuctions(): Auction[] {
  // `?mock&nofeature` previews the front page without a featured auction.
  const featured = !new URLSearchParams(window.location.search).has("nofeature");
  return [
    base(1, { featured, bidCount: 37, liveBids: 37, totalDeposited: 41_250_000_000n }),
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
      bidCount: 256,
      liveBids: 256,
      totalDeposited: 1_900_000_000n,
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
};

export function mockToken(mint: PublicKey): TokenInfo {
  const seed = [1, 2, 3, 4, 5].find((s) => key(200 + s).equals(mint)) ?? 1;
  const [name, symbol] = NAMES[seed];
  return {
    mint,
    programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    decimals: 9,
    supply: 1_000_000_000_000_000n,
    mintAuthority: null,
    freezeAuthority: null,
    name,
    symbol,
    uri: null,
  };
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
