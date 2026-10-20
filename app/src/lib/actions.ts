import { BN } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  ExtensionType,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, createUpdateAuthorityInstruction, pack } from "@solana/spl-token-metadata";
import {
  BATCH_SIZE,
  CP_AMM_ID,
  LP_COMPUTE_UNITS,
  MAX_NFTS_PER_CLAIM,
  MAX_PREPAID_PAGES,
  MPL_CORE_ID,
  PAGE_BIDS,
  QUEUE_COMPUTE_UNITS,
  WSOL_MINT,
} from "../config";
import { computationAccounts, encryptBid, newComputationOffset } from "./arcium";
import { closeNoteInstruction, hasChainNote } from "./bidNotes";
import {
  type Auction,
  type Bid,
  type FeeConfig,
  type LiquidityPlan,
  dammEventAuthority,
  dammNftAccountAddress,
  dammPoolAddress,
  dammPoolAuthority,
  dammPositionAddress,
  dammVaultAddress,
  liquidityPlanAddress,
  lpAuthorityAddress,
  assetAddress,
  auctionAddress,
  bidAddress,
  bidCapacity,
  bookAddress,
  bookIndexAddress,
  canGrow,
  collectionAddress,
  configAddress,
  connection,
  evictionThreshold,
  extraPageAddresses,
  feeConfigAddress,
  fetchBidAtIndex,
  fetchBookIndex,
  fetchClearingFold,
  fetchPageDeposits,
  findSmallestPage,
  foldAddress,
  itemListAddress,
  nftsReady,
  pageOf,
  pagesInUse,
  program,
  randomU64,
  revealMissed,
  sharesAreFinal,
  allowlistAddress,
  fetchAllowlistInfo,
  fetchParticipant,
  participantAddress,
} from "./chain";
import { allowlistProof, fetchAllowlist } from "./allowlist";
import { type ListedItem, itemBatches } from "./items";

// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

export interface NewToken {
  name: string;
  symbol: string;
  uri: string;
  decimals: number;
  /** Total supply in base units, minted once to the creator. */
  supply: bigint;
}

/**
 * Creates a Token-2022 token with on-chain metadata, mints the whole supply to
 * the creator, then permanently removes the mint and metadata authorities so
 * nobody can ever mint more or change the details.
 */
export async function buildCreateToken(owner: PublicKey, token: NewToken) {
  const mint = Keypair.generate();
  const metadata = {
    updateAuthority: owner,
    mint: mint.publicKey,
    name: token.name,
    symbol: token.symbol,
    uri: token.uri,
    additionalMetadata: [] as [string, string][],
  };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);
  const ownerAta = getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: owner,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(mint.publicKey, null, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, token.decimals, owner, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint.publicKey,
      updateAuthority: owner,
      mint: mint.publicKey,
      mintAuthority: owner,
      name: token.name,
      symbol: token.symbol,
      uri: token.uri,
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ownerAta,
      owner,
      mint.publicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    createMintToInstruction(mint.publicKey, ownerAta, owner, token.supply, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(
      mint.publicKey,
      owner,
      AuthorityType.MintTokens,
      null,
      [],
      TOKEN_2022_PROGRAM_ID
    ),
    createUpdateAuthorityInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint.publicKey,
      oldAuthority: owner,
      newAuthority: null,
    })
  );
  return { tx, mint };
}

// ---------------------------------------------------------------------------
// Auction lifecycle
// ---------------------------------------------------------------------------

/** A token sale's terms; see `create_auction`. */
export interface TokenSaleTerms {
  /** Base units for sale. */
  supply: bigint;
  /** Base units one price refers to, a power of ten (see `choosePriceUnit`). */
  priceUnit: bigint;
  /** Lowest price that counts, in ticks: lamports per `priceUnit`. */
  minPrice: bigint;
  /** Smallest deposit, and smallest private budget, a bid may make, in lamports. */
  minDeposit: bigint;
  durationSecs: number;
  /** When bidding opens (unix seconds); 0 for right away. */
  startTime: number;
}

/** A collection sale's terms; see `create_collection_auction`. */
export interface CollectionSaleTerms {
  supply: number;
  /** Lowest price per NFT that counts, in ticks of 1_000 lamports. */
  minPrice: bigint;
  maxPerBid: number;
  durationSecs: number;
  /** When bidding opens (unix seconds); 0 for right away. */
  startTime: number;
}

/** What a collection auction sells; see `create_collection_auction`. */
export interface CollectionTerms {
  name: string;
  uri: string;
  itemName: string;
  itemUri: string;
  uriPerItem: boolean;
  royaltyBps: number;
  /** The art stays hidden until the seller reveals it after the sale. */
  hidden: boolean;
}

const bn = (v: bigint | number) => new BN(v.toString());

/** The seller accepts exactly the fees the page showed; higher fees make opening fail. */
const acceptedFees = (fees: FeeConfig) => ({ listingFee: bn(fees.listingFee), saleFeeBps: fees.saleFeeBps });

/**
 * A token sale's optional rules: a minimum raise (lamports the winners must
 * pay in all), an allowlist and, with an allowlist, a cap on each wallet's
 * deposits (lamports). Fixed when the sale opens.
 */
export interface SaleRules {
  minRaise: bigint;
  walletCap: bigint;
  allowlist: boolean;
}

export const NO_RULES: SaleRules = { minRaise: 0n, walletCap: 0n, allowlist: false };

export async function buildCreateAuction(
  seller: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  terms: TokenSaleTerms,
  fees: FeeConfig,
  liquidity: LiquidityTerms | null = null,
  rules: SaleRules = NO_RULES
) {
  const seed = randomU64();
  const auction = auctionAddress(seller, seed);
  const tx = await program.methods
    .createAuction(
      seed,
      {
        supply: bn(terms.supply),
        priceUnit: bn(terms.priceUnit),
        minPrice: Number(terms.minPrice),
        minDeposit: bn(terms.minDeposit),
        durationSecs: bn(terms.durationSecs),
        startTime: bn(terms.startTime),
      },
      acceptedFees(fees),
      { minRaise: bn(rules.minRaise), walletCap: bn(rules.walletCap), allowlist: rules.allowlist }
    )
    .accountsPartial({
      seller,
      auction,
      book: bookAddress(auction),
      mint,
      sellerTokenAccount: getAssociatedTokenAddressSync(mint, seller, false, tokenProgram),
      vault: getAssociatedTokenAddressSync(mint, auction, true, tokenProgram),
      feeConfig: feeConfigAddress,
      treasury: fees.treasury,
      tokenProgram,
    })
    .transaction();
  // The plan goes in the same transaction, so it is fixed before any bid.
  if (liquidity) tx.add(await planLiquidityInstruction(seller, auction, mint, tokenProgram, liquidity));
  return { tx, auction };
}

/**
 * Records a sale's allowlist: the root of its wallets' tree and the link to
 * the published list (`publishAllowlist`). Only the seller, once, before the
 * first bid; until then nobody can bid.
 */
export function buildSetAllowlist(seller: PublicKey, auction: PublicKey, root: Uint8Array, uri: string) {
  return program.methods
    .setAllowlist(Array.from(root), uri)
    .accountsPartial({ seller, auction, list: allowlistAddress(auction) })
    .transaction();
}

/**
 * Where a wallet stands in a sale with an allowlist: whether the list holds
 * it, whether it has joined, and what it has deposited so far.
 */
export interface Admission {
  listed: boolean;
  joined: boolean;
  deposited: bigint;
}

export async function fetchAdmission(auction: Auction, wallet: PublicKey): Promise<Admission> {
  const participant = await fetchParticipant(auction.address, wallet);
  if (participant) return { listed: true, joined: true, deposited: participant.deposited };
  const info = await fetchAllowlistInfo(auction.address);
  if (!info) return { listed: false, joined: false, deposited: 0n };
  const wallets = await fetchAllowlist(info.uri, info.root);
  return { listed: wallets.some((w) => w.equals(wallet)), joined: false, deposited: 0n };
}

/**
 * Admits `wallet` to a sale with an allowlist, with its proof from the
 * published list. Sent once, before the wallet's first bid; null when the
 * sale has no allowlist or the wallet already joined.
 */
export async function buildJoinAuction(wallet: PublicKey, auction: Auction): Promise<Transaction | null> {
  if (!auction.allowlist) return null;
  if (await fetchParticipant(auction.address, wallet)) return null;
  const info = await fetchAllowlistInfo(auction.address);
  if (!info) throw new Error("The seller has not published this sale's allowlist yet.");
  const proof = allowlistProof(await fetchAllowlist(info.uri, info.root), wallet);
  if (!proof) throw new Error("This wallet is not on the sale's allowlist.");
  return program.methods
    .joinAuction(proof.map((node) => Array.from(node)))
    .accountsPartial({
      wallet,
      auction: auction.address,
      list: allowlistAddress(auction.address),
      participant: participantAddress(auction.address, wallet),
    })
    .transaction();
}

/** A wallet's admission, which its bids in a sale with an allowlist pass. */
const participantIfListed = (auction: Auction, wallet: PublicKey) =>
  auction.allowlist ? participantAddress(auction.address, wallet) : null;

// ---------------------------------------------------------------------------
// Auto-liquidity
// ---------------------------------------------------------------------------

/** What a seller chooses for the pool their token sale opens. */
export interface LiquidityTerms {
  /** Share of the net proceeds, in bps (20% to 100%). */
  lpBps: number;
  /** The least SOL the pool gets, in lamports. */
  floor: bigint;
  /** The pool's trading fee after the anti-sniper fee, in bps. */
  tradeFeeBps: number;
}

/** The plan's authority and its two token accounts. */
function lpAccounts(auction: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  const lpAuthority = lpAuthorityAddress(auction);
  return {
    lpAuthority,
    reserve: getAssociatedTokenAddressSync(mint, lpAuthority, true, tokenProgram),
    lpWsol: getAssociatedTokenAddressSync(WSOL_MINT, lpAuthority, true, TOKEN_PROGRAM_ID),
  };
}

async function planLiquidityInstruction(
  seller: PublicKey,
  auction: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  terms: LiquidityTerms
) {
  return program.methods
    .planLiquidity(terms.lpBps, bn(terms.floor), terms.tradeFeeBps)
    .accountsPartial({
      seller,
      auction,
      plan: liquidityPlanAddress(auction),
      ...lpAccounts(auction, mint, tokenProgram),
      mint,
      wsolMint: WSOL_MINT,
      sellerTokenAccount: getAssociatedTokenAddressSync(mint, seller, false, tokenProgram),
      tokenProgram,
      wsolTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/**
 * Opens the planned pool once every bid is settled, locks it for good and
 * pays the seller the rest. Anyone can send it; it needs the new position
 * NFT's keypair as a signer.
 */
export async function buildBootstrapLiquidity(payer: PublicKey, auction: Auction) {
  const nft = Keypair.generate();
  const pool = dammPoolAddress(auction.mint);
  const sellerTokenAccount = getAssociatedTokenAddressSync(auction.mint, auction.seller, false, auction.tokenProgram);
  const tx = await program.methods
    .bootstrapLiquidity()
    .accountsPartial({
      cranker: payer,
      auction: auction.address,
      plan: liquidityPlanAddress(auction.address),
      ...lpAccounts(auction.address, auction.mint, auction.tokenProgram),
      seller: auction.seller,
      treasury: auction.treasury,
      mint: auction.mint,
      wsolMint: WSOL_MINT,
      sellerTokenAccount,
      positionNftMint: nft.publicKey,
      positionNftAccount: dammNftAccountAddress(nft.publicKey),
      pool,
      position: dammPositionAddress(nft.publicKey),
      tokenAVault: dammVaultAddress(auction.mint, pool),
      tokenBVault: dammVaultAddress(WSOL_MINT, pool),
      poolAuthority: dammPoolAuthority,
      eventAuthority: dammEventAuthority,
      cpAmmProgram: CP_AMM_ID,
      tokenProgram: auction.tokenProgram,
      wsolTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([
      computeLimit(LP_COMPUTE_UNITS.bootstrap),
      // The seller's token account gets the unused reserve; it may be closed.
      createAssociatedTokenAccountIdempotentInstruction(payer, sellerTokenAccount, auction.seller, auction.mint, auction.tokenProgram),
    ])
    .transaction();
  return { tx, signers: [nft] };
}

/** Claims the pool's trading fees: 80% to the seller, 20% to the platform. Anyone can send it. */
export function buildClaimPoolFees(payer: PublicKey, plan: LiquidityPlan) {
  return program.methods
    .claimPoolFees()
    .accountsPartial({
      cranker: payer,
      plan: plan.address,
      ...lpAccounts(plan.auction, plan.mint, plan.tokenProgram),
      seller: plan.seller,
      treasury: plan.treasury,
      mint: plan.mint,
      wsolMint: WSOL_MINT,
      pool: plan.pool,
      position: plan.position,
      positionNftAccount: dammNftAccountAddress(plan.positionNftMint),
      tokenAVault: dammVaultAddress(plan.mint, plan.pool),
      tokenBVault: dammVaultAddress(WSOL_MINT, plan.pool),
      poolAuthority: dammPoolAuthority,
      eventAuthority: dammEventAuthority,
      cpAmmProgram: CP_AMM_ID,
      tokenProgram: plan.tokenProgram,
      wsolTokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([computeLimit(LP_COMPUTE_UNITS.claimFees)])
    .transaction();
}

/** Gives the reserve and the rent deposit back when no pool will open. */
async function releaseLiquidityInstruction(auction: Auction) {
  return program.methods
    .releaseLiquidity()
    .accountsPartial({
      seller: auction.seller,
      auction: auction.address,
      plan: liquidityPlanAddress(auction.address),
      ...lpAccounts(auction.address, auction.mint, auction.tokenProgram),
      mint: auction.mint,
      sellerTokenAccount: getAssociatedTokenAddressSync(auction.mint, auction.seller, false, auction.tokenProgram),
      tokenProgram: auction.tokenProgram,
      wsolTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export async function buildReleaseLiquidity(auction: Auction) {
  return new Transaction().add(await releaseLiquidityInstruction(auction));
}

/**
 * Refunds a bid of a sale that missed its pool's minimum: the whole deposit
 * and the account's rent, without any computation. Anyone can send it.
 */
export async function buildRefundFailedBid(payer: PublicKey, bid: Bid) {
  const refund = await program.methods
    .refundFailedBid()
    .accountsPartial({ bidder: bid.bidder, auction: bid.auction, bid: bid.address })
    .instruction();
  return new Transaction().add(
    refund,
    ...(await noteCloseAfter(payer, bid)),
    ...(await participantCloseAfter(bid.auction, bid.bidder))
  );
}

/**
 * Opens a collection auction at the address `seed` gives. With `named`, its
 * item list (made by `buildItemList` for the same seed) is sealed into it.
 */
export async function buildCreateCollectionAuction(
  seller: PublicKey,
  seed: BN,
  terms: CollectionSaleTerms,
  collection: CollectionTerms,
  fees: FeeConfig,
  named: boolean
) {
  const auction = auctionAddress(seller, seed);
  const tx = await program.methods
    .createCollectionAuction(
      seed,
      {
        supply: bn(terms.supply),
        minPrice: Number(terms.minPrice),
        maxPerBid: terms.maxPerBid,
        durationSecs: bn(terms.durationSecs),
        startTime: bn(terms.startTime),
      },
      acceptedFees(fees),
      collection
    )
    .accountsPartial({
      seller,
      auction,
      book: bookAddress(auction),
      collection: collectionAddress(auction),
      feeConfig: feeConfigAddress,
      treasury: fees.treasury,
      mplCoreProgram: MPL_CORE_ID,
      itemList: named ? itemListAddress(auction) : null,
    })
    .transaction();
  return { tx, auction };
}

/**
 * Adds pages to an auction's bid book ahead of time, from page `from` up to
 * `to` (from 1, at most 3), in one transaction: each holds `PAGE_BIDS` more
 * bids. Only the seller, until bidding ends; the rent comes back when the
 * auction is closed. Further pages open on their own as the book fills.
 */
export async function buildAddBookPages(seller: PublicKey, auction: PublicKey, from: number, to: number) {
  if (from < 1 || to >= MAX_PREPAID_PAGES || from > to) throw new Error("A seller can add at most three pages ahead of time.");
  const tx = new Transaction();
  for (let page = from; page <= to; page++) {
    tx.add(
      await program.methods
        .addBookPage(page)
        .accountsPartial({
          seller,
          auction,
          pageBook: bookAddress(auction, page),
          fold: foldAddress(auction),
          book: bookAddress(auction),
          bookIndex: bookIndexAddress(auction),
        })
        .instruction()
    );
  }
  return tx;
}

/** The book's index, which a book with more than one page passes along. */
const indexIfPaged = (auction: Auction) => (auction.extraPages > 0 ? bookIndexAddress(auction.address) : null);

/** The auction's pages after the first, as remaining accounts. */
const pageAccounts = (auction: Auction, isWritable: boolean) =>
  extraPageAddresses(auction).map((pubkey) => ({ pubkey, isSigner: false, isWritable }));

/**
 * The transactions that write a collection's item list for the auction the
 * seller will open with `seed`: the first starts the list, every one adds a
 * batch of items in order. An unsealed list left by an earlier attempt is
 * closed first, so the list always holds exactly these items.
 */
export async function buildItemList(seller: PublicKey, seed: BN, items: ListedItem[], leftover: boolean) {
  const auction = auctionAddress(seller, seed);
  const itemList = itemListAddress(auction);
  const txs: Transaction[] = [];
  for (const [k, batch] of itemBatches(items).entries()) {
    const tx = new Transaction();
    if (k === 0) {
      if (leftover) {
        tx.add(await program.methods.closeItemList().accountsPartial({ seller, itemList }).instruction());
      }
      tx.add(await program.methods.initItemList(seed).accountsPartial({ seller, auction, itemList }).instruction());
    }
    tx.add(await program.methods.addItems(batch).accountsPartial({ seller, itemList }).instruction());
    txs.push(tx);
  }
  return txs;
}

/** Reveals a hidden collection once bidding has ended; only its seller can. */
export function buildRevealCollection(auction: Auction) {
  return program.methods
    .revealCollection()
    .accountsPartial({ seller: auction.seller, auction: auction.address })
    .transaction();
}

function refundUnrevealedInstruction(auction: Auction, bid: Bid) {
  return program.methods.refundUnrevealed().accountsPartial({ auction: auction.address, bid: bid.address }).instruction();
}

export interface Eviction {
  /** The bid with the smallest deposit, which a new bid would replace. */
  bid: Bid;
  /** The least a new bid must deposit to replace it. */
  minimumDeposit: bigint;
}

/** For a full auction, what a new bid has to beat; `null` while slots are free. */
export async function findEviction(auction: Auction): Promise<Eviction | null> {
  // A full book with pages left to open grows instead.
  if (auction.bidCount < bidCapacity(auction) || canGrow(auction)) return null;
  // The book's index knows each page's smallest deposit, so only that page is read.
  const { page } = await findSmallestPage(auction);
  const deposits = await fetchPageDeposits(auction, page);
  let slot = 0;
  for (let i = 1; i < deposits.length; i++) if (deposits[i] < deposits[slot]) slot = i;
  const index = page * PAGE_BIDS + slot;
  const bid = await fetchBidAtIndex(auction.address, index);
  if (!bid || bid.deposit !== deposits[slot]) {
    throw new Error("Could not find the bid with the smallest deposit. Try again in a moment.");
  }
  return { bid, minimumDeposit: evictionThreshold(deposits[slot]) };
}

/**
 * A sealed bid: `price` is the most the bidder pays, in the auction's price
 * ticks. `quantity` is sealed too: a token bid's budget in lamports, which
 * the deposit must cover, or the NFTs a collection bid asks for, which the
 * deposit must cover at its price. The deposit is public; it may be larger
 * than it needs to be, to hide the bid.
 */
export async function buildPlaceBid(
  bidder: PublicKey,
  auction: Auction,
  price: bigint,
  quantity: bigint,
  deposit: bigint
) {
  if (deposit < auction.minDeposit) throw new Error("The deposit is below this auction's minimum.");
  if (auction.kind === "token" && (quantity < auction.minDeposit || quantity > deposit)) {
    throw new Error("The budget must be at least the minimum and covered by the deposit.");
  }
  const eviction = await findEviction(auction);
  if (eviction && deposit < eviction.minimumDeposit) {
    throw new Error("This auction is full. Raise your deposit to replace the smallest bid.");
  }
  if (auction.allowlist) {
    const admission = await fetchParticipant(auction.address, bidder);
    // The program checks the cap; the form shows what is left of it.
    if (!admission) throw new Error("This wallet is not on the sale's allowlist, or has not joined the sale yet.");
  }
  const seed = randomU64();
  const bid = bidAddress(auction.address, bidder, seed);
  // The program only accepts a ciphertext encrypted under this bid's own
  // address-derived nonce, so the address must be known before encrypting.
  const enc = await encryptBid(price, quantity, bid);
  // The bid commits to the terms shown to the bidder; the program refuses it
  // if the auction at this address has any other terms.
  const terms = {
    mint: auction.mint,
    supply: bn(auction.supply),
    priceUnit: bn(auction.priceUnit),
    priceScale: bn(auction.priceScale),
    minPrice: Number(auction.minPrice),
    minDeposit: bn(auction.minDeposit),
    maxPerBid: auction.maxPerBid,
    endTime: bn(auction.endTime),
    minRaise: bn(auction.minRaise),
  };
  // A full book that can still grow opens its next page first, in the same
  // transaction, and the bid lands on it. The settlement fund pays the
  // page's rent back to the bidder.
  const growing = auction.bidCount >= bidCapacity(auction) && canGrow(auction);
  const nextPage = auction.extraPages + 1;
  // The page the bid lands on: the next free place (on the page opened for
  // it, if need be) or the place of the bid it replaces.
  const index = eviction ? eviction.bid.index : auction.bidCount;
  const paged = growing || auction.extraPages > 0;
  const tx = await program.methods
    .placeBid(
      seed,
      terms,
      enc.priceCiphertext,
      enc.quantityCiphertext,
      enc.clientPublicKey,
      enc.clientPublicKeyEdwardsY,
      enc.nonce,
      bn(deposit)
    )
    .accountsPartial({
      bidder,
      auction: auction.address,
      book: bookAddress(auction.address, pageOf(index)),
      bookIndex: paged ? bookIndexAddress(auction.address) : null,
      bid,
      evictedBid: eviction ? eviction.bid.address : null,
      evictedBidder: eviction ? eviction.bid.bidder : null,
      participant: participantIfListed(auction, bidder),
      // A wallet replacing its own bid passes its admission once.
      evictedParticipant:
        eviction && !eviction.bid.bidder.equals(bidder) ? participantIfListed(auction, eviction.bid.bidder) : null,
    })
    .preInstructions(
      growing
        ? [
            await program.methods
              .openBookPage(nextPage)
              .accountsPartial({
                payer: bidder,
                auction: auction.address,
                pageBook: bookAddress(auction.address, nextPage),
                fold: foldAddress(auction.address),
                book: bookAddress(auction.address),
                bookIndex: bookIndexAddress(auction.address),
              })
              .instruction(),
          ]
        : []
    )
    .transaction();
  return { tx, bid, evicted: eviction?.bid ?? null };
}

/**
 * Re-seals an open bid with a new price and size, under a fresh key, and adds
 * `extraDeposit` to its deposit. The program cannot see inside the sealed bid,
 * so it only makes sure the deposit never shrinks; the app only offers raising
 * the price and size. The new deposit must still cover the new bid.
 */
export async function buildIncreaseBid(
  bidder: PublicKey,
  auction: Auction,
  bid: Bid,
  price: bigint,
  quantity: bigint,
  extraDeposit: bigint
) {
  const deposit = bid.deposit + extraDeposit;
  if (auction.kind === "token" && (quantity < auction.minDeposit || quantity > deposit)) {
    throw new Error("The budget must be at least the minimum and covered by the deposit.");
  }
  if (auction.kind === "collection" && price * quantity * auction.priceScale > deposit) {
    throw new Error("The deposit must cover the price for every NFT.");
  }
  const enc = await encryptBid(price, quantity, bid.address);
  return program.methods
    .increaseBid(
      enc.priceCiphertext,
      enc.quantityCiphertext,
      enc.clientPublicKey,
      enc.clientPublicKeyEdwardsY,
      enc.nonce,
      bn(extraDeposit)
    )
    .accountsPartial({
      bidder,
      auction: auction.address,
      book: bookAddress(auction.address, pageOf(bid.index)),
      bookIndex: indexIfPaged(auction),
      bid: bid.address,
      participant: participantIfListed(auction, bidder),
    })
    .transaction();
}

const computeLimit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });

/** Checks the next batch of bids; `bids` must be the auction's bids sorted by index. */
export async function buildCheckBatch(payer: PublicKey, auction: Auction, bids: Bid[]) {
  const batch = bids.filter((b) => b.index >= auction.checkedCount).slice(0, BATCH_SIZE);
  const offset = newComputationOffset();
  const tx = await program.methods
    .checkBatch(offset)
    .accountsPartial({
      payer,
      auction: auction.address,
      book: bookAddress(auction.address, pageOf(auction.checkedCount)),
      ...computationAccounts("check_bids_v2", offset),
    })
    .remainingAccounts(batch.map((b) => ({ pubkey: b.address, isSigner: false, isWritable: false })))
    .preInstructions([computeLimit(QUEUE_COMPUTE_UNITS.check)])
    .transaction();
  return { tx, count: batch.length };
}

/**
 * The next step towards the clearing price: the whole clearing in one step
 * while the bids fit on one page, else the next step of the clearing across
 * pages (`foldTotalSteps` in all).
 */
export async function buildFindClearing(payer: PublicKey, auction: Auction) {
  const offset = newComputationOffset();
  if (pagesInUse(auction) === 1) {
    return program.methods
      .findClearing(offset)
      .accountsPartial({
        payer,
        auction: auction.address,
        book: bookAddress(auction.address),
        ...computationAccounts("clear_price_v2", offset),
      })
      .preInstructions([computeLimit(QUEUE_COMPUTE_UNITS.clear)])
      .transaction();
  }
  const fold = await fetchClearingFold(auction);
  if (!fold) throw new Error("This auction's clearing state is missing.");
  return program.methods
    .foldClearing(offset)
    .accountsPartial({
      payer,
      auction: auction.address,
      fold: foldAddress(auction.address),
      book: bookAddress(auction.address, fold.page),
      ...computationAccounts("fold_batch_v2", offset),
    })
    .preInstructions([computeLimit(QUEUE_COMPUTE_UNITS.fold)])
    .transaction();
}

export async function buildSettleBid(payer: PublicKey, auction: Auction, bid: Bid) {
  const offset = newComputationOffset();
  return program.methods
    .settleBid(offset)
    .accountsPartial({
      payer,
      auction: auction.address,
      bid: bid.address,
      book: bookAddress(auction.address, pageOf(bid.index)),
      ...computationAccounts("award_bid_v2", offset),
    })
    .preInstructions([computeLimit(QUEUE_COMPUTE_UNITS.settle)])
    .transaction();
}

/**
 * Decides the bids of one batch record together (`settle_batch`): one
 * computation for up to four bids. `batch` must be those bids in index
 * order, from a multiple of four, all sealed and idle.
 */
export async function buildSettleBatch(payer: PublicKey, auction: Auction, batch: Bid[]) {
  const offset = newComputationOffset();
  return program.methods
    .settleBatch(offset)
    .accountsPartial({
      payer,
      auction: auction.address,
      book: bookAddress(auction.address, pageOf(batch[0].index)),
      ...computationAccounts("award_batch", offset),
    })
    .remainingAccounts(batch.map((b) => ({ pubkey: b.address, isSigner: false, isWritable: true })))
    .preInstructions([computeLimit(QUEUE_COMPUTE_UNITS.settleBatch)])
    .transaction();
}

/**
 * The bids `bid` settles with: its whole batch (the bids checked with it)
 * when every one of them is still sealed and idle, else just itself.
 */
export function settlementBatch(auction: Auction, bid: Bid, bids: Bid[]): Bid[] {
  const first = bid.index - (bid.index % BATCH_SIZE);
  const count = Math.min(BATCH_SIZE, auction.bidCount - first);
  const batch = Array.from({ length: count }, (_, k) => bids.find((b) => b.index === first + k));
  const whole = batch.every((b) => b && b.status === "sealed" && b.pendingComputation.equals(PublicKey.default));
  return whole ? (batch as Bid[]) : [bid];
}

/** Settles `bid`, with the rest of its batch in one computation when it can (`settlementBatch`). */
export async function buildSettle(payer: PublicKey, auction: Auction, bid: Bid, bids: Bid[]) {
  const batch = settlementBatch(auction, bid, bids);
  return batch.length > 1 ? buildSettleBatch(payer, auction, batch) : buildSettleBid(payer, auction, bid);
}

/**
 * Has Arcium draw the seed that shuffles a collection's NFTs among its
 * winners. Anyone can send it once every bid is settled.
 */
export async function buildDrawSeed(payer: PublicKey, auction: Auction) {
  const offset = newComputationOffset();
  return program.methods
    .drawNftSeed(offset)
    .accountsPartial({
      payer,
      auction: auction.address,
      ...computationAccounts("draw_seed", offset),
    })
    .preInstructions([computeLimit(QUEUE_COMPUTE_UNITS.draw)])
    .transaction();
}

function finalizeShareInstruction(auction: Auction, bid: Bid) {
  return program.methods
    .finalizeShare()
    .accountsPartial({
      auction: auction.address,
      book: bookAddress(auction.address, pageOf(bid.index)),
      bid: bid.address,
      bookIndex: indexIfPaged(auction),
    })
    .instruction();
}

/** Pages counted per transaction by `tallyTransactions`. */
const TALLIES_PER_TX = 4;

/**
 * A book with more than one page counts its bids at the clearing price page
 * by page first (`tally_clearing_page`), so each share can be worked out
 * without reading every page. Returns the transactions still needed, in
 * order; none for a one-page book or once every page is counted.
 */
async function tallyTransactions(auction: Auction): Promise<Transaction[]> {
  const index = await fetchBookIndex(auction);
  if (!index) return [];
  const pages = pagesInUse(auction);
  const txs: Transaction[] = [];
  for (let page = index.talliedPages; page < pages; page += TALLIES_PER_TX) {
    const tx = new Transaction();
    for (let p = page; p < Math.min(pages, page + TALLIES_PER_TX); p++) {
      tx.add(
        await program.methods
          .tallyClearingPage()
          .accountsPartial({
            auction: auction.address,
            book: bookAddress(auction.address, p),
            bookIndex: bookIndexAddress(auction.address),
          })
          .instruction()
      );
    }
    txs.push(tx);
  }
  return txs;
}

/**
 * Splits off the shares of bids at the clearing price, a few per
 * transaction, after counting the pages if the book has several. Anyone can
 * send these once every such bid has been revealed; they must land in order.
 */
export async function buildFinalizeShares(auction: Auction, bids: Bid[]): Promise<Transaction[]> {
  const txs = await tallyTransactions(auction);
  const waiting = bids.filter((b) => b.status === "atClearing");
  for (let i = 0; i < waiting.length; i += 8) {
    const tx = new Transaction();
    for (const bid of waiting.slice(i, i + 8)) tx.add(await finalizeShareInstruction(auction, bid));
    txs.push(tx);
  }
  return txs;
}

function claimTokensInstruction(payer: PublicKey, auction: Auction, bid: Bid) {
  return program.methods
    .claimTokens()
    .accountsPartial({
      payer,
      auction: auction.address,
      bid: bid.address,
      bidder: bid.bidder,
      seller: auction.seller,
      mint: auction.mint,
      vault: getAssociatedTokenAddressSync(auction.mint, auction.address, true, auction.tokenProgram),
      bidderTokenAccount: getAssociatedTokenAddressSync(auction.mint, bid.bidder, true, auction.tokenProgram),
      tokenProgram: auction.tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .instruction();
}

function closeBidInstruction(bid: Bid) {
  return program.methods
    .closeBid()
    .accountsPartial({ bidder: bid.bidder, auction: bid.auction, bid: bid.address })
    .instruction();
}

/** Closes the bid's note right after the bid, if it has one; its rent goes to the bidder. */
async function noteCloseAfter(payer: PublicKey, bid: Bid): Promise<TransactionInstruction[]> {
  return (await hasChainNote(bid.address)) ? [await closeNoteInstruction(payer, bid.bidder, bid.address)] : [];
}

/** `close_bid`, then the note's close when there is a note. */
async function closeBidInstructions(payer: PublicKey, bid: Bid): Promise<TransactionInstruction[]> {
  return [await closeBidInstruction(bid), ...(await noteCloseAfter(payer, bid))];
}

/**
 * Once bidding is over, a wallet's admission to a sale with an allowlist is
 * no longer needed: closing it returns its rent to the wallet. Added after a
 * bid's own close; nothing when the wallet has none.
 */
async function participantCloseAfter(auction: PublicKey, wallet: PublicKey): Promise<TransactionInstruction[]> {
  const participant = participantAddress(auction, wallet);
  if (!(await connection.getAccountInfo(participant))) return [];
  return [
    await program.methods
      .closeParticipant()
      .accountsPartial({ wallet, auction, participant })
      .instruction(),
  ];
}

/** Mints up to `MAX_NFTS_PER_CLAIM` of a winner's NFTs: the ones for its places from `firstPosition` on. */
function claimNftsInstruction(payer: PublicKey, auction: Auction, bid: Bid, firstPosition: number, count: number) {
  return program.methods
    .claimNfts()
    .accountsPartial({
      payer,
      auction: auction.address,
      bid: bid.address,
      bidder: bid.bidder,
      collection: auction.mint,
      mplCoreProgram: MPL_CORE_ID,
      itemList: auction.namedItems ? itemListAddress(auction.address) : null,
    })
    .remainingAccounts(
      Array.from({ length: count }, (_, k) => ({
        pubkey: assetAddress(auction.address, firstPosition + k),
        isSigner: false,
        isWritable: true,
      }))
    )
    .instruction();
}

/**
 * Finishes a bid: delivers what it won to the owner (tokens into their token
 * account, created at the payer's cost if needed; NFTs minted to them, a few
 * per transaction), then returns the unused deposit and the bid account's
 * rent to the owner. Anyone can send these; nothing goes anywhere but to the
 * bid's owner.
 *
 * A collection bid at the clearing price only gets its share split off: its
 * NFTs, like every winner's, wait until every bid is settled and Arcium has
 * shuffled them (`nftsReady`).
 */
export async function buildCollect(payer: PublicKey, auction: Auction, bid: Bid, now: number): Promise<Transaction[]> {
  if (bid.status === "atClearing") {
    // Only collection bids wait at the clearing price.
    if (!sharesAreFinal(auction)) throw new Error("Not every bid at the clearing price has been revealed yet.");
    return [...(await tallyTransactions(auction)), new Transaction().add(await finalizeShareInstruction(auction, bid))];
  }
  if (auction.kind === "token") {
    const tx = new Transaction();
    if (bid.won > 0n && !bid.delivered) tx.add(await claimTokensInstruction(payer, auction, bid));
    tx.add(...(await closeBidInstructions(payer, bid)));
    if (auction.allowlist) tx.add(...(await participantCloseAfter(auction.address, bid.bidder)));
    return [tx];
  }
  let owed = bid.delivered ? 0 : Number(bid.won) - bid.nftsClaimed;
  if (owed > 0 && auction.unrevealed) {
    // A hidden collection not revealed in time gives the payment back
    // instead; until then its NFTs wait for the reveal.
    if (!revealMissed(auction, now)) throw new Error("The NFTs are minted once the seller reveals the art.");
    return [new Transaction().add(await refundUnrevealedInstruction(auction, bid), ...(await closeBidInstructions(payer, bid)))];
  }
  if (owed > 0 && !nftsReady(auction, now)) {
    throw new Error("The NFTs are handed out once every bid is settled and Arcium has shuffled them.");
  }
  const txs: Transaction[] = [];
  let next = bid.firstPosition + bid.nftsClaimed;
  do {
    const count = Math.min(owed, MAX_NFTS_PER_CLAIM);
    const tx = new Transaction();
    if (count > 0) {
      // Each NFT is a Metaplex Core account; minting five takes about 200k compute units.
      tx.add(computeLimit(400_000));
      tx.add(await claimNftsInstruction(payer, auction, bid, next, count));
    }
    next += count;
    owed -= count;
    if (owed === 0) tx.add(...(await closeBidInstructions(payer, bid)));
    txs.push(tx);
  } while (owed > 0);
  return txs;
}

/** The token auction's escrow accounts. */
function sellerTokenAccounts(auction: Auction) {
  return {
    seller: auction.seller,
    auction: auction.address,
    mint: auction.mint,
    vault: getAssociatedTokenAddressSync(auction.mint, auction.address, true, auction.tokenProgram),
    sellerTokenAccount: getAssociatedTokenAddressSync(auction.mint, auction.seller, false, auction.tokenProgram),
    tokenProgram: auction.tokenProgram,
  };
}

/**
 * Pays the seller the proceeds less the platform's sale fee (and unsold
 * tokens). A sale whose pool will not open (it missed the minimum, ended
 * without bids or stalled) also gets the pool's reserve back here.
 */
export async function buildClaimProceeds(auction: Auction) {
  if (auction.kind === "collection") {
    return program.methods
      .claimCollectionProceeds()
      .accountsPartial({ seller: auction.seller, auction: auction.address, treasury: auction.treasury })
      .transaction();
  }
  const tx = new Transaction();
  // A planned pool that will not open is released first: claiming waits for it.
  if (auction.liquidity === "planned") tx.add(await releaseLiquidityInstruction(auction));
  tx.add(
    await program.methods
      .claimProceeds()
      .accountsPartial({ ...sellerTokenAccounts(auction), treasury: auction.treasury })
      .instruction()
  );
  if (auction.liquidity === "failed") tx.add(await releaseLiquidityInstruction(auction));
  return tx;
}

/** The clearing state, which closes with an auction that has more than one page. */
const foldIfPaged = (auction: Auction) => (auction.extraPages > 0 ? foldAddress(auction.address) : null);

/** Pages closed per transaction by `closePageTransactions`. */
const PAGE_CLOSES_PER_TX = 5;

/**
 * A book with many pages closes them a few at a time from the end, down to
 * its second page, which closes with the auction (`close_book_page`).
 * Returns those transactions, in order.
 */
async function closePageTransactions(auction: Auction): Promise<Transaction[]> {
  const txs: Transaction[] = [];
  for (let page = auction.extraPages; page >= 2; page -= PAGE_CLOSES_PER_TX) {
    const tx = new Transaction();
    for (let p = page; p >= Math.max(2, page - PAGE_CLOSES_PER_TX + 1); p--) {
      tx.add(
        await program.methods
          .closeBookPage()
          .accountsPartial({ auction: auction.address, seller: auction.seller, pageBook: bookAddress(auction.address, p) })
          .instruction()
      );
    }
    txs.push(tx);
  }
  return txs;
}

/** The auction's pages after the first that it still has once `closePageTransactions` ran: just the second, if any. */
const pagesLeftAtClose = (auction: Auction) =>
  auction.extraPages > 0 ? [{ pubkey: bookAddress(auction.address, 1), isSigner: false, isWritable: true }] : [];

/**
 * Closes the auction with its remaining pages: every further page if it has
 * at most `MAX_PREPAID_PAGES - 1` (a cancelled sale's pages, say), else only
 * the second, after `closePageTransactions`.
 */
async function closeInstruction(auction: Auction, afterPageCloses = false) {
  const pages = afterPageCloses ? pagesLeftAtClose(auction) : pageAccounts(auction, true);
  if (auction.kind === "collection") {
    return program.methods
      .closeCollectionAuction()
      .accountsPartial({
        seller: auction.seller,
        auction: auction.address,
        book: bookAddress(auction.address),
        fold: foldIfPaged(auction),
        bookIndex: indexIfPaged(auction),
        collection: auction.mint,
        mplCoreProgram: MPL_CORE_ID,
        itemList: auction.namedItems ? itemListAddress(auction.address) : null,
      })
      .remainingAccounts(pages)
      .instruction();
  }
  // A sale's allowlist closes with it, once the seller set it.
  const list =
    auction.allowlist && (await connection.getAccountInfo(allowlistAddress(auction.address))) ? allowlistAddress(auction.address) : null;
  return program.methods
    .closeAuction()
    .accountsPartial({
      ...sellerTokenAccounts(auction),
      book: bookAddress(auction.address),
      fold: foldIfPaged(auction),
      bookIndex: indexIfPaged(auction),
      list,
    })
    .remainingAccounts(pages)
    .instruction();
}

/**
 * Withdraws an auction nobody has bid on and closes it in one transaction:
 * the tokens (or the empty collection) and every rent go back to the seller.
 */
export async function buildCancelAuction(auction: Auction) {
  const cancel =
    auction.kind === "collection"
      ? program.methods
          .cancelCollectionAuction()
          .accountsPartial({ seller: auction.seller, auction: auction.address, treasury: auction.treasury })
      : program.methods.cancelAuction().accountsPartial({ ...sellerTokenAccounts(auction), treasury: auction.treasury });
  const tx = new Transaction().add(await cancel.instruction());
  // A planned pool's reserve and rent deposit come back too.
  if (auction.liquidity === "planned") tx.add(await releaseLiquidityInstruction(auction));
  return tx.add(await closeInstruction(auction));
}

/**
 * Closes a finished or cancelled auction once every bid account is closed,
 * returning the rent of the auction and every page of its bid book (and
 * vault) to the seller. A collection's update authority passes to the seller.
 */
export async function buildCloseAuction(auction: Auction): Promise<Transaction[]> {
  if (auction.extraPages < 2) return [new Transaction().add(await closeInstruction(auction))];
  return [...(await closePageTransactions(auction)), new Transaction().add(await closeInstruction(auction, true))];
}

/**
 * Safety net: returns an unsettled bid's whole deposit to its owner, and the
 * rent of its note. Anyone can send it.
 */
export async function buildEmergencyRefund(payer: PublicKey, bid: Bid) {
  const refund = await program.methods
    .emergencyRefund()
    .accountsPartial({ bidder: bid.bidder, auction: bid.auction, bid: bid.address })
    .instruction();
  return new Transaction().add(refund, ...(await noteCloseAfter(payer, bid)));
}

/** Second step of an admin handover, signed by the wallet the role was offered to. */
export function buildAcceptAdmin(newAdmin: PublicKey) {
  return program.methods.acceptAdmin().accountsPartial({ newAdmin, config: configAddress }).transaction();
}

export function buildSetListing(admin: PublicKey, auction: PublicKey, featured: boolean, hidden: boolean) {
  return program.methods
    .setListing(featured, hidden)
    .accountsPartial({ admin, config: configAddress, auction })
    .transaction();
}
