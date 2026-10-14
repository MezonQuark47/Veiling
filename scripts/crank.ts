/**
 * Moves an auction whose bidding has ended through every step that anyone may
 * take: checking the bids, revealing the clearing price, settling each bid,
 * finalizing the shares at the clearing price, shuffling a collection's NFTs,
 * delivering what winners won and returning unused deposits. A hidden
 * collection's winners wait for the seller's reveal; if it does not come in
 * time, they get their payments back. Funds only ever go to their owners; the
 * signing wallet pays the transaction fees and the accounts created for
 * winners. The seller's own steps, revealing hidden art, claiming the
 * proceeds and closing the auction, are left to the seller.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/devnet-test.json ARCIUM_CLUSTER_OFFSET=456 \
 *   [IDL=target/idl/sealed_auction.json] \
 *   yarn run ts-node scripts/crank.ts <auction address>
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
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
import { readFileSync } from "fs";

const BATCH_SIZE = 4;
const MAX_NFTS_PER_CLAIM = 5;
/** After this long past the end of bidding, the safety net opens and no seed is drawn. */
const EMERGENCY_DELAY_SECS = 3 * 24 * 60 * 60;
/** How long the seller of a hidden collection has to reveal it; winners are refunded after that. */
const REVEAL_DELAY_SECS = 7 * 24 * 60 * 60;
/** Where `Bid` keeps its auction: after three 32-byte fields and the nonce. */
const BID_AUCTION_OFFSET = 8 + 32 * 3 + 16;
const MPL_CORE_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
/** Compute units each queueing instruction may use. */
const COMPUTE_UNITS: Record<string, number> = {
  check_bids_v2: 400_000,
  clear_price_v2: 1_000_000,
  award_bid_v2: 400_000,
  draw_seed: 400_000,
};

const variant = (value: object) => Object.keys(value)[0];

async function main() {
  const auctionAddress = new PublicKey(process.argv[2] ?? "");
  const idl = JSON.parse(readFileSync(process.env.IDL ?? "target/idl/sealed_auction.json", "utf8"));
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(env.connection.rpcEndpoint, "confirmed"),
    env.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  const program = new Program(idl, provider) as Program<any>;
  const payer = provider.wallet.publicKey;
  const clusterOffset = getArciumEnv().arciumClusterOffset;
  const book = PublicKey.findProgramAddressSync(
    [Buffer.from("book"), auctionAddress.toBuffer()],
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

  let auction = await fetchAuction();
  console.log(`Auction ${auctionAddress.toBase58()}: ${variant(auction.status)}, ${auction.bidCount} bids`);

  if (variant(auction.status) === "open") {
    // A computation that fails leaves the count where it was; give up after
    // three tries in a row.
    for (let tries = 0, last = -1; auction.checkedCount < auction.bidCount; ) {
      tries = auction.checkedCount === last ? tries + 1 : 0;
      if (tries >= 3) throw new Error(`Checking keeps failing at bid ${auction.checkedCount}`);
      last = auction.checkedCount;
      const batch = (await fetchBids())
        .filter((b) => b.account.index >= auction.checkedCount && b.account.index < auction.checkedCount + BATCH_SIZE)
        .map((b) => ({ pubkey: b.publicKey, isWritable: false, isSigner: false }));
      console.log(`Checking bids ${auction.checkedCount}-${auction.checkedCount + batch.length - 1}...`);
      await compute("check_bids_v2", (o) => program.methods.checkBatch(o), { auction: auctionAddress, book }, batch as any);
      auction = await fetchAuction();
    }
    if (auction.bidCount > 0) {
      console.log("Revealing the clearing price...");
      await compute("clear_price_v2", (o) => program.methods.findClearing(o), { auction: auctionAddress, book });
      auction = await fetchAuction();
      console.log(`Clearing price ${auction.clearingPrice} (ticks), filled: ${auction.filled}`);
    }
  }

  if (variant(auction.status) === "settling") {
    for (const b of await fetchBids()) {
      if (variant(b.account.status) !== "sealed") continue;
      console.log(`Settling bid ${b.account.index}...`);
      await compute("award_bid_v2", (o) => program.methods.settleBid(o), {
        auction: auctionAddress,
        bid: b.publicKey,
        book,
      });
    }
  }

  for (const b of await fetchBids()) {
    if (variant(b.account.status) !== "atClearing") continue;
    console.log(`Finalizing the share of bid ${b.account.index}...`);
    await program.methods
      .finalizeShare()
      .accountsPartial({ auction: auctionAddress, book, bid: b.publicKey })
      .rpc();
  }

  auction = await fetchAuction();
  const collection = variant(auction.kind) === "collection";
  // Once every bid is settled, Arcium draws the seed that decides which NFTs
  // each winner's places become. Auctions from before shuffling hand out no
  // places and need no seed; once the safety net is open, places are their
  // own numbers instead.
  const sold = BigInt(auction.sold.toString());
  const safetyNetOpen = Date.now() / 1000 >= auction.endTime.toNumber() + EMERGENCY_DELAY_SECS;
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
      console.log("Shuffling the NFTs...");
      await compute("draw_seed", (o) => program.methods.drawNftSeed(o), { auction: auctionAddress });
      auction = await fetchAuction();
    }
    console.log(`Shuffled with seed ${BigInt(auction.nftSeed.toString()).toString(16)}`);
  }
  // A collection named per item takes its NFT names from its item list.
  const itemList = auction.namedItems
    ? PublicKey.findProgramAddressSync([Buffer.from("items"), auctionAddress.toBuffer()], program.programId)[0]
    : null;
  const revealDeadline = auction.endTime.toNumber() + REVEAL_DELAY_SECS;
  const revealMissed = collection && auction.unrevealed && Date.now() / 1000 >= revealDeadline;
  if (collection && auction.unrevealed && !revealMissed) {
    console.log(
      `The art is hidden until the seller reveals it (by ${new Date(revealDeadline * 1000).toISOString()}); winners wait until then.`
    );
  }
  for (const b of await fetchBids()) {
    const bid = b.account;
    if (variant(bid.status) !== "settled") continue;
    const won = BigInt(bid.won.toString());
    if (won > 0n && !bid.delivered && collection && auction.unrevealed) {
      if (!revealMissed) continue;
      console.log(`The art was not revealed in time: giving bid ${bid.index} its payment back...`);
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
          console.log(`Minting ${count} NFT(s) for bid ${bid.index}...`);
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
        console.log(`Delivering ${won} base unit(s) to bid ${bid.index}...`);
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
    console.log(`Returning the rest of bid ${bid.index}'s deposit...`);
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
  console.log(
    `Done: ${variant(auction.status)}, ${auction.resolvedCount}/${auction.bidCount} bids resolved, ` +
      `${auction.liveBids} bid account(s) open. The seller can now claim the proceeds and close the auction.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
