/**
 * The steps that take an ended auction to its end, shared by
 * `scripts/crank.ts` (one auction, by hand) and `scripts/keeper.ts` (every
 * auction, on its own).
 *
 * Moves an auction whose bidding has ended through every step that anyone may
 * take: checking the bids, revealing the clearing price, settling each bid,
 * finalizing the shares at the clearing price, shuffling a collection's NFTs,
 * delivering what winners won and returning unused deposits. A hidden
 * collection's winners wait for the seller's reveal; if it does not come in
 * time, they get their payments back. Funds only ever go to their owners; the
 * signing wallet pays the transaction fees and the accounts created for
 * winners, and is paid the auction's crank reward for every MPC step that
 * succeeds, which covers the network fee of queueing it. The seller's own steps, revealing hidden art, claiming the
 * proceeds and closing the auction, are left to the seller.
 *
 * An auction whose bids fill more than one page of its bid book finds its
 * price a page at a time (`fold_clearing`): `8 * (pages - 1) + 1` steps.
 * Bids are settled `SETTLE_AT_ONCE` at a time (default 4); each is its own
 * computation.
 *
 * A token sale with auto-liquidity opens its Meteora pool once every bid is
 * settled (`bootstrap_liquidity`, which also pays the seller), and pays out
 * the pool's trading fees on later runs. A sale that missed its pool's
 * minimum refunds its bids instead of settling them. A fair launch that sold
 * out makes its token first (`graduate_launch`); winners collect their tokens
 * once its pool is open.
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";

const BATCH_SIZE = 4;
/** Bids per page of the bid book. */
const PAGE_BIDS = 256;
const MAX_NFTS_PER_CLAIM = 5;
/** After this long past the end of bidding, the safety net opens and no seed is drawn. */
const EMERGENCY_DELAY_SECS = 3 * 24 * 60 * 60;
const LAUNCH_EMERGENCY_DELAY_SECS = 24 * 60 * 60;
/** How long the seller of a hidden collection has to reveal it; winners are refunded after that. */
const REVEAL_DELAY_SECS = 7 * 24 * 60 * 60;
/** Where `Bid` keeps its auction: after three 32-byte fields and the nonce. */
const BID_AUCTION_OFFSET = 8 + 32 * 3 + 16;
const MPL_CORE_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
/** Compute units each queueing instruction may use. */
const COMPUTE_UNITS: Record<string, number> = {
  check_bids_v2: 400_000,
  clear_price_v2: 1_000_000,
  fold_batch_v2: 1_000_000,
  award_bid_v2: 400_000,
  award_batch: 400_000,
  draw_seed: 400_000,
};

const variant = (value: object) => Object.keys(value)[0];

// Auto-liquidity (the program's `liquidity` module).
const CP_AMM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const LIQUIDITY_PLANNED = 1;
const LIQUIDITY_FAILED = 2;
const LIQUIDITY_POOLED = 3;
const damm = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, CP_AMM_ID)[0];
/** DAMM v2's one customizable pool for a token and SOL. */
function dammPool(mint: PublicKey) {
  const [a, b] = [mint.toBuffer(), WSOL_MINT.toBuffer()];
  return Buffer.compare(a, b) > 0 ? damm(Buffer.from("cpool"), a, b) : damm(Buffer.from("cpool"), b, a);
}
const dammVault = (mint: PublicKey, pool: PublicKey) => damm(Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer());


export interface FinishContext {
  program: Program<any>;
  provider: anchor.AnchorProvider;
  log?: (line: string) => void;
  /** Also pay out a pooled sale's trading fees (`claim_pool_fees`). */
  poolFees?: boolean;
}

/** Takes one auction as far as anyone may: see the top of this file. */
export async function finishAuction(ctx: FinishContext, auctionAddress: PublicKey): Promise<void> {
  const { program, provider } = ctx;
  const log = ctx.log ?? ((line: string) => console.log(line));
  const payer = provider.wallet.publicKey;
  const clusterOffset = getArciumEnv().arciumClusterOffset;
  /** Page `page` of the auction's bid book. */
  const book = (page = 0) =>
    PublicKey.findProgramAddressSync(
      page === 0
        ? [Buffer.from("book"), auctionAddress.toBuffer()]
        : [Buffer.from("book"), auctionAddress.toBuffer(), Buffer.from([page])],
      program.programId
    )[0];
  const pageOf = (index: number) => Math.floor(index / PAGE_BIDS);
  const fold = PublicKey.findProgramAddressSync([Buffer.from("fold"), auctionAddress.toBuffer()], program.programId)[0];
  const bookIndex = PublicKey.findProgramAddressSync(
    [Buffer.from("index"), auctionAddress.toBuffer()],
    program.programId
  )[0];

  // The IDL is chosen at run time, so its accounts are untyped here.
  const accounts = program.account as any;
  const fetchAuction = () => accounts.auction.fetch(auctionAddress) as Promise<any>;
  const fetchBids = async () =>
    (
      (await accounts.bid.all([
        { memcmp: { offset: BID_AUCTION_OFFSET, bytes: auctionAddress.toBase58() } },
      ])) as { publicKey: PublicKey; account: any }[]
    ).sort((a, b) => a.account.index - b.account.index);

  /** Queues one MPC computation and waits for its callback. */
  async function compute(circuit: string, method: (offset: BN) => any, accounts: object, remaining = []) {
    const offset = new BN(randomBytes(8), "hex");
    await method(offset)
      .accountsPartial({
        payer,
        ...accounts,
        computationAccount: getComputationAccAddress(clusterOffset, offset),
        clusterAccount: getClusterAccAddress(clusterOffset),
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(clusterOffset),
        executingPool: getExecutingPoolAccAddress(clusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()
        ),
      })
      .remainingAccounts(remaining)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS[circuit] })])
      .rpc({ skipPreflight: true });
    await awaitComputationFinalization(provider, offset, program.programId, "confirmed", 180_000);
  }

  const startBalance = await provider.connection.getBalance(payer, "confirmed");
  let auction = await fetchAuction();
  log(`Auction ${auctionAddress.toBase58()}: ${variant(auction.status)}, ${auction.bidCount} bids`);
  log(
    `Settlement fund: ${auction.crankPool.toNumber() / 1e9} SOL; each step pays this wallet its reward when it succeeds.`
  );

  if (variant(auction.status) === "open") {
    // A computation that fails leaves the count where it was; give up after
    // three tries in a row. Bidding is over, so the bids no longer change.
    const allBids = auction.checkedCount < auction.bidCount ? await fetchBids() : [];
    for (let tries = 0, last = -1; auction.checkedCount < auction.bidCount; ) {
      tries = auction.checkedCount === last ? tries + 1 : 0;
      if (tries >= 3) throw new Error(`Checking keeps failing at bid ${auction.checkedCount}`);
      last = auction.checkedCount;
      const batch = allBids
        .filter((b) => b.account.index >= auction.checkedCount && b.account.index < auction.checkedCount + BATCH_SIZE)
        .map((b) => ({ pubkey: b.publicKey, isWritable: false, isSigner: false }));
      log(`Checking bids ${auction.checkedCount}-${auction.checkedCount + batch.length - 1}...`);
      await compute(
        "check_bids_v2",
        (o) => program.methods.checkBatch(o),
        { auction: auctionAddress, book: book(pageOf(auction.checkedCount)) },
        batch as any
      );
      auction = await fetchAuction();
    }
    const pages = Math.ceil(auction.bidCount / PAGE_BIDS);
    if (pages === 1) {
      log("Revealing the clearing price...");
      await compute("clear_price_v2", (o) => program.methods.findClearing(o), { auction: auctionAddress, book: book() });
      auction = await fetchAuction();
    } else if (pages > 1) {
      // A page at a time; a step that fails leaves the state where it was.
      const total = 8 * (pages - 1) + 1;
      for (let tries = 0, last = -1; variant(auction.status) === "open"; ) {
        const state = await accounts.clearingFold.fetch(fold);
        tries = state.steps === last ? tries + 1 : 0;
        if (tries >= 3) throw new Error(`The paged clearing keeps failing at step ${state.steps + 1}`);
        last = state.steps;
        log(`Finding the price: step ${state.steps + 1} of ${total} (pass ${state.pass + 1}, page ${state.page})...`);
        await compute("fold_batch_v2", (o) => program.methods.foldClearing(o), {
          auction: auctionAddress,
          fold,
          book: book(state.page),
        });
        auction = await fetchAuction();
      }
    }
    if (variant(auction.status) === "settling") {
      log(`Clearing price ${auction.clearingPrice} (ticks), filled: ${auction.filled}`);
    }
  }

  if (variant(auction.status) === "settling" && ((auction.liquidity ?? 0) === LIQUIDITY_FAILED || auction.raiseMissed)) {
    log(
      auction.raiseMissed
        ? "The sale missed its minimum raise: refunding every bid in full."
        : "The sale missed its pool's minimum: refunding every bid in full."
    );
    for (const b of (await fetchBids()).filter((b) => variant(b.account.status) === "sealed")) {
      log(`Refunding bid ${b.account.index}...`);
      await program.methods
        .refundFailedBid()
        .accountsPartial({ bidder: b.account.bidder, auction: auctionAddress, bid: b.publicKey })
        .rpc();
    }
  } else if (variant(auction.status) === "settling") {
    // The bids checked together settle together, in one computation; a batch
    // whose bids are not all sealed settles one bid at a time.
    const sealed = (await fetchBids()).filter((b) => variant(b.account.status) === "sealed");
    const byBatch = new Map<number, typeof sealed>();
    for (const b of sealed) {
      const first = b.account.index - (b.account.index % BATCH_SIZE);
      byBatch.set(first, [...(byBatch.get(first) ?? []), b]);
    }
    const jobs: (() => Promise<void>)[] = [];
    for (const [first, group] of byBatch) {
      const whole = group.length === Math.min(BATCH_SIZE, auction.bidCount - first);
      if (whole) {
        jobs.push(() => {
          log(`Settling bids ${first}-${first + group.length - 1}...`);
          return compute(
            "award_batch",
            (o) => program.methods.settleBatch(o),
            { auction: auctionAddress, book: book(pageOf(first)) },
            group.map((b) => ({ pubkey: b.publicKey, isWritable: true, isSigner: false })) as any
          ).catch((e) => log(`Bids ${first}-${first + group.length - 1} did not settle this time: ${e.message ?? e}`));
        });
      } else {
        for (const b of group) {
          jobs.push(() => {
            log(`Settling bid ${b.account.index}...`);
            return compute("award_bid_v2", (o) => program.methods.settleBid(o), {
              auction: auctionAddress,
              bid: b.publicKey,
              book: book(pageOf(b.account.index)),
            }).catch((e) => log(`Bid ${b.account.index} did not settle this time: ${e.message ?? e}`));
          });
        }
      }
    }
    const atOnce = Math.max(1, Number(process.env.SETTLE_AT_ONCE ?? 4));
    for (let i = 0; i < jobs.length; i += atOnce) {
      await Promise.all(jobs.slice(i, i + atOnce).map((job) => job()));
    }
  }
  // Shares are split once every bid at the clearing price is revealed.
  auction = await fetchAuction();
  const sharesFinal = auction.atRevealed.eq(auction.weightAt);
  const atClearing = sharesFinal
    ? (await fetchBids()).filter((b) => variant(b.account.status) === "atClearing")
    : [];
  const paged = (auction.extraPages ?? 0) > 0;
  if (atClearing.length > 0 && paged) {
    // A book with several pages counts its bids at the price page by page first.
    const pages = Math.ceil(auction.bidCount / PAGE_BIDS);
    const index = await accounts.bookIndex.fetch(bookIndex);
    for (let page = index.talliedPages; page < pages; page++) {
      log(`Counting the bids at the clearing price on page ${page}...`);
      await program.methods
        .tallyClearingPage()
        .accountsPartial({ auction: auctionAddress, book: book(page), bookIndex })
        .rpc();
    }
  }
  for (const b of atClearing) {
    log(`Finalizing the share of bid ${b.account.index}...`);
    await program.methods
      .finalizeShare()
      .accountsPartial({
        auction: auctionAddress,
        book: book(pageOf(b.account.index)),
        bid: b.publicKey,
        bookIndex: paged ? bookIndex : null,
      })
      .rpc();
  }

  auction = await fetchAuction();
  const lpAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_authority"), auctionAddress.toBuffer()],
    program.programId
  )[0];
  const planAddress = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity"), auctionAddress.toBuffer()],
    program.programId
  )[0];
  const lpWsol = getAssociatedTokenAddressSync(WSOL_MINT, lpAuthority, true, TOKEN_PROGRAM_ID);
  // A fair launch that sold out makes its token first (`graduate_launch`):
  // exactly what was sold and what the pool takes, paid from the creator's
  // deposit. Its token-to-be record is closed once that is done.
  const launchToken = PublicKey.findProgramAddressSync([Buffer.from("launch"), auctionAddress.toBuffer()], program.programId)[0];
  if (
    variant(auction.kind) === "launch" &&
    (auction.liquidity ?? 0) === LIQUIDITY_PLANNED &&
    !auction.raiseMissed &&
    variant(auction.status) === "settling" &&
    auction.resolvedCount === auction.bidCount &&
    (await provider.connection.getAccountInfo(launchToken)) !== null
  ) {
    log("The launch sold out: making its token...");
    const mintAta = (owner: PublicKey) => getAssociatedTokenAddressSync(auction.mint, owner, true, TOKEN_2022_PROGRAM_ID);
    await program.methods
      .graduateLaunch()
      .accountsPartial({
        caller: payer,
        auction: auctionAddress,
        launchToken,
        plan: planAddress,
        lpAuthority,
        seller: auction.seller,
        mint: auction.mint,
        vault: mintAta(auctionAddress),
        reserve: mintAta(lpAuthority),
        sellerTokenAccount: mintAta(auction.seller),
        wsolMint: WSOL_MINT,
        lpWsol,
        wsolTokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    auction = await fetchAuction();
  }
  if (
    (auction.liquidity ?? 0) === LIQUIDITY_PLANNED &&
    variant(auction.status) === "settling" &&
    auction.resolvedCount === auction.bidCount
  ) {
    log("Opening the pool at the clearing price and paying the seller...");
    const nft = Keypair.generate();
    const pool = dammPool(auction.mint);
    const sellerTokenAccount = getAssociatedTokenAddressSync(auction.mint, auction.seller, false, auction.tokenProgram);
    await program.methods
      .bootstrapLiquidity()
      .accountsPartial({
        cranker: payer,
        auction: auctionAddress,
        plan: planAddress,
        lpAuthority,
        seller: auction.seller,
        treasury: auction.treasury,
        mint: auction.mint,
        wsolMint: WSOL_MINT,
        reserve: getAssociatedTokenAddressSync(auction.mint, lpAuthority, true, auction.tokenProgram),
        lpWsol,
        sellerTokenAccount,
        positionNftMint: nft.publicKey,
        positionNftAccount: damm(Buffer.from("position_nft_account"), nft.publicKey.toBuffer()),
        pool,
        position: damm(Buffer.from("position"), nft.publicKey.toBuffer()),
        tokenAVault: dammVault(auction.mint, pool),
        tokenBVault: dammVault(WSOL_MINT, pool),
        poolAuthority: damm(Buffer.from("pool_authority")),
        eventAuthority: damm(Buffer.from("__event_authority")),
        cpAmmProgram: CP_AMM_ID,
        tokenProgram: auction.tokenProgram,
        wsolTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          sellerTokenAccount,
          auction.seller,
          auction.mint,
          auction.tokenProgram
        ),
      ])
      .signers([nft])
      .rpc();
    auction = await fetchAuction();
    log(
      (auction.liquidity ?? 0) === LIQUIDITY_POOLED
        ? `Pool ${pool.toBase58()} is open and locked.`
        : "Someone had opened Meteora's pool for this token first: no pool, the seller got everything."
    );
  }
  const collection = variant(auction.kind) === "collection";
  // Once every bid is settled, Arcium draws the seed that decides which NFTs
  // each winner's places become. Auctions from before shuffling hand out no
  // places and need no seed; once the safety net is open, places are their
  // own numbers instead.
  const sold = BigInt(auction.sold.toString());
  const delay = variant(auction.kind) === "launch" ? LAUNCH_EMERGENCY_DELAY_SECS : EMERGENCY_DELAY_SECS;
  const safetyNetOpen = Date.now() / 1000 >= auction.endTime.toNumber() + delay;
  if (
    collection &&
    !auction.seedDrawn &&
    !safetyNetOpen &&
    sold > 0n &&
    BigInt(auction.assignedPositions) === sold &&
    auction.resolvedCount === auction.bidCount
  ) {
    for (let tries = 0; !auction.seedDrawn; tries++) {
      if (tries >= 3) throw new Error("Shuffling the NFTs keeps failing");
      log("Shuffling the NFTs...");
      await compute("draw_seed", (o) => program.methods.drawNftSeed(o), { auction: auctionAddress });
      auction = await fetchAuction();
    }
    log(`Shuffled with seed ${BigInt(auction.nftSeed.toString()).toString(16)}`);
  }
  // A collection named per item takes its NFT names from its item list.
  const itemList = auction.namedItems
    ? PublicKey.findProgramAddressSync([Buffer.from("items"), auctionAddress.toBuffer()], program.programId)[0]
    : null;
  const revealDeadline = auction.endTime.toNumber() + REVEAL_DELAY_SECS;
  const revealMissed = collection && auction.unrevealed && Date.now() / 1000 >= revealDeadline;
  if (collection && auction.unrevealed && !revealMissed) {
    log(
      `The art is hidden until the seller reveals it (by ${new Date(revealDeadline * 1000).toISOString()}); winners wait until then.`
    );
  }
  for (const b of await fetchBids()) {
    const bid = b.account;
    if (variant(bid.status) !== "settled") continue;
    const won = BigInt(bid.won.toString());
    if (won > 0n && !bid.delivered && collection && auction.unrevealed) {
      if (!revealMissed) continue;
      log(`The art was not revealed in time: giving bid ${bid.index} its payment back...`);
      await program.methods.refundUnrevealed().accountsPartial({ auction: auctionAddress, bid: b.publicKey }).rpc();
    } else if (won > 0n && !bid.delivered) {
      if (collection) {
        // The bid's NFTs are minted for its places, from where it left off.
        let next = bid.firstPosition + bid.nftsClaimed;
        for (let left = Number(won) - bid.nftsClaimed; left > 0; ) {
          const count = Math.min(left, MAX_NFTS_PER_CLAIM);
          const assets = Array.from({ length: count }, (_, k) => {
            const place = Buffer.alloc(4);
            place.writeUInt32LE(next + k);
            const asset = PublicKey.findProgramAddressSync(
              [Buffer.from("asset"), auctionAddress.toBuffer(), place],
              program.programId
            )[0];
            return { pubkey: asset, isWritable: true, isSigner: false };
          });
          log(`Minting ${count} NFT(s) for bid ${bid.index}...`);
          await program.methods
            .claimNfts()
            .accountsPartial({
              payer,
              auction: auctionAddress,
              bid: b.publicKey,
              bidder: bid.bidder,
              collection: auction.mint,
              mplCoreProgram: MPL_CORE_ID,
              itemList,
            })
            .remainingAccounts(assets)
            .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
            .rpc();
          next += count;
          left -= count;
        }
      } else {
        log(`Delivering ${won} base unit(s) to bid ${bid.index}...`);
        await program.methods
          .claimTokens()
          .accountsPartial({
            payer,
            auction: auctionAddress,
            bid: b.publicKey,
            bidder: bid.bidder,
            seller: auction.seller,
            mint: auction.mint,
            vault: getAssociatedTokenAddressSync(auction.mint, auctionAddress, true, auction.tokenProgram),
            bidderTokenAccount: getAssociatedTokenAddressSync(
              auction.mint,
              bid.bidder,
              true,
              auction.tokenProgram
            ),
            tokenProgram: auction.tokenProgram,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .rpc();
      }
      auction = await fetchAuction();
    }
    log(`Returning the rest of bid ${bid.index}'s deposit...`);
    await program.methods
      .closeBid()
      .accountsPartial({ bidder: bid.bidder, auction: auctionAddress, bid: b.publicKey })
      .rpc();
    // The bidder's encrypted note, if any: its rent goes back to the bidder too.
    const note = PublicKey.findProgramAddressSync([Buffer.from("note"), b.publicKey.toBuffer()], program.programId)[0];
    if (await provider.connection.getAccountInfo(note)) {
      await program.methods
        .closeBidNote()
        .accountsPartial({ closer: payer, bidder: bid.bidder, bid: b.publicKey, note })
        .rpc();
    }
  }

  auction = await fetchAuction();
  if ((auction.liquidity ?? 0) === LIQUIDITY_POOLED && ctx.poolFees !== false) {
    const plan = await accounts.liquidityPlan.fetch(planAddress);
    log("Paying out the pool's trading fees (80% seller, 20% platform)...");
    await program.methods
      .claimPoolFees()
      .accountsPartial({
        cranker: payer,
        plan: planAddress,
        lpAuthority,
        seller: plan.seller,
        treasury: plan.treasury,
        mint: plan.mint,
        wsolMint: WSOL_MINT,
        reserve: getAssociatedTokenAddressSync(plan.mint, lpAuthority, true, plan.tokenProgram),
        lpWsol,
        pool: plan.pool,
        position: plan.position,
        positionNftAccount: damm(Buffer.from("position_nft_account"), plan.positionNftMint.toBuffer()),
        tokenAVault: dammVault(plan.mint, plan.pool),
        tokenBVault: dammVault(WSOL_MINT, plan.pool),
        poolAuthority: damm(Buffer.from("pool_authority")),
        eventAuthority: damm(Buffer.from("__event_authority")),
        cpAmmProgram: CP_AMM_ID,
        tokenProgram: plan.tokenProgram,
        wsolTokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })])
      .rpc();
    const after = await accounts.liquidityPlan.fetch(planAddress);
    log(
      `Pool fees paid out so far: ${after.feesToSeller.toNumber() / 1e9} SOL to the seller, ` +
        `${after.feesToPlatform.toNumber() / 1e9} SOL to the platform.`
    );
  }
  const net = (await provider.connection.getBalance(payer, "confirmed")) - startBalance;
  log(`This wallet's net for the run, fees and rewards together: ${net / 1e9} SOL`);
  log(
    `Done: ${variant(auction.status)}, ${auction.resolvedCount}/${auction.bidCount} bids resolved, ` +
      `${auction.liveBids} bid account(s) open. The seller can now claim the proceeds and close the auction.`
  );
}
