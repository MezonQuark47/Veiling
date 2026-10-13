import { BN } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  ExtensionType,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
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
import { BATCH_SIZE, MAX_BIDS, MAX_NFTS_PER_CLAIM, MPL_CORE_ID, QUEUE_COMPUTE_UNITS } from "../config";
import { computationAccounts, encryptBid, newComputationOffset } from "./arcium";
import {
  type Auction,
  type Bid,
  type FeeConfig,
  assetAddress,
  auctionAddress,
  bidAddress,
  bookAddress,
  collectionAddress,
  configAddress,
  connection,
  evictionThreshold,
  feeConfigAddress,
  fetchBidsForAuction,
  fetchBookDeposits,
  itemListAddress,
  nftsReady,
  program,
  randomU64,
  revealMissed,
  sharesAreFinal,
} from "./chain";
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
  /** Smallest budget a bid may deposit, in lamports. */
  minDeposit: bigint;
  durationSecs: number;
}

/** A collection sale's terms; see `create_collection_auction`. */
export interface CollectionSaleTerms {
  supply: number;
  /** Lowest price per NFT that counts, in ticks of 1_000 lamports. */
  minPrice: bigint;
  maxPerBid: number;
  durationSecs: number;
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

export async function buildCreateAuction(
  seller: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  terms: TokenSaleTerms,
  fees: FeeConfig
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
      },
      acceptedFees(fees)
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
  return { tx, auction };
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
  if (auction.bidCount < MAX_BIDS) return null;
  const [deposits, bids] = await Promise.all([
    fetchBookDeposits(auction.address),
    fetchBidsForAuction(auction.address),
  ]);
  let index = 0;
  for (let i = 1; i < deposits.length; i++) if (deposits[i] < deposits[index]) index = i;
  const bid = bids.find((b) => b.index === index && b.deposit === deposits[index]);
  if (!bid) throw new Error("Could not find the bid with the smallest deposit. Try again in a moment.");
  return { bid, minimumDeposit: evictionThreshold(deposits[index]) };
}

/**
 * A sealed bid: `price` is the most the bidder pays, in the auction's price
 * ticks. A token bid's size is its budget, the deposit, so `quantity` is 0;
 * a collection bid asks for `quantity` NFTs and its deposit must cover them.
 */
export async function buildPlaceBid(
  bidder: PublicKey,
  auction: Auction,
  price: bigint,
  quantity: number,
  deposit: bigint
) {
  const eviction = await findEviction(auction);
  if (eviction && deposit < eviction.minimumDeposit) {
    throw new Error("This auction is full. Raise your deposit to replace the smallest bid.");
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
  };
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
      book: bookAddress(auction.address),
      bid,
      evictedBid: eviction ? eviction.bid.address : null,
      evictedBidder: eviction ? eviction.bid.bidder : null,
    })
    .transaction();
  return { tx, bid, evicted: eviction?.bid ?? null };
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
      book: bookAddress(auction.address),
      ...computationAccounts("check_bids", offset),
    })
    .remainingAccounts(batch.map((b) => ({ pubkey: b.address, isSigner: false, isWritable: false })))
    .preInstructions([computeLimit(QUEUE_COMPUTE_UNITS.check)])
    .transaction();
  return { tx, count: batch.length };
}

export async function buildFindClearing(payer: PublicKey, auction: Auction) {
  const offset = newComputationOffset();
  return program.methods
    .findClearing(offset)
    .accountsPartial({
      payer,
      auction: auction.address,
      book: bookAddress(auction.address),
      ...computationAccounts("clear_price", offset),
    })
    .preInstructions([computeLimit(QUEUE_COMPUTE_UNITS.clear)])
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
      book: bookAddress(auction.address),
      ...computationAccounts("award_bid", offset),
    })
    .preInstructions([computeLimit(QUEUE_COMPUTE_UNITS.settle)])
    .transaction();
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
    .accountsPartial({ auction: auction.address, book: bookAddress(auction.address), bid: bid.address })
    .instruction();
}

/**
 * Splits off the shares of bids at the clearing price, a few per
 * transaction. Anyone can send it once every such bid has been revealed.
 */
export async function buildFinalizeShares(auction: Auction, bids: Bid[]) {
  const tx = new Transaction();
  for (const bid of bids.filter((b) => b.status === "atClearing").slice(0, 8)) {
    tx.add(await finalizeShareInstruction(auction, bid));
  }
  return tx;
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
    return [new Transaction().add(await finalizeShareInstruction(auction, bid))];
  }
  if (auction.kind === "token") {
    const tx = new Transaction();
    if (bid.won > 0n && !bid.delivered) tx.add(await claimTokensInstruction(payer, auction, bid));
    tx.add(await closeBidInstruction(bid));
    return [tx];
  }
  let owed = bid.delivered ? 0 : Number(bid.won) - bid.nftsClaimed;
  if (owed > 0 && auction.unrevealed) {
    // A hidden collection not revealed in time gives the payment back
    // instead; until then its NFTs wait for the reveal.
    if (!revealMissed(auction, now)) throw new Error("The NFTs are minted once the seller reveals the art.");
    return [new Transaction().add(await refundUnrevealedInstruction(auction, bid), await closeBidInstruction(bid))];
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
    if (owed === 0) tx.add(await closeBidInstruction(bid));
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

/** Pays the seller the proceeds less the platform's sale fee (and unsold tokens). */
export function buildClaimProceeds(auction: Auction) {
  if (auction.kind === "collection") {
    return program.methods
      .claimCollectionProceeds()
      .accountsPartial({ seller: auction.seller, auction: auction.address, treasury: auction.treasury })
      .transaction();
  }
  return program.methods
    .claimProceeds()
    .accountsPartial({ ...sellerTokenAccounts(auction), treasury: auction.treasury })
    .transaction();
}

async function closeInstruction(auction: Auction) {
  if (auction.kind === "collection") {
    return program.methods
      .closeCollectionAuction()
      .accountsPartial({
        seller: auction.seller,
        auction: auction.address,
        book: bookAddress(auction.address),
        collection: auction.mint,
        mplCoreProgram: MPL_CORE_ID,
        itemList: auction.namedItems ? itemListAddress(auction.address) : null,
      })
      .instruction();
  }
  return program.methods
    .closeAuction()
    .accountsPartial({ ...sellerTokenAccounts(auction), book: bookAddress(auction.address) })
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
  return new Transaction().add(await cancel.instruction(), await closeInstruction(auction));
}

/**
 * Closes a finished or cancelled auction once every bid account is closed,
 * returning the rent of the auction and its bid book (and vault) to the
 * seller. A collection's update authority passes to the seller.
 */
export async function buildCloseAuction(auction: Auction) {
  return new Transaction().add(await closeInstruction(auction));
}

/** Safety net: returns an unsettled bid's whole deposit to its owner. Anyone can send it. */
export function buildEmergencyRefund(bid: Bid) {
  return program.methods
    .emergencyRefund()
    .accountsPartial({ bidder: bid.bidder, auction: bid.auction, bid: bid.address })
    .transaction();
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
