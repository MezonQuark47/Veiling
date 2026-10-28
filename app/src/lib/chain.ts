import { AnchorProvider, BN, Program, type IdlAccounts, utils } from "@anchor-lang/core";
import {
  type AccountInfo,
  Connection,
  PublicKey,
  type GetProgramAccountsFilter,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMint, getTokenMetadata } from "@solana/spl-token";
import idl from "../idl/sealed_auction.json";
import { type ItemEntry, itemNftName, numberedName } from "./items";
import { shuffledItems } from "./shuffle";
import type { SealedAuction } from "../idl/sealed_auction";
import {
  CP_AMM_ID,
  EMERGENCY_DELAY_SECS,
  LAUNCH_EMERGENCY_DELAY_SECS,
  WSOL_MINT,
  EVICTION_PREMIUM_PERCENT,
  FOLD_PASSES,
  FOLD_REWARD_PERCENT,
  FRESH_ARWEAVE_GATEWAY,
  MAX_COLLECTION_PAGES,
  MAX_PREPAID_PAGES,
  MAX_TOKEN_PAGES,
  MAX_PRICE_TICKS,
  MPL_CORE_ID,
  PROGRAM_ID,
  REVEAL_DELAY_SECS,
  RPC_URL,
  BATCH_SIZE,
  PAGE_BIDS,
  LAUNCH_DECIMALS,
  LAUNCH_SALE_SUPPLY,
  LAUNCH_SUPPLY,
} from "../config";
import { type Decimal, choosePriceUnit, formatDecimal, nftPrice, nftPriceToTicks, shift, tokenPrice, tokenPriceToTicks, unitExponent } from "./price";

export const connection = new Connection(RPC_URL, { commitment: "confirmed" });

/** Development-only preview with sample data (`?mock`); removed from production builds. */
const MOCK = import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock");

// Reads never sign; transactions are signed through the connected wallet.
const readOnlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: async <T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> => {
    throw new Error("Connect a wallet to sign");
  },
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(_txs: T[]): Promise<T[]> => {
    throw new Error("Connect a wallet to sign");
  },
};

export const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed" });
export const program = new Program<SealedAuction>(idl as SealedAuction, provider);

if (!program.programId.equals(PROGRAM_ID)) {
  console.warn("IDL address differs from PROGRAM_ID in config.ts");
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Little-endian u64 bytes, as the program's seeds use. */
function u64le(value: BN): Uint8Array {
  const bytes = new Uint8Array(8);
  let v = BigInt(value.toString());
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

const seed = (text: string) => new TextEncoder().encode(text);

export const configAddress = PublicKey.findProgramAddressSync([seed("config")], PROGRAM_ID)[0];
export const feeConfigAddress = PublicKey.findProgramAddressSync([seed("fees")], PROGRAM_ID)[0];

export function auctionAddress(seller: PublicKey, auctionSeed: BN): PublicKey {
  return PublicKey.findProgramAddressSync([seed("auction"), seller.toBytes(), u64le(auctionSeed)], PROGRAM_ID)[0];
}

/**
 * A page of an auction's bid book: batch records and the deposit of each of
 * its `PAGE_BIDS` bids. Every auction has page 0; further pages open as the
 * book fills (`maxPages`).
 */
export function bookAddress(auction: PublicKey, page = 0): PublicKey {
  const seeds = [seed("book"), auction.toBytes()];
  if (page > 0) seeds.push(Uint8Array.of(page));
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

/** The page of the bid book that holds bid `index`. */
export const pageOf = (index: number) => Math.floor(index / PAGE_BIDS);

/** The state of an auction's clearing across pages. */
export function foldAddress(auction: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("fold"), auction.toBytes()], PROGRAM_ID)[0];
}

/** A token sale's allowlist: the root of its wallets' tree and where the list is published. */
export function allowlistAddress(auction: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("allowlist"), auction.toBytes()], PROGRAM_ID)[0];
}

/** A wallet's admission to a sale with an allowlist (`join_auction`). */
export function participantAddress(auction: PublicKey, wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("participant"), auction.toBytes(), wallet.toBytes()], PROGRAM_ID)[0];
}

/** A sale's allowlist as the program keeps it, or null before the seller sets it. */
export async function fetchAllowlistInfo(auction: PublicKey): Promise<{ root: Uint8Array; uri: string } | null> {
  if (MOCK) return null;
  const list = await program.account.allowlist.fetchNullable(allowlistAddress(auction));
  return list ? { root: Uint8Array.from(list.root), uri: list.uri } : null;
}

/** What a wallet admitted to a sale has deposited across its bids, or null if it has not joined. */
export async function fetchParticipant(auction: PublicKey, wallet: PublicKey): Promise<{ deposited: bigint } | null> {
  if (MOCK) return null;
  const p = await program.account.participant.fetchNullable(participantAddress(auction, wallet));
  return p ? { deposited: big(p.deposited) } : null;
}

/** The per-page summaries of a book with more than one page (`BookIndex`). */
export function bookIndexAddress(auction: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("index"), auction.toBytes()], PROGRAM_ID)[0];
}

/** A token sale's auto-liquidity plan. */
export function liquidityPlanAddress(auction: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("liquidity"), auction.toBytes()], PROGRAM_ID)[0];
}

/** A fair launch's token-to-be: its name, symbol and link until it is made. */
export function launchTokenAddress(auction: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("launch"), auction.toBytes()], PROGRAM_ID)[0];
}

/** Where a fair launch's token is made if it graduates. */
export function launchMintAddress(auction: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("launch_mint"), auction.toBytes()], PROGRAM_ID)[0];
}

/** The data-less address that holds a plan's reserve and owns its pool position. */
export function lpAuthorityAddress(auction: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("lp_authority"), auction.toBytes()], PROGRAM_ID)[0];
}

const damm = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, CP_AMM_ID)[0];

/** DAMM v2's one customizable pool for a token and SOL, and its accounts. */
export function dammPoolAddress(mint: PublicKey): PublicKey {
  const [a, b] = [mint.toBytes(), WSOL_MINT.toBytes()];
  // The larger key first, comparing bytes.
  const k = a.findIndex((byte, i) => byte !== b[i]);
  const mintFirst = k >= 0 && a[k] > b[k];
  return damm([seed("cpool"), mintFirst ? a : b, mintFirst ? b : a]);
}
export const dammVaultAddress = (mint: PublicKey, pool: PublicKey) => damm([seed("token_vault"), mint.toBytes(), pool.toBytes()]);
export const dammPositionAddress = (nftMint: PublicKey) => damm([seed("position"), nftMint.toBytes()]);
export const dammNftAccountAddress = (nftMint: PublicKey) => damm([seed("position_nft_account"), nftMint.toBytes()]);
export const dammPoolAuthority = damm([seed("pool_authority")]);
export const dammEventAuthority = damm([seed("__event_authority")]);

export function bidAddress(auction: PublicKey, bidder: PublicKey, bidSeed: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [seed("bid"), auction.toBytes(), bidder.toBytes(), u64le(bidSeed)],
    PROGRAM_ID
  )[0];
}

/** The Metaplex Core collection a collection auction creates. */
export function collectionAddress(auction: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("collection"), auction.toBytes()], PROGRAM_ID)[0];
}

/** The item list of a collection auction named per item. */
export function itemListAddress(auction: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([seed("items"), auction.toBytes()], PROGRAM_ID)[0];
}

/** The NFT minted for place `position` of a collection auction. */
export function assetAddress(auction: PublicKey, position: number): PublicKey {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, position, true);
  return PublicKey.findProgramAddressSync([seed("asset"), auction.toBytes(), bytes], PROGRAM_ID)[0];
}

export function randomU64(): BN {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return new BN(bytes, "le");
}

// ---------------------------------------------------------------------------
// Decoded state
// ---------------------------------------------------------------------------

export type AuctionKind = "token" | "collection";
export type AuctionStatus = "open" | "settling" | "finished" | "cancelled";
/** `atClearing`: revealed exactly at the final price, share not split off yet. */
export type BidStatus = "sealed" | "settled" | "atClearing";

export interface Auction {
  address: PublicKey;
  kind: AuctionKind;
  seed: BN;
  seller: PublicKey;
  /** The token, or the collection of a collection auction. */
  mint: PublicKey;
  tokenProgram: PublicKey;
  /** Base units of the token for sale, or NFTs. */
  supply: bigint;
  /** Base units one price refers to (a power of ten); 1 for a collection. */
  priceUnit: bigint;
  /** Lamports per price tick: 1 for tokens, 1_000 for NFTs. */
  priceScale: bigint;
  /** Lowest price that counts, in ticks. */
  minPrice: bigint;
  /** Smallest deposit a bid may make, in lamports. */
  minDeposit: bigint;
  /** Collections: most NFTs one bid may ask for. */
  maxPerBid: number;
  startTime: number;
  endTime: number;
  status: AuctionStatus;
  featured: boolean;
  hidden: boolean;
  bidCount: number;
  checkedCount: number;
  resolvedCount: number;
  /** Bid accounts not closed yet; the auction can be closed at zero. */
  liveBids: number;
  pendingComputation: PublicKey;
  pendingSince: number;
  /** Price every winner pays, in ticks; the minimum price without a fill. */
  clearingPrice: bigint;
  filled: boolean;
  /** Demand above and at the final price: lamports of budget for tokens, NFTs for collections. */
  weightAbove: bigint;
  weightAt: bigint;
  /** Collections: NFTs asked for by bids revealed at the final price so far. */
  atRevealed: bigint;
  sold: bigint;
  delivered: bigint;
  proceeds: bigint;
  /** Sum of every bid's deposit; individual bidders are not listed anywhere. */
  totalDeposited: bigint;
  saleFeeBps: number;
  treasury: PublicKey;
  royaltyBps: number;
  uriPerItem: boolean;
  itemName: string;
  itemUri: string;
  /** Collections: places handed out to winning bids as they settled. */
  assignedPositions: number;
  /** Collections: the seed Arcium drew once every bid was settled, which turns places into NFT numbers. */
  nftSeed: bigint;
  seedDrawn: boolean;
  /** Collections: whether NFTs are named per item, from the auction's item list. */
  namedItems: boolean;
  /** Hidden collections: whether the art is still to be revealed; no NFT can be minted until it is. */
  unrevealed: boolean;
  /** What this auction pays whoever runs each private step, fixed when it opened. */
  crankRewards: CrankRewards;
  /** Lamports left to pay them; what is left goes back to the seller at close. */
  crankPool: bigint;
  /** Pages of the bid book beyond the first, each room for `PAGE_BIDS` more bids. */
  extraPages: number;
  /** Token sales: the auto-liquidity plan's state (`LiquidityPlan` holds the terms). */
  liquidity: LiquidityState;
  /** The least SOL the planned pool gets, in lamports. */
  liquidityFloor: bigint;
  /** Seconds the soft close has added to the end of bidding; `endTime` includes them. */
  extendedSecs: number;
  /** Pages the seller paid for ahead of time, bit `p` for page `p`; bids there pay no room fee. */
  prepaidPages: number;
  /** Token sales: the least the winners must pay in all for the sale to go ahead (0 for none). */
  minRaise: bigint;
  /** Token sales with an allowlist: the most one wallet may deposit across its bids (0 for no cap). */
  walletCap: bigint;
  /** Token sales: whether only wallets on the sale's allowlist may bid. */
  allowlist: boolean;
  /** Whether the sale missed its minimum raise when it cleared; every bid is then refunded. */
  raiseMissed: boolean;
  /**
   * A fair launch: a token sale whose token was made with it. Sells like any
   * token sale (`kind` is "token"); half the supply is sold, the other half
   * and all the SOL raised open its pool, and what is left is burned.
   */
  launch: boolean;
}

/**
 * Auto-liquidity: none; planned and waiting for the sale; failed (the sale
 * missed the pool's minimum, so every bid is refunded); pooled (the pool is
 * open and locked); released (no pool, the reserve went back to the seller).
 */
export type LiquidityState = "none" | "planned" | "failed" | "pooled" | "released";
const LIQUIDITY_STATES: LiquidityState[] = ["none", "planned", "failed", "pooled", "released"];

/** A token sale's auto-liquidity terms and, once opened, its pool. */
export interface LiquidityPlan {
  address: PublicKey;
  auction: PublicKey;
  seller: PublicKey;
  treasury: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  /** Share of the net proceeds that goes into the pool, in bps. */
  lpBps: number;
  /** The least SOL the pool gets, in lamports. */
  floor: bigint;
  /** The pool's trading fee after the anti-sniper fee, in bps. */
  tradeFeeBps: number;
  /** Tokens escrowed for the pool. */
  reserve: bigint;
  poolSol: bigint;
  poolTokens: bigint;
  pool: PublicKey;
  position: PublicKey;
  positionNftMint: PublicKey;
  feesToSeller: bigint;
  feesToPlatform: bigint;
}

/** Lamports paid to whoever runs each private step, when its computation succeeds. */
export interface CrankRewards {
  checkBatch: bigint;
  clearing: bigint;
  settlement: bigint;
  seedDraw: bigint;
}

export interface Bid {
  address: PublicKey;
  auction: PublicKey;
  bidder: PublicKey;
  index: number;
  /** Lamports escrowed: they cover a token bid's sealed budget, or a collection bid's cost. */
  deposit: bigint;
  status: BidStatus;
  pendingComputation: PublicKey;
  pendingSince: number;
  outcome: number;
  /** Base units or NFTs won. */
  won: bigint;
  payment: bigint;
  /** Whether everything the bid won has been delivered. */
  delivered: boolean;
  nftsClaimed: number;
  /** Collections: the first of the places this bid took when it settled, one per NFT won. */
  firstPosition: number;
}

export interface FeeConfig {
  listingFee: bigint;
  saleFeeBps: number;
  treasury: PublicKey;
}

type RawAuction = IdlAccounts<SealedAuction>["auction"];
type RawBid = IdlAccounts<SealedAuction>["bid"];

const big = (v: BN) => BigInt(v.toString());
const enumKey = <T extends string>(v: object) => Object.keys(v)[0] as T;

export function decodeAuction(address: PublicKey, a: RawAuction): Auction {
  return {
    address,
    // A fair launch sells like a token sale; `launch` tells it apart.
    kind: enumKey<string>(a.kind) === "collection" ? "collection" : "token",
    seed: a.seed,
    seller: a.seller,
    mint: a.mint,
    tokenProgram: a.tokenProgram,
    supply: big(a.supply),
    priceUnit: big(a.priceUnit),
    priceScale: big(a.priceScale),
    minPrice: BigInt(a.minPrice),
    minDeposit: big(a.minDeposit),
    maxPerBid: a.maxPerBid,
    startTime: a.startTime.toNumber(),
    endTime: a.endTime.toNumber(),
    status: enumKey<AuctionStatus>(a.status),
    featured: a.featured,
    hidden: a.hidden,
    bidCount: a.bidCount,
    checkedCount: a.checkedCount,
    resolvedCount: a.resolvedCount,
    liveBids: a.liveBids,
    pendingComputation: a.pendingComputation,
    pendingSince: a.pendingSince.toNumber(),
    clearingPrice: BigInt(a.clearingPrice),
    filled: a.filled,
    weightAbove: big(a.weightAbove),
    weightAt: big(a.weightAt),
    atRevealed: big(a.atRevealed),
    sold: big(a.sold),
    delivered: big(a.delivered),
    proceeds: big(a.proceeds),
    totalDeposited: big(a.totalDeposited),
    saleFeeBps: a.saleFeeBps,
    treasury: a.treasury,
    royaltyBps: a.royaltyBps,
    uriPerItem: a.uriPerItem,
    itemName: a.itemName,
    itemUri: a.itemUri,
    assignedPositions: a.assignedPositions,
    nftSeed: big(a.nftSeed),
    seedDrawn: a.seedDrawn,
    namedItems: a.namedItems,
    unrevealed: a.unrevealed,
    crankRewards: decodeCrankRewards(a.crankRewards),
    crankPool: big(a.crankPool),
    // Auctions opened before pages existed read as one page.
    extraPages: a.extraPages ?? 0,
    // ...and those opened before auto-liquidity, as none.
    liquidity: LIQUIDITY_STATES[a.liquidity ?? 0] ?? "none",
    liquidityFloor: a.liquidityFloor ? big(a.liquidityFloor) : 0n,
    extendedSecs: a.extendedSecs ?? 0,
    prepaidPages: a.prepaidPages ?? 0,
    minRaise: a.minRaise ? big(a.minRaise) : 0n,
    walletCap: a.walletCap ? big(a.walletCap) : 0n,
    allowlist: a.allowlist ?? false,
    raiseMissed: a.raiseMissed ?? false,
    launch: enumKey<string>(a.kind) === "launch",
  };
}

/**
 * Whether the sale does not go ahead: it missed its minimum raise or its
 * pool's minimum. Every bid is then refunded in full, with no computation.
 */
export const saleFailed = (a: Auction) => a.raiseMissed || a.liquidity === "failed";

/**
 * Whether a winning bid of a new token still waits for its tokens: they reach
 * winners only once the token's pool is open.
 */
export const waitsForPool = (a: Auction, b: Bid) => a.launch && a.liquidity !== "pooled" && b.won > 0n && !b.delivered;

/** Bids the auction can hold before new bids must replace the smallest. */
export const bidCapacity = (a: Auction) => PAGE_BIDS * (1 + a.extraPages);

/**
 * Whether the next bid into a full book can open another page instead of
 * replacing the smallest bid (`open_book_page`).
 */
export const canGrow = (a: Auction) => a.extraPages + 1 < maxPages(a.kind);

/** Most pages an auction's book can have: 4 for tokens, 40 for a collection. */
export const maxPages = (kind: AuctionKind) => (kind === "collection" ? MAX_COLLECTION_PAGES : MAX_TOKEN_PAGES);

/** Most bids an auction of this kind can hold. */
export const maxBids = (kind: AuctionKind) => PAGE_BIDS * maxPages(kind);

/** Pages of the book that hold bids (at least one). */
export const pagesInUse = (a: Auction) => Math.max(1, Math.ceil(a.bidCount / PAGE_BIDS));

/** Every page of the auction's book after the first, in order. */
export const extraPageAddresses = (a: Auction) =>
  Array.from({ length: a.extraPages }, (_, k) => bookAddress(a.address, k + 1));

/** What one step of the clearing across pages pays its caller. */
export const foldReward = (r: CrankRewards) => (r.clearing * FOLD_REWARD_PERCENT) / 100n;

/** Steps of the clearing across `pages` pages: one pass per four bits of the price, the page ending a pass starting the next. */
export const foldTotalSteps = (pages: number) => FOLD_PASSES * (Math.max(1, pages) - 1) + 1;

/**
 * What the seller adds to the crank pool with page `page` (from 1): the
 * clearing steps it adds. One page needs none (its clearing is one step, paid
 * when the auction opens), two take nine, each further page eight more.
 */
export const pageCrankFee = (r: CrankRewards, page: number) =>
  foldReward(r) * BigInt(foldTotalSteps(page + 1) - (page <= 1 ? 0 : foldTotalSteps(page)));

/** Where the clearing across pages stands. */
export interface ClearingFold {
  /** Pass and page of the next step; `pass` is `FOLD_PASSES` once done. */
  pass: number;
  page: number;
  steps: number;
}

/** The auction's clearing across pages, or null if it has only one page. */
export async function fetchClearingFold(auction: Auction): Promise<ClearingFold | null> {
  if (auction.extraPages === 0) return null;
  if (MOCK) return { pass: 2, page: 1, steps: 9 };
  const fold = await program.account.clearingFold.fetchNullable(foldAddress(auction.address));
  return fold ? { pass: fold.pass, page: fold.page, steps: fold.steps } : null;
}

export async function fetchLiquidityPlan(auction: Auction): Promise<LiquidityPlan | null> {
  if (auction.liquidity === "none") return null;
  if (MOCK) return (await import("./mock")).mockLiquidityPlan(auction);
  const address = liquidityPlanAddress(auction.address);
  const p = await program.account.liquidityPlan.fetchNullable(address);
  if (!p) return null;
  return {
    address,
    auction: p.auction,
    seller: p.seller,
    treasury: p.treasury,
    mint: p.mint,
    tokenProgram: p.tokenProgram,
    lpBps: p.lpBps,
    floor: big(p.floor),
    tradeFeeBps: p.tradeFeeBps,
    reserve: big(p.reserve),
    poolSol: big(p.poolSol),
    poolTokens: big(p.poolTokens),
    pool: p.pool,
    position: p.position,
    positionNftMint: p.positionNftMint,
    feesToSeller: big(p.feesToSeller),
    feesToPlatform: big(p.feesToPlatform),
  };
}

/**
 * The SOL the pool gets out of `net` proceeds (after the sale fee): its share,
 * raised to the floor, never more than `net`. Mirrors `pool_sol`.
 */
export function poolSol(net: bigint, lpBps: number, floor: bigint): bigint {
  const share = (net * BigInt(lpBps)) / 10_000n;
  const raised = share > floor ? share : floor;
  return raised < net ? raised : net;
}

/** Whether every bid of a sale with a planned pool is resolved, so the pool can open. */
export const poolReady = (a: Auction) =>
  a.liquidity === "planned" && a.status === "settling" && a.resolvedCount === a.bidCount;

function decodeCrankRewards(r: { checkBatch: BN; clearing: BN; settlement: BN; seedDraw: BN }): CrankRewards {
  return { checkBatch: big(r.checkBatch), clearing: big(r.clearing), settlement: big(r.settlement), seedDraw: big(r.seedDraw) };
}

/** What each bid adds to the crank pool: its share of a batch check and its own settlement. Not refunded. */
export const bidCrankFee = (r: CrankRewards) => (r.checkBatch + r.settlement + BigInt(BATCH_SIZE) - 1n) / BigInt(BATCH_SIZE);

/** Rent of a page of the bid book, the paged clearing's state and the book's index (8,232, 289 and 460 bytes). */
const PAGE_RENT = (128n + 8_232n) * 6_960n;
const FOLD_RENT = (128n + 289n) * 6_960n;
const INDEX_RENT = (128n + 460n) * 6_960n;

/**
 * What a bid on `page` pays on top of `bidCrankFee`: its share of a page
 * opened on demand, rent and clearing steps over 256 places. Mirrors
 * `room_fee`.
 */
export function roomFee(a: Auction, page: number): bigint {
  if (page === 0 || (page < MAX_PREPAID_PAGES && (a.prepaidPages & (1 << page)) !== 0)) return 0n;
  let cost = PAGE_RENT + pageCrankFee(a.crankRewards, page);
  if (page === 1) cost += FOLD_RENT + INDEX_RENT;
  return (cost + BigInt(PAGE_BIDS) - 1n) / BigInt(PAGE_BIDS);
}

/**
 * The page the next bid lands on: the next free place, a page opened for it,
 * or, once every page is full, the last page (the most a replacement pays).
 */
export function nextBidPage(a: Auction): number {
  if (a.bidCount < bidCapacity(a)) return pageOf(a.bidCount);
  return canGrow(a) ? a.extraPages + 1 : a.extraPages;
}

/** What a bid is charged into the crank pool: its steps and, on an extra page, its room fee. */
export const nextBidFee = (a: Auction) => bidCrankFee(a.crankRewards) + roomFee(a, nextBidPage(a));

/** What a seller puts in the crank pool when the auction opens. */
export const sellerCrankFee = (r: CrankRewards, kind: AuctionKind) =>
  r.clearing + r.checkBatch + r.settlement + (kind === "collection" ? r.seedDraw : 0n);

export function decodeBid(address: PublicKey, b: RawBid): Bid {
  return {
    address,
    auction: b.auction,
    bidder: b.bidder,
    index: b.index,
    deposit: big(b.deposit),
    status: enumKey<BidStatus>(b.status),
    pendingComputation: b.pendingComputation,
    pendingSince: b.pendingSince.toNumber(),
    outcome: b.outcome,
    won: big(b.won),
    payment: big(b.payment),
    delivered: b.delivered,
    nftsClaimed: b.nftsClaimed,
    firstPosition: b.firstPosition,
  };
}

/** What a settled bid still has to collect: tokens or NFTs it won. */
export function hasTokensToCollect(b: Bid): boolean {
  return b.status === "settled" && b.won > 0n && !b.delivered;
}

export function refundOf(b: Bid): bigint {
  return b.status === "settled" ? b.deposit - b.payment : b.deposit;
}

/**
 * Whether a collection's NFTs are waiting for Arcium to shuffle them: every
 * bid is settled, so each winner holds its places, but the seed that turns
 * places into NFT numbers is not drawn yet. Auctions opened before shuffling
 * existed hand out no places and never wait.
 */
export function needsShuffle(a: Auction): boolean {
  return (
    a.kind === "collection" &&
    (a.status === "settling" || a.status === "finished") &&
    a.resolvedCount === a.bidCount &&
    a.sold > 0n &&
    !a.seedDrawn &&
    a.delivered < a.sold &&
    BigInt(a.assignedPositions) === a.sold
  );
}

/**
 * Whether a winner's NFTs can be minted: once the shuffle is drawn, or, if it
 * never was, once the safety net opens (places then become their own numbers).
 */
export function nftsReady(a: Auction, now: number): boolean {
  return a.seedDrawn || now >= emergencyOpensAt(a);
}

/** The NFT numbers (from 1) a settled winning collection bid gets, once they are known. */
export function nftNumbersOf(a: Auction, b: Bid, now: number): number[] | null {
  if (a.kind !== "collection" || b.status !== "settled" || b.won === 0n || !nftsReady(a, now)) return null;
  const places = Array.from({ length: Number(b.won) }, (_, k) => b.firstPosition + k);
  const items = a.seedDrawn ? shuffledItems(places, Number(a.supply), a.nftSeed) : places;
  return items.map((i) => i + 1);
}

/** Name of NFT `number` (from 1), as minted: per item from the item list, or `"{item_name} #n"`. */
export function nftName(a: Auction, number: number, entries: ItemEntry[] | null): string | null {
  if (!a.namedItems) return numberedName(a.itemName, number - 1);
  return entries ? itemNftName(entries, number - 1) : null;
}

/** When a hidden collection's time to reveal runs out; winners can then take their payments back. */
export function revealClosesAt(a: Auction): number {
  return a.endTime + REVEAL_DELAY_SECS;
}

/** Whether a hidden collection was not revealed in time, so its winners take their payments back. */
export function revealMissed(a: Auction, now: number): boolean {
  return a.kind === "collection" && a.unrevealed && a.status !== "cancelled" && now >= revealClosesAt(a);
}

/**
 * Once every collection bid exactly at the final price has been revealed,
 * their shares of the NFTs left there are fixed and can be split off (anyone
 * can).
 */
export function sharesAreFinal(a: Auction): boolean {
  return (
    a.kind === "collection" &&
    (a.status === "settling" || a.status === "finished") &&
    a.filled &&
    a.weightAt > 0n &&
    a.atRevealed === a.weightAt
  );
}

// Byte offsets inside Bid used for server-side filtering.
const BID_AUCTION_OFFSET = 8 + 32 + 32 + 32 + 16;
const BID_BIDDER_OFFSET = BID_AUCTION_OFFSET + 32;
const BID_INDEX_OFFSET = BID_BIDDER_OFFSET + 32;

/**
 * Every account of one type, like `program.account.<name>.all()`, except that
 * an account which no longer decodes (left by an earlier program version) is
 * skipped instead of failing the whole list.
 */
async function allAccounts<T>(name: "auction" | "bid", filters: GetProgramAccountsFilter[] = []) {
  const discriminator = program.coder.accounts.memcmp(name);
  const rows = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: discriminator.offset ?? 0, bytes: discriminator.bytes! } }, ...filters],
  });
  const decoded: { publicKey: PublicKey; account: T }[] = [];
  for (const { pubkey, account } of rows) {
    try {
      decoded.push({ publicKey: pubkey, account: program.coder.accounts.decode<T>(name, account.data) });
    } catch {
      // Not readable by this version of the program.
    }
  }
  return decoded;
}

const OUTDATED = "This auction was opened with an earlier version of the program and can no longer be shown.";

/** Whether `data` starts with the discriminator of the IDL account `name`. */
function isAccount(name: "Auction" | "Bid" | "ItemList", data: Uint8Array): boolean {
  const discriminator = (idl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find(
    (a) => a.name === name
  )!.discriminator;
  return discriminator.every((byte, i) => data[i] === byte);
}

export async function fetchAuctions(): Promise<Auction[]> {
  if (MOCK) return (await import("./mock")).mockAuctions();
  const rows = await allAccounts<RawAuction>("auction");
  return rows.map((r) => decodeAuction(r.publicKey, r.account));
}

export async function fetchAuction(address: PublicKey): Promise<Auction | null> {
  if (MOCK) return (await import("./mock")).mockAuctions().find((a) => a.address.equals(address)) ?? null;
  const account = await connection.getAccountInfo(address);
  if (!account || !account.owner.equals(PROGRAM_ID) || !isAccount("Auction", account.data)) return null;
  try {
    return decodeAuction(address, program.coder.accounts.decode<RawAuction>("auction", account.data));
  } catch {
    throw new Error(OUTDATED);
  }
}

export async function fetchBidsForAuction(auction: PublicKey): Promise<Bid[]> {
  if (MOCK) return (await import("./mock")).mockBids(auction, null);
  const rows = await allAccounts<RawBid>("bid", [
    { memcmp: { offset: BID_AUCTION_OFFSET, bytes: auction.toBase58() } },
  ]);
  return rows.map((r) => decodeBid(r.publicKey, r.account)).sort((x, y) => x.index - y.index);
}

/** The auction's bid at `index`, without loading every bid. */
export async function fetchBidAtIndex(auction: PublicKey, index: number): Promise<Bid | null> {
  if (MOCK) return (await import("./mock")).mockBids(auction, null).find((b) => b.index === index) ?? null;
  const le = new Uint8Array(4);
  new DataView(le.buffer).setUint32(0, index, true);
  const rows = await allAccounts<RawBid>("bid", [
    { memcmp: { offset: BID_AUCTION_OFFSET, bytes: auction.toBase58() } },
    { memcmp: { offset: BID_INDEX_OFFSET, bytes: utils.bytes.bs58.encode(le) } },
  ]);
  return rows.length > 0 ? decodeBid(rows[0].publicKey, rows[0].account) : null;
}

export async function fetchBidsForBidder(bidder: PublicKey): Promise<Bid[]> {
  const rows = await allAccounts<RawBid>("bid", [
    { memcmp: { offset: BID_BIDDER_OFFSET, bytes: bidder.toBase58() } },
  ]);
  return rows.map((r) => decodeBid(r.publicKey, r.account));
}

export async function fetchBid(address: PublicKey): Promise<Bid | null> {
  const account = await connection.getAccountInfo(address);
  if (!account || !account.owner.equals(PROGRAM_ID) || !isAccount("Bid", account.data)) return null;
  try {
    return decodeBid(address, program.coder.accounts.decode<RawBid>("bid", account.data));
  } catch {
    return null;
  }
}

// An item list: discriminator, auction, seller, count and total (u32), sealed
// and bump, then `count` entries of where the item ends (u32), its name's
// length (u8) and the name padded to 24 bytes (see `ItemList` in the program).
const ITEM_LIST_HEADER = 8 + 32 + 32 + 4 + 4 + 1 + 1;
const ITEM_NAME_BYTES = 24;
const ITEM_ENTRY = 4 + 1 + ITEM_NAME_BYTES;

export interface ItemList {
  address: PublicKey;
  count: number;
  total: number;
  sealed: boolean;
  entries: ItemEntry[];
}

export function parseItemList(address: PublicKey, data: Uint8Array): ItemList | null {
  if (data.length < ITEM_LIST_HEADER) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(72, true);
  const total = view.getUint32(76, true);
  if (data.length < ITEM_LIST_HEADER + count * ITEM_ENTRY) return null;
  const entries: ItemEntry[] = [];
  const decoder = new TextDecoder();
  for (let k = 0; k < count; k++) {
    const at = ITEM_LIST_HEADER + k * ITEM_ENTRY;
    const length = Math.min(data[at + 4], ITEM_NAME_BYTES);
    entries.push({ end: view.getUint32(at, true), name: decoder.decode(data.subarray(at + 5, at + 5 + length)) });
  }
  return { address, count, total, sealed: data[80] === 1, entries };
}

/** A collection auction's item list, or null if it has none (or it was closed). */
export async function fetchItemList(auction: PublicKey): Promise<ItemList | null> {
  if (MOCK) return (await import("./mock")).mockItemList(auction);
  const address = itemListAddress(auction);
  const account = await connection.getAccountInfo(address);
  if (!account || !account.owner.equals(PROGRAM_ID) || !isAccount("ItemList", account.data)) return null;
  return parseItemList(address, account.data);
}

// Deposits sit after the 8-byte discriminator, 64 batch records of 64 bytes
// and 64 nonces of 16 bytes (see `BidBook` in the program); clearing sizes
// after the deposits and the auction key.
const BOOK_DEPOSITS_OFFSET = 8 + 64 * 64 + 64 * 16;
const BOOK_CLEARING_QUANTITIES_OFFSET = BOOK_DEPOSITS_OFFSET + 8 * PAGE_BIDS + 32;

/** Pages of the auction's book, in order (all of them by default): `PAGE_BIDS` slots each. */
async function fetchBookPages(a: Auction, pages = [0, ...extraPageAddresses(a).map((_, k) => k + 1)]): Promise<DataView[]> {
  const addresses = pages.map((page) => bookAddress(a.address, page));
  const accounts: (AccountInfo<Buffer> | null)[] = [];
  // At most 100 accounts per request.
  for (let i = 0; i < addresses.length; i += 100) {
    accounts.push(...(await connection.getMultipleAccountsInfo(addresses.slice(i, i + 100))));
  }
  return accounts.map((account) => {
    if (!account) throw new Error("A page of this auction's bid book is missing");
    return new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength);
  });
}

/** The deposits on one page of the book, by slot. */
export async function fetchPageDeposits(a: Auction, page: number): Promise<bigint[]> {
  if (MOCK) {
    const bids = (await import("./mock")).mockBids(a.address, null);
    return Array.from({ length: PAGE_BIDS }, (_, i) => bids[page * PAGE_BIDS + i]?.deposit ?? 3_000_000_000n);
  }
  const [view] = await fetchBookPages(a, [page]);
  return Array.from({ length: PAGE_BIDS }, (_, i) => view.getBigUint64(BOOK_DEPOSITS_OFFSET + 8 * i, true));
}

/** A book's index: the smallest deposit on each page, and how far the count of bids at the final price got. */
export interface BookIndex {
  smallestDeposits: bigint[];
  talliedPages: number;
}

/** The index of a book with more than one page, or null. */
export async function fetchBookIndex(a: Auction): Promise<BookIndex | null> {
  if (a.extraPages === 0) return null;
  if (MOCK) return { smallestDeposits: Array.from({ length: a.extraPages + 1 }, () => 3_000_000_000n), talliedPages: 0 };
  const index = await program.account.bookIndex.fetchNullable(bookIndexAddress(a.address));
  if (!index) return null;
  return {
    smallestDeposits: (index.smallestDeposits as BN[]).map(big),
    talliedPages: index.talliedPages,
  };
}

/** The page whose smallest deposit is the book's smallest, and that deposit. */
export async function findSmallestPage(a: Auction): Promise<{ page: number; deposit: bigint }> {
  const index = await fetchBookIndex(a);
  if (!index) {
    const deposits = await fetchPageDeposits(a, 0);
    return { page: 0, deposit: deposits.slice(0, Math.min(PAGE_BIDS, a.bidCount)).reduce((m, d) => (d < m ? d : m)) };
  }
  let page = 0;
  for (let p = 1; p <= a.extraPages; p++) if (index.smallestDeposits[p] < index.smallestDeposits[page]) page = p;
  return { page, deposit: index.smallestDeposits[page] };
}

/** NFTs asked for by each bid revealed at the final price, by bid index (0 for the rest). */
export async function fetchClearingQuantities(a: Auction): Promise<number[]> {
  if (MOCK) return Array.from({ length: bidCapacity(a) }, (_, i) => (i === 2 ? 3 : 0));
  const pages = await fetchBookPages(a);
  return pages.flatMap((view) =>
    Array.from({ length: PAGE_BIDS }, (_, i) => view.getUint32(BOOK_CLEARING_QUANTITIES_OFFSET + 4 * i, true))
  );
}

/**
 * A collection bid's share at the final price, as `finalize_share`
 * computes it: each bid there gets its size times the NFTs left over the
 * demand at that price, rounded down, and the NFTs lost to rounding go one
 * each to the bids with the lowest indices.
 */
export function clearingShare(a: Auction, quantities: number[], index: number): bigint {
  const remaining = a.supply - a.weightAbove;
  const total = a.weightAt;
  let floors = 0n;
  let earlier = 0n;
  quantities.forEach((size, j) => {
    if (size === 0) return;
    floors += (BigInt(size) * remaining) / total;
    if (j < index) earlier += 1n;
  });
  const own = (BigInt(quantities[index] ?? 0) * remaining) / total;
  return own + (earlier < remaining - floors ? 1n : 0n);
}

/**
 * When an auction is full, a new bid replaces the bid with the smallest
 * deposit and must deposit `EVICTION_PREMIUM_PERCENT` more (rounded up).
 */
export function evictionThreshold(smallest: bigint): bigint {
  let premium = (smallest * EVICTION_PREMIUM_PERCENT + 99n) / 100n;
  if (premium < 1n) premium = 1n;
  return smallest + premium;
}

export async function fetchAdmin(): Promise<PublicKey | null> {
  return (await fetchAdminRoles())?.admin ?? null;
}

/** The admin and, during a handover, the wallet the role has been offered to. */
export async function fetchAdminRoles(): Promise<{ admin: PublicKey; pendingAdmin: PublicKey | null } | null> {
  if (MOCK) return null;
  const config = await program.account.config.fetchNullable(configAddress);
  return config ? { admin: config.admin, pendingAdmin: config.pendingAdmin ?? null } : null;
}

/** The platform's current fees, or null before the admin has set any. */
export const crankConfigAddress = PublicKey.findProgramAddressSync([seed("crank")], PROGRAM_ID)[0];

/** The crank rewards auctions open with now; null if the platform has not set them. */
export async function fetchCrankRewards(): Promise<CrankRewards | null> {
  if (MOCK) return { checkBatch: 6_000_000n, clearing: 25_000_000n, settlement: 4_600_000n, seedDraw: 3_000_000n };
  const config = await program.account.crankConfig.fetchNullable(crankConfigAddress);
  return config ? decodeCrankRewards(config.rewards) : null;
}

export async function fetchFeeConfig(): Promise<FeeConfig | null> {
  if (MOCK) return { listingFee: 20_000_000n, saleFeeBps: 100, treasury: PublicKey.default };
  const fees = await program.account.feeConfig.fetchNullable(feeConfigAddress);
  return fees ? { listingFee: big(fees.listingFee), saleFeeBps: fees.saleFeeBps, treasury: fees.treasury } : null;
}

// ---------------------------------------------------------------------------
// Auction maths, mirroring the program
// ---------------------------------------------------------------------------

/**
 * What `ticks` costs in SOL per whole token or per NFT. A token's price needs
 * its decimals; null until they are known.
 */
export function priceOf(a: Auction, ticks: bigint, decimals: number | null): Decimal | null {
  if (a.kind === "collection") return nftPrice(ticks);
  if (a.launch) return { mantissa: ticks, exponent: fdvExponent(a) };
  return decimals === null ? null : tokenPrice(ticks, a.priceUnit, decimals);
}

/**
 * A new token's prices read as its fully diluted value (FDV): the price per
 * token times its whole supply of 1,000,000,000, in SOL. A tick of price is
 * `LAUNCH_SUPPLY / priceUnit` lamports of FDV, so FDV in SOL is
 * ticks × 10^(15 - 9 - log10(priceUnit)).
 */
const fdvExponent = (a: Auction) => unitExponent(LAUNCH_SUPPLY) - 9 - unitExponent(a.priceUnit);

/** "0.0025 SOL", "20 SOL" (a new token's FDV), or an ellipsis while a token's decimals load. */
export function formatPrice(a: Auction, ticks: bigint, decimals: number | null): string {
  const price = priceOf(a, ticks, decimals);
  return price ? `${formatDecimal(price)} SOL` : "… SOL";
}

/** What a price reads as, whole: "0.0025 SOL per token", or "20 SOL FDV" for a new token. */
export function priceText(a: Auction, ticks: bigint, decimals: number | null, unit: string): string {
  return `${formatPrice(a, ticks, decimals)}${priceSuffix(a, unit)}`;
}

/** What follows a price: " per token", or " FDV" for a new token. */
export function priceSuffix(a: Auction, unit: string): string {
  return a.launch ? " FDV" : ` per ${unit}`;
}

/** The ticks of a typed price per token or per NFT, or a new token's FDV, rounded to a whole tick. */
export function ticksOf(a: Auction, sol: Decimal, decimals: number | null, round: "down" | "up"): bigint | null {
  if (a.kind === "collection") return nftPriceToTicks(sol, round);
  if (a.launch) return shift(sol.mantissa, sol.exponent - fdvExponent(a), round);
  return decimals === null ? null : tokenPriceToTicks(sol, a.priceUnit, decimals, round);
}

/** A new token's FDV in lamports at `ticks`, for terms that are not an auction yet. */
export function launchFdv(ticks: bigint, priceUnit: bigint): bigint {
  return (ticks * LAUNCH_SUPPLY) / priceUnit;
}

/** The highest price a bid can name, in SOL per token or NFT. */
export function maxPriceOf(a: Auction, decimals: number | null): Decimal | null {
  return priceOf(a, MAX_PRICE_TICKS, decimals);
}

export function emergencyOpensAt(a: Auction): number {
  return a.endTime + (a.launch ? LAUNCH_EMERGENCY_DELAY_SECS : EMERGENCY_DELAY_SECS);
}

/** The platform's cut of a sale, rounded down as the program does. */
export function saleFee(proceeds: bigint, feeBps: number): bigint {
  return (proceeds * BigInt(feeBps)) / 10_000n;
}

export function formatPercent(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, "")}%`;
}

export type Phase =
  | "upcoming"
  | "bidding"
  | "no-bids"
  | "checking"
  | "ready-to-clear"
  | "settling"
  | "settled"
  | "stalled"
  | "finished"
  | "cancelled";

export function phaseOf(a: Auction, now: number): Phase {
  if (a.status === "cancelled") return "cancelled";
  if (a.status === "finished") return "finished";
  if (a.status === "settling") return a.resolvedCount === a.bidCount ? "settled" : "settling";
  if (now < a.startTime) return "upcoming";
  if (now < a.endTime) return "bidding";
  if (a.bidCount === 0) return "no-bids";
  if (now >= emergencyOpensAt(a)) return "stalled";
  return a.checkedCount < a.bidCount ? "checking" : "ready-to-clear";
}

export function hasPending(pending: PublicKey, since: number, now: number, timeoutSecs: number): boolean {
  return !pending.equals(PublicKey.default) && now < since + timeoutSecs;
}

// ---------------------------------------------------------------------------
// Token info
// ---------------------------------------------------------------------------

export interface TokenInfo {
  mint: PublicKey;
  programId: PublicKey;
  decimals: number;
  supply: bigint;
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
  name: string | null;
  symbol: string | null;
  uri: string | null;
}

const tokenCache = new Map<string, Promise<TokenInfo>>();

export function fetchTokenInfo(mint: PublicKey): Promise<TokenInfo> {
  if (MOCK) return import("./mock").then((m) => m.mockToken(mint));
  const key = mint.toBase58();
  let entry = tokenCache.get(key);
  if (!entry) {
    entry = loadTokenInfo(mint).catch((e) => {
      tokenCache.delete(key);
      throw e;
    });
    tokenCache.set(key, entry);
  }
  return entry;
}

async function loadTokenInfo(mint: PublicKey): Promise<TokenInfo> {
  const account = await connection.getAccountInfo(mint);
  if (!account) throw new Error("Token not found");
  const programId = account.owner;
  const info = await getMint(connection, mint, "confirmed", programId);
  let name: string | null = null;
  let symbol: string | null = null;
  let uri: string | null = null;
  if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
    const meta = await getTokenMetadata(connection, mint, "confirmed", programId).catch(() => null);
    if (meta) {
      name = meta.name || null;
      symbol = meta.symbol || null;
      uri = meta.uri || null;
    }
  }
  return {
    mint,
    programId,
    decimals: info.decimals,
    supply: info.supply,
    mintAuthority: info.mintAuthority,
    freezeAuthority: info.freezeAuthority,
    name,
    symbol,
    uri,
  };
}

// ---------------------------------------------------------------------------
// Collections (Metaplex Core)
// ---------------------------------------------------------------------------

export interface CollectionInfo {
  address: PublicKey;
  name: string;
  uri: string;
  /** The auction while the sale runs; the seller once it is closed. */
  updateAuthority: PublicKey;
  minted: number;
}

/** Reads a Core `CollectionV1`: key, update authority, name, uri, counters. */
function parseCollection(address: PublicKey, data: Uint8Array): CollectionInfo | null {
  if (data.length < 1 + 32 + 8 || data[0] !== 5) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const text = (at: number): [string, number] => {
    const len = view.getUint32(at, true);
    return [new TextDecoder().decode(data.subarray(at + 4, at + 4 + len)), at + 4 + len];
  };
  const [name, afterName] = text(33);
  const [uri, afterUri] = text(afterName);
  return {
    address,
    name,
    uri,
    updateAuthority: new PublicKey(data.subarray(1, 33)),
    minted: view.getUint32(afterUri, true),
  };
}

export async function fetchCollectionInfo(address: PublicKey): Promise<CollectionInfo | null> {
  if (MOCK) return (await import("./mock")).mockCollection(address);
  const account = await connection.getAccountInfo(address);
  if (!account || !account.owner.equals(MPL_CORE_ID)) return null;
  return parseCollection(address, account.data);
}

/** Turns ipfs:// and ar:// links into https gateway links; null for anything else. */
export function browsableUri(uri: string): string | null {
  if (uri.startsWith("https://")) return uri;
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  if (uri.startsWith("ar://")) return `https://arweave.net/${uri.slice("ar://".length)}`;
  return null;
}

/**
 * The same Arweave file on an AR.IO gateway, which serves new uploads at once;
 * arweave.net takes a few minutes. Null for links elsewhere.
 */
function onFreshGateway(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "arweave.net") return null;
    return `${FRESH_ARWEAVE_GATEWAY}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

const quietFetch = (url: string, method = "GET") =>
  fetch(url, { method, credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8_000) });

/** Reads a JSON metadata file over https, from the fresh gateway if arweave.net does not serve it yet. */
async function loadJson(uri: string): Promise<Record<string, unknown> | null> {
  const url = browsableUri(uri);
  if (!url) return null;
  try {
    let response = await quietFetch(url);
    const fresh = response.ok ? null : onFreshGateway(url);
    if (fresh) response = await quietFetch(fresh);
    if (!response.ok) return null;
    const json = (await response.json()) as unknown;
    return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A link to an image named in metadata, from wherever it is served already; null unless https. */
async function servedImage(value: unknown): Promise<string | null> {
  const image = typeof value === "string" ? browsableUri(value) : null;
  if (!image) return null;
  // An image uploaded with the metadata may not be on arweave.net yet either.
  const freshImage = onFreshGateway(image);
  if (freshImage) {
    const found = await quietFetch(image, "HEAD").then((r) => r.ok, () => false);
    if (!found) return freshImage;
  }
  return image;
}

/** Caches what a loader finds; a miss is tried again next time, as a new upload may not be served yet. */
function cached<T>(load: (uri: string) => Promise<T | null>) {
  const cache = new Map<string, Promise<T | null>>();
  return (uri: string): Promise<T | null> => {
    let entry = cache.get(uri);
    if (!entry) {
      entry = load(uri);
      cache.set(uri, entry);
      entry.then((value) => {
        if (value === null) cache.delete(uri);
      });
    }
    return entry;
  };
}

/**
 * The image named in a metadata file, if it can be shown. The file is
 * fetched without cookies or referrer, and only https images are used.
 */
export const fetchMetadataImage = cached<string>(async (uri) => {
  if (MOCK) return (await import("./mock")).mockCollectionMetadata(uri).image;
  return servedImage((await loadJson(uri))?.image);
});

const text = (value: unknown, max = 2_000) =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
const httpsLink = (value: unknown) => {
  const link = text(value, 300);
  return link && /^https:\/\/[^\s]+$/.test(link) ? link : null;
};

/** What a collection's metadata says about it, as Veiling's launch page writes it. */
export interface CollectionMetadata {
  description: string | null;
  image: string | null;
  banner: string | null;
  website: string | null;
  x: string | null;
  /** Launched all at once ("drop") or item by item ("collection"); null if not said. */
  kind: "drop" | "collection" | null;
  /** Whether the art was hidden until after the sale. */
  hidden: boolean;
  /** Hidden drops: the image shown until the reveal. */
  preview: string | null;
  /** Hidden drops launched through Veiling: the id of the sealed art's index. */
  sealed: string | null;
}

export const fetchCollectionMetadata = cached<CollectionMetadata>(async (uri) => {
  if (MOCK) return (await import("./mock")).mockCollectionMetadata(uri);
  const json = await loadJson(uri);
  if (!json) return null;
  const veiling = (json.veiling && typeof json.veiling === "object" ? json.veiling : {}) as Record<string, unknown>;
  const links = (veiling.links && typeof veiling.links === "object" ? veiling.links : {}) as Record<string, unknown>;
  const [image, banner, preview] = await Promise.all([
    servedImage(json.image),
    servedImage(json.banner_image),
    servedImage(veiling.preview),
  ]);
  const sealed = text(veiling.sealed, 64);
  return {
    description: text(json.description),
    image,
    banner,
    website: httpsLink(json.external_url),
    x: httpsLink(links.x),
    kind: veiling.kind === "drop" || veiling.kind === "collection" ? veiling.kind : null,
    hidden: veiling.hidden === true,
    preview,
    sealed: sealed && /^[A-Za-z0-9_-]{43}$/.test(sealed) ? sealed : null,
  };
});

/** One NFT's metadata, as far as it can be shown. */
export interface NftMetadata {
  name: string | null;
  description: string | null;
  image: string | null;
  externalUrl: string | null;
  attributes: { trait: string; value: string }[];
}

export const fetchNftMetadata = cached<NftMetadata>(async (uri) => {
  if (MOCK) return (await import("./mock")).mockNftMetadata(uri);
  const json = await loadJson(uri);
  if (!json) return null;
  const attributes = Array.isArray(json.attributes)
    ? (json.attributes as unknown[]).flatMap((entry) => {
        const a = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
        const value = typeof a.value === "number" ? String(a.value) : text(a.value, 200);
        return value === null ? [] : [{ trait: text(a.trait_type, 100) ?? "", value }];
      })
    : [];
  return {
    name: text(json.name, 200),
    description: text(json.description),
    image: await servedImage(json.image),
    externalUrl: httpsLink(json.external_url),
    attributes: attributes.slice(0, 50),
  };
});

/** Where NFT `number` (from 0) of a collection auction reads its metadata (`nft_uri` in the program). */
export function nftMetadataUri(a: Auction, number: number): string {
  return a.uriPerItem ? `${a.itemUri}${number}.json` : a.itemUri;
}

// ---------------------------------------------------------------------------
// New tokens (fair launches)
// ---------------------------------------------------------------------------

/**
 * An amount of a new token as a share of its whole supply: "50%", "49.5%",
 * "0.02%". Rounded to two decimals; anything above zero shows at least "<0.01%".
 */
export function supplyShare(amount: bigint): string {
  const hundredths = Number((amount * 10_000n + LAUNCH_SUPPLY / 2n) / LAUNCH_SUPPLY);
  if (amount > 0n && hundredths === 0) return "<0.01%";
  return `${(hundredths / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/** A fair launch's token before it is made. */
export interface LaunchTokenInfo {
  name: string;
  symbol: string;
  uri: string;
}

/**
 * A fair launch's token-to-be, or null once it was made (graduating closes
 * the record: the token itself then carries its name) or never will be (the
 * launch closed).
 */
export async function fetchLaunchToken(auction: PublicKey): Promise<LaunchTokenInfo | null> {
  if (MOCK) return import("./mock").then((m) => m.mockLaunchToken(auction));
  const raw = await program.account.launchToken.fetchNullable(launchTokenAddress(auction));
  return raw ? { name: raw.name, symbol: raw.symbol, uri: raw.uri } : null;
}

/**
 * What a fair launch sells: the token once made, or the details it will be
 * made with, as the same `TokenInfo` (6 decimals, nothing minted yet).
 */
export async function fetchSaleTokenInfo(a: Auction): Promise<TokenInfo> {
  if (!a.launch) return fetchTokenInfo(a.mint);
  const made = await fetchTokenInfo(a.mint).catch(() => null);
  if (made) return made;
  const token = await fetchLaunchToken(a.address);
  return {
    mint: a.mint,
    programId: TOKEN_2022_PROGRAM_ID,
    decimals: LAUNCH_DECIMALS,
    supply: 0n,
    mintAuthority: a.address,
    freezeAuthority: null,
    name: token?.name ?? null,
    symbol: token?.symbol ?? null,
    uri: token?.uri ?? null,
  };
}

/**
 * The terms of a fair launch with a graduation target of `targetLamports`:
 * the minimum price is what makes selling the whole half raise the target,
 * rounded up to a whole price tick, so the real target is never lower.
 */
export function launchSaleTerms(targetLamports: bigint): { priceUnit: bigint; minPrice: bigint; target: bigint } | null {
  if (targetLamports <= 0n) return null;
  // SOL per whole token: target / 500,000,000 tokens = target lamports x 2 x 10^-18.
  const perToken = { mantissa: targetLamports * 2n, exponent: -18 };
  const chosen = choosePriceUnit(perToken, LAUNCH_DECIMALS);
  if (!chosen) return null;
  const units = LAUNCH_SALE_SUPPLY / chosen.priceUnit;
  if (units === 0n) return null;
  const minPrice = (targetLamports + units - 1n) / units;
  if (minPrice > MAX_PRICE_TICKS) return null;
  return { priceUnit: chosen.priceUnit, minPrice, target: units * minPrice };
}

/**
 * A rough wait, in seconds, from the end of bidding until a launch's token
 * and pool exist: every batch of four bids checked, the price found (one
 * step, or a step per page and pass), every batch settled, then the token
 * and the pool. Each step is one MPC computation or transaction, run one
 * after another; the real time depends on the network.
 */
export function launchSettleSecs(bids: number, pages: number): number {
  const batches = Math.ceil(bids / 4);
  const clearing = pages <= 1 ? 1 : 8 * (pages - 1) + 1;
  const SECS_PER_COMPUTATION = 20;
  return (2 * batches + clearing) * SECS_PER_COMPUTATION + 2 * 15;
}
