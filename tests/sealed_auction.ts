/**
 * End-to-end test of the sealed uniform-price auction against a live Arcium
 * cluster (`arcium test --cluster devnet --skip-build` with CIRCUIT_BASE_URL).
 *
 * Bidders name any price. A token bid is a SOL budget (its deposit) and the
 * highest price per token it accepts; a collection bid is a number of NFTs
 * and the highest price per NFT. The highest bids win, every winner pays the
 * same clearing price and the rest of each deposit is refunded.
 *
 * Token sale (100 tokens, at least 1_000 lamports per token):
 *   A: 120_000 lamports, up to 5_000 per token -> 40 tokens
 *   B:  60_000 lamports, up to 4_000           -> 20 tokens
 *   C: 200_000 lamports, up to 3_000           -> the 40 tokens left
 *   D:  30_000 lamports, up to 2_000           -> below the clearing price
 *   E:  50_000 lamports, up to   800           -> below the minimum price
 * At 3_000 the budgets of A, B and C buy more than the supply; above it A and
 * B alone buy less. Everyone pays 3_000 per token; the seller gets 300_000
 * lamports less the platform's sale fee.
 *
 * Short sale: demand never reaches the supply, so every valid bid buys all
 * its budget affords at the minimum price. Malformed and random ciphertexts
 * are decoded once, so the clearing and every settlement agree about them.
 *
 * Collection (4 NFTs, at most 2 per bid): T asks for 2 above the clearing
 * price; P, Q and R ask for 1 each at it, and the earliest two get the 2 NFTs
 * left. U asks for too many and V cannot pay for what it asks, so both count
 * as no bid. NFTs are minted when claimed, and closing the auction hands the
 * collection to the seller.
 *
 * Named, hidden collection (5 NFTs from an item list: two editions of one
 * item, a single NFT, two editions of another): its metadata link is fixed
 * when it opens, but nothing can be minted, and the seller is not paid,
 * until the seller reveals it after the sale. Each NFT is named after its
 * item.
 *
 * Run against devnet without redeploying:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/devnet-test.json ARCIUM_CLUSTER_OFFSET=456 \
 *   CIRCUIT_BASE_URL=https://raw.githubusercontent.com/<user>/<repo>/<commit> \
 *   yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/sealed_auction.ts
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
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
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  createUpdateAuthorityInstruction,
  pack,
} from "@solana/spl-token-metadata";
import {
  RescueCipher,
  awaitComputationFinalization,
  getArciumEnv,
  getArciumProgram,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getLookupTableAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  getMempoolAccAddress,
  x25519,
} from "@arcium-hq/client";
import { createHash, randomBytes } from "crypto";
import { expect } from "chai";
import { SealedAuction } from "../target/types/sealed_auction";
import { shuffledItems } from "../app/src/lib/shuffle";

const CIRCUITS = ["check_bids", "clear_price", "award_bid", "draw_seed"] as const;
type CircuitName = (typeof CIRCUITS)[number];

const BATCH_SIZE = 4;
const DECIMALS = 6;
/** Base units in one whole token. */
const TOKEN = 10n ** BigInt(DECIMALS);
/** Token prices here are lamports per whole token. */
const PRICE_UNIT = new BN(10 ** DECIMALS);
/** Lamports per price tick of a collection auction. */
const NFT_PRICE_SCALE = 1_000;
const DURATION_SECS = 60;
const BID_NONCE_DOMAIN = "sealed-auction/bid-nonce/v1";
const FIELD_MODULUS = (1n << 255n) - 19n;
const MPL_CORE_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
/** Fees the suite sets up if the platform has none yet: 0.02 SOL and 1%. */
const DEFAULT_LISTING_FEE = 20_000_000;
const DEFAULT_SALE_FEE_BPS = 100;

/** What a settled bid's `outcome` means. */
const OUTCOME_NONE = 0;
const OUTCOME_ABOVE = 1;
const OUTCOME_AT = 2;

/**
 * Public RPC endpoints sit behind load balancers, so the node that simulates
 * a transaction sometimes has not seen its blockhash yet. This provider uses
 * confirmed blockhashes and retries that one transient error with a fresh
 * blockhash; every other error is passed through untouched.
 */
class PatientProvider extends anchor.AnchorProvider {
  async sendAndConfirm(...args: Parameters<anchor.AnchorProvider["sendAndConfirm"]>) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.sendAndConfirm(...args);
      } catch (e) {
        if (attempt >= 4 || !String(e).includes("Blockhash not found")) throw e;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }
}

describe("sealed_auction", () => {
  const envProvider = anchor.AnchorProvider.env();
  anchor.setProvider(
    new PatientProvider(
      new anchor.web3.Connection(envProvider.connection.rpcEndpoint, "confirmed"),
      envProvider.wallet,
      { commitment: "confirmed", preflightCommitment: "confirmed" }
    )
  );
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const connection = provider.connection;
  const program = anchor.workspace.SealedAuction as Program<SealedAuction>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const clusterOffset = getArciumEnv().arciumClusterOffset;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [feeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fees")],
    program.programId
  );

  type AuctionState = Awaited<ReturnType<typeof program.account.auction.fetch>>;

  let mxePublicKey: Uint8Array;
  /** The platform's fees and treasury, read once the setup has run. */
  let fees: { listingFee: BN; saleFeeBps: number; treasury: PublicKey };
  const saleFee = (proceeds: number) => Math.floor((proceeds * fees.saleFeeBps) / 10_000);

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /** Accounts every queue_computation instruction needs. */
  function arciumAccounts(circuit: CircuitName, computationOffset: BN) {
    return {
      computationAccount: getComputationAccAddress(clusterOffset, computationOffset),
      clusterAccount: getClusterAccAddress(clusterOffset),
      mxeAccount: getMXEAccAddress(program.programId),
      mempoolAccount: getMempoolAccAddress(clusterOffset),
      executingPool: getExecutingPoolAccAddress(clusterOffset),
      compDefAccount: getCompDefAccAddress(
        program.programId,
        Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()
      ),
    };
  }

  const newComputationOffset = () => new BN(randomBytes(8), "hex");
  const newSeed = () => new BN(randomBytes(8), "hex");
  const computeLimit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function finalize(offset: BN) {
    return awaitComputationFinalization(
      provider,
      offset,
      program.programId,
      "confirmed",
      180_000
    );
  }

  /** Logs the compute units a transaction used, once per instruction name. */
  const unitsLogged = new Set<string>();
  async function logUnits(name: string, signature: string) {
    if (unitsLogged.has(name)) return;
    unitsLogged.add(name);
    for (let attempt = 0; attempt < 10; attempt++) {
      const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.computeUnitsConsumed !== undefined) {
        console.log(`    ${name} used ${tx.meta.computeUnitsConsumed} compute units`);
        return;
      }
      await sleep(1_000);
    }
  }

  /** Throwaway wallets funded by the admin; `after` sends what is left back. */
  const throwaway: Keypair[] = [];

  async function fund(kp: Keypair, sol: number) {
    throwaway.push(kp);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: kp.publicKey,
        lamports: Math.round(sol * LAMPORTS_PER_SOL),
      })
    );
    await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
  }

  /**
   * Returns what is left in a throwaway wallet to the admin. Sent directly,
   * not through the provider, which would also try to sign as the admin.
   */
  async function sweep(kp: Keypair) {
    const balance = await connection.getBalance(kp.publicKey, "confirmed");
    const fee = 5_000;
    if (balance <= fee) return;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: admin.publicKey,
        lamports: balance - fee,
      })
    );
    tx.feePayer = kp.publicKey;
    await sendAndConfirmTransaction(connection, tx, [kp], { commitment: "confirmed" }).catch((e) =>
      console.warn(`    Could not sweep ${kp.publicKey.toBase58()}: ${e}`)
    );
  }

  after(async () => {
    for (const kp of throwaway) await sweep(kp);
  });

  async function waitForValidatorTime(target: number) {
    for (;;) {
      const slot = await connection.getSlot("confirmed");
      const now = await connection.getBlockTime(slot);
      if (now !== null && now >= target) return;
      await sleep(3_000);
    }
  }

  async function expectError(promise: Promise<unknown>, name: string) {
    try {
      await promise;
    } catch (e: any) {
      const text = String(e) + JSON.stringify(e?.logs ?? e?.transactionLogs ?? []);
      if (!text.includes(name)) expect.fail(`expected ${name}, got: ${text.slice(0, 3000)}`);
      return;
    }
    expect.fail(`expected ${name}`);
  }

  /** Creates a fixed-supply Token-2022 token with on-chain metadata. */
  async function createFixedSupplyToken(owner: Keypair, supply: bigint) {
    const mint = Keypair.generate();
    const metadata = {
      mint: mint.publicKey,
      name: "Sealed Test Token",
      symbol: "SEAL",
      uri: "",
      additionalMetadata: [] as [string, string][],
    };
    const mintLen = getMintLen([ExtensionType.MetadataPointer]);
    const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
    const lamports = await connection.getMinimumBalanceForRentExemption(
      mintLen + metadataLen
    );
    const ownerAta = getAssociatedTokenAddressSync(
      mint.publicKey,
      owner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: owner.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMetadataPointerInstruction(
        mint.publicKey,
        null,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        DECIMALS,
        owner.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint.publicKey,
        updateAuthority: owner.publicKey,
        mint: mint.publicKey,
        mintAuthority: owner.publicKey,
        name: metadata.name,
        symbol: metadata.symbol,
        uri: metadata.uri,
      }),
      createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey,
        ownerAta,
        owner.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        mint.publicKey,
        ownerAta,
        owner.publicKey,
        supply,
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      // Lock the supply and the metadata for good.
      createSetAuthorityInstruction(
        mint.publicKey,
        owner.publicKey,
        AuthorityType.MintTokens,
        null,
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      createUpdateAuthorityInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint.publicKey,
        oldAuthority: owner.publicKey,
        newAuthority: null,
      })
    );
    await provider.sendAndConfirm(tx, [owner, mint], { commitment: "confirmed" });
    return { mint: mint.publicKey, ownerAta };
  }

  function auctionPda(seller: PublicKey, seed: BN) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("auction"), seller.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  }

  function bookPda(auction: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("book"), auction.toBuffer()],
      program.programId
    )[0];
  }

  function bidPda(auction: PublicKey, bidder: PublicKey, seed: BN) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), auction.toBuffer(), bidder.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  }

  /** The NFT minted for place `position` of a collection auction. */
  function assetPda(auction: PublicKey, position: number) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(position);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("asset"), auction.toBuffer(), bytes],
      program.programId
    )[0];
  }

  function collectionPda(auction: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("collection"), auction.toBuffer()],
      program.programId
    )[0];
  }

  /** The item list of a collection named per item. */
  function itemListPda(auction: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("items"), auction.toBuffer()],
      program.programId
    )[0];
  }

  /** A Metaplex Core asset's name and metadata link. */
  function readAsset(data: Buffer) {
    // AssetV1: key, owner, update authority (kind + collection), name, uri.
    const nameLength = data.readUInt32LE(66);
    const name = data.subarray(70, 70 + nameLength).toString("utf8");
    const uriAt = 70 + nameLength;
    const uri = data.subarray(uriAt + 4, uriAt + 4 + data.readUInt32LE(uriAt)).toString("utf8");
    return { name, uri };
  }

  /** The nonce the program requires for the bid stored at `bid`. */
  function bidNonce(bid: PublicKey): Buffer {
    return createHash("sha256")
      .update(Buffer.from(BID_NONCE_DOMAIN))
      .update(bid.toBuffer())
      .digest()
      .subarray(0, 16);
  }

  const toBigIntLE = (bytes: Uint8Array | number[]) =>
    BigInt("0x" + (Buffer.from(bytes).reverse().toString("hex") || "0"));
  const toBytesLE = (value: bigint) =>
    Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex").reverse());

  function modPow(base: bigint, exponent: bigint, modulus: bigint) {
    let result = 1n;
    base %= modulus;
    for (; exponent > 0n; exponent >>= 1n) {
      if (exponent & 1n) result = (result * base) % modulus;
      base = (base * base) % modulus;
    }
    return result;
  }

  /** The Edwards y-coordinate (u - 1) / (u + 1) the program checks a key with. */
  function edwardsY(publicKey: Uint8Array | number[]): number[] {
    const p = FIELD_MODULUS;
    const u = toBigIntLE(publicKey) % p;
    const inverse = modPow((u + 1n) % p, p - 2n, p);
    return toBytesLE((((u - 1n + p) % p) * inverse) % p);
  }

  interface Encrypted {
    priceCt: number[];
    quantityCt: number[];
    publicKey: number[];
    edwardsY: number[];
    nonce: BN;
  }

  /** Encrypts a bid's price and quantity for the MXE, as a browser would. */
  function encryptValues(price: bigint, quantity: bigint, bid: PublicKey): Encrypted {
    const secret = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(secret);
    const cipher = new RescueCipher(x25519.getSharedSecret(secret, mxePublicKey));
    const nonce = bidNonce(bid);
    const [priceCt, quantityCt] = cipher.encrypt([price, quantity], nonce);
    return {
      priceCt: Array.from(priceCt),
      quantityCt: Array.from(quantityCt),
      publicKey: Array.from(publicKey),
      edwardsY: edwardsY(publicKey),
      nonce: new BN(nonce, "le"),
    };
  }

  /** A token bid encrypts only its price; the budget is its deposit. */
  const encryptBid = (price: number, quantity: number, bid: PublicKey) =>
    encryptValues(BigInt(price), BigInt(quantity), bid);

  /** Random canonical field elements: valid on chain, noise to the cluster. */
  function garbageBid(bid: PublicKey): Encrypted {
    const element = () => {
      const bytes = randomBytes(32);
      bytes[31] &= 0x3f;
      return Array.from(bytes);
    };
    const publicKey = x25519.getPublicKey(x25519.utils.randomSecretKey());
    return {
      priceCt: element(),
      quantityCt: element(),
      publicKey: Array.from(publicKey),
      edwardsY: edwardsY(publicKey),
      nonce: new BN(bidNonce(bid), "le"),
    };
  }

  /** The terms a bidder commits to, read from the auction as a browser would. */
  async function termsOf(auction: PublicKey) {
    const a = await program.account.auction.fetch(auction);
    return {
      mint: a.mint,
      supply: a.supply,
      priceUnit: a.priceUnit,
      priceScale: a.priceScale,
      minPrice: a.minPrice,
      minDeposit: a.minDeposit,
      maxPerBid: a.maxPerBid,
      endTime: a.endTime,
    };
  }

  /**
   * What `token_award` gives a token bid with `budget` lamports for its
   * outcome: base units won and lamports paid.
   */
  function tokenAward(a: AuctionState, outcome: number, budget: bigint): [bigint, bigint] {
    const price = BigInt(a.clearingPrice);
    const unit = BigInt(a.priceUnit.toString());
    const supply = BigInt(a.supply.toString());
    const above = BigInt(a.weightAbove.toString());
    const at = BigInt(a.weightAt.toString());
    const affordable = (budget * unit) / price;
    const takeAll = above * unit >= supply * price;
    let won = 0n;
    if (outcome === OUTCOME_ABOVE) {
      won = !a.filled || !takeAll ? affordable : (supply * budget) / above;
    } else if (outcome === OUTCOME_AT && !takeAll) {
      const share = ((supply - (above * unit) / price) * budget) / at;
      won = share < affordable ? share : affordable;
    }
    const cost = (won * price + unit - 1n) / unit;
    return [won, cost < budget ? cost : budget];
  }

  function placeBidIx(
    bidder: PublicKey,
    auction: PublicKey,
    seed: BN,
    terms: Awaited<ReturnType<typeof termsOf>>,
    enc: Encrypted,
    deposit: BN
  ) {
    return program.methods
      .placeBid(seed, terms, enc.priceCt, enc.quantityCt, enc.publicKey, enc.edwardsY, enc.nonce, deposit)
      .accountsPartial({
        bidder,
        auction,
        book: bookPda(auction),
        bid: bidPda(auction, bidder, seed),
        evictedBid: null,
        evictedBidder: null,
      });
  }

  interface PlacedBid {
    name: string;
    kp: Keypair;
    auction: PublicKey;
    bid: PublicKey;
    deposit: number;
  }

  async function placeBid(
    name: string,
    auction: PublicKey,
    deposit: number,
    encrypt: (bid: PublicKey) => Encrypted
  ): Promise<PlacedBid> {
    const kp = Keypair.generate();
    await fund(kp, 0.01 + deposit / LAMPORTS_PER_SOL);
    const seed = newSeed();
    const bid = bidPda(auction, kp.publicKey, seed);
    const enc = encrypt(bid);
    await placeBidIx(kp.publicKey, auction, seed, await termsOf(auction), enc, new BN(deposit))
      .signers([kp])
      .rpc({ commitment: "confirmed" });
    return { name, kp, auction, bid, deposit };
  }

  /** The fees a seller accepts: exactly the current ones. */
  const acceptedFees = () => ({ listingFee: fees.listingFee, saleFeeBps: fees.saleFeeBps });

  /** Terms of a token sale of `tokens` whole tokens, prices per token. */
  const tokenTerms = (tokens: number, minPrice: number, minDeposit: number) => ({
    supply: new BN((BigInt(tokens) * TOKEN).toString()),
    priceUnit: PRICE_UNIT,
    minPrice,
    minDeposit: new BN(minDeposit),
    durationSecs: new BN(DURATION_SECS),
  });

  async function openAuction(seller: Keypair, tokens: number, minPrice = 1_000, minDeposit = 10_000) {
    const supply = BigInt(tokens) * TOKEN;
    const { mint, ownerAta } = await createFixedSupplyToken(seller, supply);
    const seed = newSeed();
    const auction = auctionPda(seller.publicKey, seed);
    const vault = getAssociatedTokenAddressSync(mint, auction, true, TOKEN_2022_PROGRAM_ID);
    const before = await connection.getBalance(fees.treasury, "confirmed");
    await program.methods
      .createAuction(seed, tokenTerms(tokens, minPrice, minDeposit), acceptedFees())
      .accountsPartial({
        seller: seller.publicKey,
        auction,
        book: bookPda(auction),
        mint,
        sellerTokenAccount: ownerAta,
        vault,
        feeConfig: feeConfigPda,
        treasury: fees.treasury,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
    // The listing fee went to the treasury (which may be paying fees of its
    // own elsewhere in the suite, so only when it is not the admin).
    if (!fees.treasury.equals(admin.publicKey)) {
      const after = await connection.getBalance(fees.treasury, "confirmed");
      expect(after - before).to.equal(fees.listingFee.toNumber());
    }
    return { mint, sellerAta: ownerAta, auction, vault, supply };
  }

  function claimProceeds(seller: Keypair, auction: PublicKey, mint: PublicKey, vault: PublicKey, sellerAta: PublicKey) {
    return program.methods
      .claimProceeds()
      .accountsPartial({
        seller: seller.publicKey,
        auction,
        treasury: fees.treasury,
        mint,
        vault,
        sellerTokenAccount: sellerAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
  }

  function cancelAuction(seller: Keypair, auction: PublicKey, mint: PublicKey, vault: PublicKey) {
    return program.methods
      .cancelAuction()
      .accountsPartial({
        seller: seller.publicKey,
        auction,
        treasury: fees.treasury,
        mint,
        vault,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
  }

  /** Splits what is left at the clearing price once every such bid is revealed. */
  function finalizeShare(auction: PublicKey, b: PlacedBid) {
    return program.methods
      .finalizeShare()
      .accountsPartial({ auction, book: bookPda(auction), bid: b.bid })
      .rpc({ commitment: "confirmed" });
  }

  /** Checks every bid, four at a time, in index order. */
  async function checkAll(auction: PublicKey, bids: PlacedBid[]) {
    let stalled = 0;
    for (let last = -1; ; ) {
      const a = await program.account.auction.fetch(auction);
      if (a.checkedCount >= a.bidCount) return;
      // A failed computation leaves the count unchanged; try again a few times.
      stalled = a.checkedCount === last ? stalled + 1 : 0;
      if (stalled > 2) throw new Error(`checking stalled at ${a.checkedCount} of ${a.bidCount}`);
      last = a.checkedCount;
      const batch = bids
        .slice(a.checkedCount, a.checkedCount + BATCH_SIZE)
        .map((b) => ({ pubkey: b.bid, isWritable: false, isSigner: false }));
      const offset = newComputationOffset();
      const signature = await program.methods
        .checkBatch(offset)
        .accountsPartial({
          payer: admin.publicKey,
          auction,
          book: bookPda(auction),
          ...arciumAccounts("check_bids", offset),
        })
        .remainingAccounts(batch)
        .preInstructions([computeLimit(400_000)])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await logUnits("check_batch", signature);
      await finalize(offset);
    }
  }

  async function findClearing(auction: PublicKey) {
    const offset = newComputationOffset();
    const signature = await program.methods
      .findClearing(offset)
      .accountsPartial({
        payer: admin.publicKey,
        auction,
        book: bookPda(auction),
        ...arciumAccounts("clear_price", offset),
      })
      .preInstructions([computeLimit(1_000_000)])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await logUnits("find_clearing", signature);
    await finalize(offset);
    const cleared = await program.account.auction.fetch(auction);
    expect(cleared.status, "cleared").to.deep.equal({ settling: {} });
    return cleared;
  }

  /**
   * Has Arcium draw the seed that shuffles a collection's NFTs. With
   * `preflight`, a refused draw fails in simulation, with the program's error.
   */
  async function drawSeed(auction: PublicKey, preflight = false) {
    const offset = newComputationOffset();
    const signature = await program.methods
      .drawNftSeed(offset)
      .accountsPartial({ payer: admin.publicKey, auction, ...arciumAccounts("draw_seed", offset) })
      .preInstructions([computeLimit(400_000)])
      .rpc({ skipPreflight: !preflight, commitment: "confirmed" });
    await logUnits("draw_nft_seed", signature);
    await finalize(offset);
    return program.account.auction.fetch(auction);
  }

  async function settle(auction: PublicKey, b: PlacedBid) {
    const offset = newComputationOffset();
    const signature = await program.methods
      .settleBid(offset)
      .accountsPartial({
        payer: admin.publicKey,
        auction,
        bid: b.bid,
        book: bookPda(auction),
        ...arciumAccounts("award_bid", offset),
      })
      .preInstructions([computeLimit(400_000)])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await logUnits("settle_bid", signature);
    await finalize(offset);
    return program.account.bid.fetch(b.bid);
  }

  function claimTokens(
    auction: PublicKey,
    seller: PublicKey,
    mint: PublicKey,
    vault: PublicKey,
    b: PlacedBid
  ) {
    return program.methods
      .claimTokens()
      .accountsPartial({
        payer: admin.publicKey,
        auction,
        bid: b.bid,
        bidder: b.kp.publicKey,
        seller,
        mint,
        vault,
        bidderTokenAccount: getAssociatedTokenAddressSync(
          mint,
          b.kp.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });
  }

  function closeBid(b: PlacedBid) {
    return program.methods
      .closeBid()
      .accountsPartial({ bidder: b.kp.publicKey, auction: b.auction, bid: b.bid })
      .rpc({ commitment: "confirmed" });
  }

  /** Closes a finished or cancelled auction and checks the seller got the rent. */
  async function closeAuction(seller: Keypair, auction: PublicKey, mint: PublicKey, vault: PublicKey) {
    const book = bookPda(auction);
    const held =
      (await connection.getBalance(auction, "confirmed")) +
      (await connection.getBalance(book, "confirmed")) +
      (await connection.getBalance(vault, "confirmed"));
    const before = await connection.getBalance(seller.publicKey, "confirmed");
    await program.methods
      .closeAuction()
      .accountsPartial({
        seller: seller.publicKey,
        auction,
        book,
        mint,
        vault,
        sellerTokenAccount: getAssociatedTokenAddressSync(
          mint,
          seller.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
    const after = await connection.getBalance(seller.publicKey, "confirmed");
    // The seller paid the transaction fee out of what came back.
    expect(after - before).to.be.within(held - 10_000, held);
    for (const account of [auction, book, vault]) {
      expect(await connection.getAccountInfo(account, "confirmed")).to.equal(null);
    }
  }

  /** Closes a settled bid and checks that its owner got the refund and rent. */
  async function closeAndCheckRefund(b: PlacedBid, payment: number) {
    const bidLamports = await connection.getBalance(b.bid, "confirmed");
    const rent = await connection.getMinimumBalanceForRentExemption(
      (await connection.getAccountInfo(b.bid, "confirmed"))!.data.length
    );
    expect(bidLamports - rent, `${b.name} refund held`).to.equal(b.deposit - payment);
    const before = await connection.getBalance(b.kp.publicKey, "confirmed");
    await closeBid(b);
    const after = await connection.getBalance(b.kp.publicKey, "confirmed");
    // The admin pays the fee, so the owner receives every lamport in the bid.
    expect(after - before, `${b.name} received`).to.equal(bidLamports);
    expect(await connection.getAccountInfo(b.bid, "confirmed"), `${b.name} closed`).to.equal(null);
  }

  async function tokenBalance(mint: PublicKey, owner: PublicKey) {
    const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
    return (await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  }

  // -------------------------------------------------------------------------
  // One-time platform setup (idempotent so the suite can rerun on devnet)
  // -------------------------------------------------------------------------

  before(async () => {
    for (let attempt = 0; attempt < 20 && !mxePublicKey; attempt++) {
      const key = await getMXEPublicKey(provider, program.programId).catch(() => null);
      if (key) mxePublicKey = key;
      else await sleep(1_000);
    }
    expect(mxePublicKey, "MXE public key").to.not.be.undefined;
    console.log("    MXE x25519 public key:", Buffer.from(mxePublicKey).toString("hex"));

    if (!(await connection.getAccountInfo(configPda))) {
      const programData = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
      )[0];
      await program.methods
        .initialize()
        .accountsPartial({
          authority: admin.publicKey,
          config: configPda,
          program: program.programId,
          programData,
        })
        .rpc({ commitment: "confirmed" });
    }

    // Circuits are hosted off chain and pinned by the hash compiled into the
    // program; the program refuses to register them any other way.
    const baseUrl = process.env.CIRCUIT_BASE_URL?.replace(/\/+$/, "");
    const arciumProgram = getArciumProgram(provider);
    const mxeAccount = getMXEAccAddress(program.programId);
    for (const circuit of CIRCUITS) {
      const compDef = getCompDefAccAddress(
        program.programId,
        Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()
      );
      if (await connection.getAccountInfo(compDef)) continue;
      if (!baseUrl) {
        throw new Error(`Set CIRCUIT_BASE_URL to register the ${circuit} circuit`);
      }
      const mxe = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
      const accounts = {
        payer: admin.publicKey,
        config: configPda,
        mxeAccount,
        compDefAccount: compDef,
        addressLookupTable: getLookupTableAddress(program.programId, mxe.lutOffsetSlot),
      };
      const url = `${baseUrl}/${circuit}.arcis`;
      const builder =
        circuit === "check_bids"
          ? program.methods.initCheckBidsCompDef(url)
          : circuit === "clear_price"
          ? program.methods.initClearPriceCompDef(url)
          : circuit === "award_bid"
          ? program.methods.initAwardBidCompDef(url)
          : program.methods.initDrawSeedCompDef(url);
      await builder.accountsPartial(accounts).rpc({ commitment: "confirmed" });
      console.log(`    Registered ${circuit} from ${url}`);
    }

    // Platform fees: set up once, paid to the admin's wallet, unless the
    // platform already has its own.
    if (!(await connection.getAccountInfo(feeConfigPda))) {
      await program.methods
        .setFees(new BN(DEFAULT_LISTING_FEE), DEFAULT_SALE_FEE_BPS)
        .accountsPartial({
          admin: admin.publicKey,
          config: configPda,
          feeConfig: feeConfigPda,
          treasury: admin.publicKey,
        })
        .rpc({ commitment: "confirmed" });
    }
    fees = await program.account.feeConfig.fetch(feeConfigPda);
    console.log(
      `    Fees: ${fees.listingFee.toNumber() / LAMPORTS_PER_SOL} SOL to open, ` +
        `${fees.saleFeeBps / 100}% of sales, to ${fees.treasury.toBase58()}`
    );
  });

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  it("refuses tokens whose supply is not fixed", async () => {
    const seller = Keypair.generate();
    // Enough for every account create_auction opens, so the only possible
    // failure is the mint check.
    await fund(seller, 0.15);
    const mint = Keypair.generate();
    const sellerAta = getAssociatedTokenAddressSync(mint.publicKey, seller.publicKey);
    const lamports = await connection.getMinimumBalanceForRentExemption(82);
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: seller.publicKey,
          newAccountPubkey: mint.publicKey,
          space: 82,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(mint.publicKey, 0, seller.publicKey, null),
        createAssociatedTokenAccountIdempotentInstruction(
          seller.publicKey,
          sellerAta,
          seller.publicKey,
          mint.publicKey
        ),
        createMintToInstruction(mint.publicKey, sellerAta, seller.publicKey, 1_000)
      ),
      [seller, mint],
      { commitment: "confirmed" }
    );

    const seed = newSeed();
    const auction = auctionPda(seller.publicKey, seed);
    await expectError(
      program.methods
        .createAuction(
          seed,
          {
            supply: new BN(10),
            priceUnit: new BN(1),
            minPrice: 1_000,
            minDeposit: new BN(1_000),
            durationSecs: new BN(DURATION_SECS),
          },
          acceptedFees()
        )
        .accountsPartial({
          seller: seller.publicKey,
          auction,
          mint: mint.publicKey,
          sellerTokenAccount: sellerAta,
          vault: getAssociatedTokenAddressSync(mint.publicKey, auction, true),
          feeConfig: feeConfigPda,
          treasury: fees.treasury,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([seller])
        .rpc({ commitment: "confirmed" }),
      "MintAuthorityActive"
    );
  });

  it("refuses copied, malformed and unusable bids", async () => {
    const seller = Keypair.generate();
    await fund(seller, 0.15);
    const { mint, auction, vault } = await openAuction(seller, 10);
    const terms = await termsOf(auction);

    const victim = Keypair.generate();
    const attacker = Keypair.generate();
    await fund(attacker, 0.02);
    const victimBid = bidPda(auction, victim.publicKey, newSeed());
    const copied = encryptBid(3_000, 0, victimBid);
    const deposit = new BN(50_000);

    const attempt = (enc: Encrypted, seed = newSeed(), withTerms = terms, amount = deposit) =>
      placeBidIx(attacker.publicKey, auction, seed, withTerms, enc, amount)
        .signers([attacker])
        .rpc({ commitment: "confirmed" });

    // A ciphertext copied from someone else's bid carries their nonce.
    await expectError(attempt(copied), "InvalidNonce");

    // With the right nonce, a non-canonical field element is refused...
    const seed = newSeed();
    const good = encryptBid(3_000, 0, bidPda(auction, attacker.publicKey, seed));
    const modulus = toBytesLE(FIELD_MODULUS);
    await expectError(attempt({ ...good, priceCt: modulus }, seed), "InvalidCiphertext");
    await expectError(attempt({ ...good, quantityCt: modulus }, seed), "InvalidCiphertext");
    // ...and so are encryption keys the cluster would refuse: a small-order
    // key, a point on the curve's twist, and a valid key with a wrong hint.
    const zero = new Array(32).fill(0);
    await expectError(attempt({ ...good, publicKey: zero, edwardsY: edwardsY(zero) }, seed), "InvalidEncryptionKey");
    const twist = toBytesLE(2n);
    await expectError(attempt({ ...good, publicKey: twist, edwardsY: edwardsY(twist) }, seed), "InvalidEncryptionKey");
    const wrongHint = [...good.edwardsY];
    wrongHint[0] ^= 1;
    await expectError(attempt({ ...good, edwardsY: wrongHint }, seed), "InvalidEncryptionKey");
    // A bid made for other terms is refused too, and so is one below the
    // smallest deposit.
    await expectError(attempt(good, seed, { ...terms, endTime: terms.endTime.addn(1) }), "TermsMismatch");
    await expectError(attempt(good, seed, { ...terms, minPrice: terms.minPrice - 1 }), "TermsMismatch");
    await expectError(attempt(good, seed, terms, terms.minDeposit.subn(1)), "DepositTooSmall");

    // Nothing was placed, so the seller can withdraw and close the auction.
    expect((await program.account.auction.fetch(auction)).bidCount).to.equal(0);
    await cancelAuction(seller, auction, mint, vault);
    expect(await connection.getAccountInfo(vault, "confirmed")).to.equal(null);
    await closeAuction(seller, auction, mint, vault);
  });

  it("runs a full sealed uniform-price token sale", async () => {
    const seller = Keypair.generate();
    await fund(seller, 0.15);
    const { mint, sellerAta, auction, vault, supply } = await openAuction(seller, 100);
    expect(
      (await getAccount(connection, vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount
    ).to.equal(supply);

    const plan = [
      { name: "A", budget: 120_000, price: 5_000, outcome: OUTCOME_ABOVE, tokens: 40 },
      { name: "B", budget: 60_000, price: 4_000, outcome: OUTCOME_ABOVE, tokens: 20 },
      { name: "C", budget: 200_000, price: 3_000, outcome: OUTCOME_AT, tokens: 40 },
      { name: "D", budget: 30_000, price: 2_000, outcome: OUTCOME_NONE, tokens: 0 },
      { name: "E", budget: 50_000, price: 800, outcome: OUTCOME_NONE, tokens: 0 },
    ];
    const clearingPrice = 3_000;
    const bids: PlacedBid[] = [];
    for (const p of plan) {
      bids.push(await placeBid(p.name, auction, p.budget, (bid) => encryptBid(p.price, 0, bid)));
    }

    // Bids are sealed: no price is visible on chain, only each deposit and
    // their total.
    const stored = await program.account.bid.fetch(bids[0].bid);
    expect(stored.deposit.toNumber()).to.equal(plan[0].budget);
    expect(stored.index).to.equal(0);
    const totalDeposited = plan.reduce((sum, p) => sum + p.budget, 0);
    expect((await program.account.auction.fetch(auction)).totalDeposited.toNumber()).to.equal(totalDeposited);

    // After the deadline, every bid is checked, then the price is found.
    const opened = await program.account.auction.fetch(auction);
    await waitForValidatorTime(opened.endTime.toNumber());
    await checkAll(auction, bids);
    expect((await program.account.auction.fetch(auction)).checkedCount).to.equal(plan.length);

    const cleared = await findClearing(auction);
    expect(cleared.clearingPrice).to.equal(clearingPrice);
    expect(cleared.filled).to.equal(true);
    expect(cleared.weightAbove.toNumber()).to.equal(180_000);
    expect(cleared.weightAt.toNumber()).to.equal(200_000);

    // Settlement only records what each bid won and moves its payment; it
    // never touches the bidders' accounts.
    for (const [i, b] of bids.entries()) {
      const settled = await settle(auction, b);
      const p = plan[i];
      expect(settled.status, p.name).to.deep.equal({ settled: {} });
      expect(settled.outcome, p.name).to.equal(p.outcome);
      expect(settled.won.toString(), p.name).to.equal((BigInt(p.tokens) * TOKEN).toString());
      expect(settled.payment.toNumber(), p.name).to.equal(p.tokens * clearingPrice);
      expect(settled.delivered, p.name).to.equal(false);
    }
    const settledAuction = await program.account.auction.fetch(auction);
    expect(settledAuction.sold.toString()).to.equal(supply.toString());
    expect(settledAuction.proceeds.toNumber()).to.equal(100 * clearingPrice);
    expect(settledAuction.resolvedCount).to.equal(plan.length);

    // A winner's bid cannot be closed before its tokens are delivered, and a
    // losing bid has no tokens to claim.
    await expectError(closeBid(bids[0]), "TokensUnclaimed");
    await expectError(claimTokens(auction, seller.publicKey, mint, vault, bids[3]), "NothingToClaim");

    // Anyone (here the admin) delivers A's and B's tokens and closes their bids.
    for (const i of [0, 1]) {
      await claimTokens(auction, seller.publicKey, mint, vault, bids[i]);
      expect(await tokenBalance(mint, bids[i].kp.publicKey), bids[i].name).to.equal(
        BigInt(plan[i].tokens) * TOKEN
      );
      await expectError(claimTokens(auction, seller.publicKey, mint, vault, bids[i]), "AlreadyClaimed");
      await closeAndCheckRefund(bids[i], plan[i].tokens * clearingPrice);
    }

    // The seller is paid, less the sale fee, while C's tokens are still
    // owed: they stay in escrow.
    const proceeds = 100 * clearingPrice;
    const sellerBefore = await connection.getBalance(seller.publicKey, "confirmed");
    await claimProceeds(seller, auction, mint, vault, sellerAta);
    const sellerAfter = await connection.getBalance(seller.publicKey, "confirmed");
    // The admin, as the provider's wallet, pays the transaction fee.
    expect(sellerAfter - sellerBefore).to.equal(proceeds - saleFee(proceeds));
    expect((await program.account.auction.fetch(auction)).status).to.deep.equal({ finished: {} });
    expect(
      (await getAccount(connection, vault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount
    ).to.equal(BigInt(plan[2].tokens) * TOKEN);

    // Delivering the last tokens closes the vault and returns its rent.
    const vaultRent = await connection.getBalance(vault, "confirmed");
    const sellerBeforeLast = await connection.getBalance(seller.publicKey, "confirmed");
    await claimTokens(auction, seller.publicKey, mint, vault, bids[2]);
    expect(await connection.getAccountInfo(vault, "confirmed")).to.equal(null);
    expect((await connection.getBalance(seller.publicKey, "confirmed")) - sellerBeforeLast).to.equal(vaultRent);
    expect((await program.account.auction.fetch(auction)).delivered.toString()).to.equal(supply.toString());

    // Everyone else collects their refund, then the seller reclaims the rent.
    for (const i of [2, 3, 4]) {
      await closeAndCheckRefund(bids[i], plan[i].tokens * clearingPrice);
    }
    await closeAuction(seller, auction, mint, vault);
  });

  it("sells at the minimum price when demand falls short, decoding each bid once", async () => {
    // 1_000 tokens at the minimum price of 1_000 would take 1 SOL; the
    // budgets here add up to 190_000 lamports at most. H is honest. M
    // encrypts price = 2^32 + 3_000 and N price = p - 2^47, which no browser
    // produces; G is random field elements. The cluster may read each as
    // some price or as no bid, but it decodes each once, so the clearing and
    // every settlement must agree.
    const seller = Keypair.generate();
    await fund(seller, 0.15);
    const { mint, sellerAta, auction, vault, supply } = await openAuction(seller, 1_000);

    const honest = await placeBid("H", auction, 100_000, (bid) => encryptBid(2_000, 0, bid));
    const malformed = await placeBid("M", auction, 30_000, (bid) =>
      encryptValues((1n << 32n) + 3_000n, 0n, bid)
    );
    const nearModulus = await placeBid("N", auction, 30_000, (bid) =>
      encryptValues(FIELD_MODULUS - (1n << 47n), 0n, bid)
    );
    const garbage = await placeBid("G", auction, 30_000, garbageBid);
    const bids = [honest, malformed, nearModulus, garbage];

    const opened = await program.account.auction.fetch(auction);
    await waitForValidatorTime(opened.endTime.toNumber());
    await checkAll(auction, bids);
    const cleared = await findClearing(auction);
    expect(cleared.filled).to.equal(false);
    expect(cleared.clearingPrice).to.equal(1_000);
    expect(cleared.weightAt.toNumber()).to.equal(0);
    // Without a fill, the demand above is every valid budget: H's and those
    // of the others the cluster read as bids.
    const above = cleared.weightAbove.toNumber();
    const others = (above - 100_000) / 30_000;
    expect([0, 1, 2, 3]).to.include(others);

    let counted = 0;
    const read: string[] = [];
    for (const b of bids) {
      const settled = await settle(auction, b);
      expect(settled.status, b.name).to.deep.equal({ settled: {} });
      expect([OUTCOME_NONE, OUTCOME_ABOVE], b.name).to.include(settled.outcome);
      const [won, payment] = tokenAward(cleared, settled.outcome, BigInt(b.deposit));
      expect(settled.won.toString(), b.name).to.equal(won.toString());
      expect(settled.payment.toString(), b.name).to.equal(payment.toString());
      if (settled.outcome === OUTCOME_ABOVE) {
        counted += b.deposit;
        if (b !== honest) read.push(b.name);
      }
    }
    expect(counted, "settled budgets match the clearing").to.equal(above);
    console.log(`    The cluster read ${read.length ? read.join(", ") : "none of M, N and G"} as bids.`);
    // H spends its whole budget on 100 tokens at the minimum price.
    const h = await program.account.bid.fetch(honest.bid);
    expect(h.outcome).to.equal(OUTCOME_ABOVE);
    expect(h.won.toString()).to.equal((100n * TOKEN).toString());
    expect(h.payment.toNumber()).to.equal(100_000);

    // Winners collect, everyone closes their bid, and the seller gets the
    // proceeds and every unsold token back.
    for (const b of bids) {
      const settled = await program.account.bid.fetch(b.bid);
      if (settled.won.gtn(0)) await claimTokens(auction, seller.publicKey, mint, vault, b);
      await closeAndCheckRefund(b, settled.payment.toNumber());
    }
    const final = await program.account.auction.fetch(auction);
    expect(final.proceeds.toNumber()).to.equal(above);
    const sold = BigInt(final.sold.toString());
    const sellerBefore = await connection.getBalance(seller.publicKey, "confirmed");
    await claimProceeds(seller, auction, mint, vault, sellerAta);
    const sellerAfter = await connection.getBalance(seller.publicKey, "confirmed");
    const vaultRentBack = sellerAfter - sellerBefore - (above - saleFee(above));
    expect(vaultRentBack, "the empty vault's rent").to.be.greaterThan(0);
    expect(await tokenBalance(mint, seller.publicKey)).to.equal(supply - sold);
    expect(await connection.getAccountInfo(vault, "confirmed")).to.equal(null);
    await closeAuction(seller, auction, mint, vault);
  });

  it("lets only the admin feature an auction", async () => {
    const seller = Keypair.generate();
    await fund(seller, 0.15);
    const { mint, auction, vault } = await openAuction(seller, 10);
    const outsider = Keypair.generate();
    await fund(outsider, 0.01);
    await expectError(
      program.methods
        .setListing(true, false)
        .accountsPartial({ admin: outsider.publicKey, config: configPda, auction })
        .signers([outsider])
        .rpc({ commitment: "confirmed" }),
      "Unauthorized"
    );
    // Once the role has been handed to another wallet, this wallet is an
    // outsider too.
    const config = await program.account.config.fetch(configPda);
    if (config.admin.equals(admin.publicKey)) {
      await program.methods
        .setListing(true, false)
        .accountsPartial({ admin: admin.publicKey, config: configPda, auction })
        .rpc({ commitment: "confirmed" });
      expect((await program.account.auction.fetch(auction)).featured).to.equal(true);
    } else {
      console.log(`    The admin is ${config.admin.toBase58()}; only the refusal was checked.`);
    }

    await cancelAuction(seller, auction, mint, vault);
    await closeAuction(seller, auction, mint, vault);
  });

  it("sells a collection at one price and shares the last NFTs among tied bids", async () => {
    const seller = Keypair.generate();
    await fund(seller, 0.15);
    const seed = newSeed();
    const auction = auctionPda(seller.publicKey, seed);
    const book = bookPda(auction);
    const collection = PublicKey.findProgramAddressSync(
      [Buffer.from("collection"), auction.toBuffer()],
      program.programId
    )[0];
    // Four NFTs, at least 500 ticks (0.0005 SOL) each, at most two per bid.
    await program.methods
      .createCollectionAuction(
        seed,
        { supply: new BN(4), minPrice: 500, maxPerBid: 2, durationSecs: new BN(DURATION_SECS) },
        acceptedFees(),
        {
          name: "Veiling Test Cats",
          uri: "https://example.com/cats/collection.json",
          itemName: "Test Cat",
          itemUri: "https://example.com/cats/",
          uriPerItem: true,
          royaltyBps: 500,
          hidden: false,
        }
      )
      .accountsPartial({
        seller: seller.publicKey,
        auction,
        book,
        collection,
        feeConfig: feeConfigPda,
        treasury: fees.treasury,
        mplCoreProgram: MPL_CORE_ID,
        // Named the usual way, so without an item list.
        itemList: null,
      })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
    const opened = await program.account.auction.fetch(auction);
    expect(opened.kind).to.deep.equal({ collection: {} });
    expect(opened.mint.equals(collection)).to.equal(true);
    expect(opened.priceScale.toNumber()).to.equal(NFT_PRICE_SCALE);
    expect(opened.minDeposit.toNumber()).to.equal(500 * NFT_PRICE_SCALE);
    const created = await connection.getAccountInfo(collection, "confirmed");
    expect(created!.owner.equals(MPL_CORE_ID)).to.equal(true);
    // CollectionV1, with this auction as its update authority for now.
    expect(created!.data[0]).to.equal(5);
    expect(new PublicKey(created!.data.subarray(1, 33)).equals(auction)).to.equal(true);

    // Prices are in ticks of 1_000 lamports per NFT.
    const tick = NFT_PRICE_SCALE;
    const plan = [
      { name: "T", nfts: 2, price: 1_500, deposit: 3_000 * tick, won: 2 },
      { name: "P", nfts: 1, price: 1_000, deposit: 1_200 * tick, won: 1 },
      { name: "Q", nfts: 1, price: 1_000, deposit: 1_200 * tick, won: 1 },
      { name: "R", nfts: 1, price: 1_000, deposit: 1_200 * tick, won: 0 },
      // More NFTs than one bid may ask for.
      { name: "U", nfts: 3, price: 2_000, deposit: 6_000 * tick, won: 0 },
      // A deposit that covers one NFT at its price, not two.
      { name: "V", nfts: 2, price: 1_800, deposit: 1_800 * tick, won: 0 },
    ];
    const bids: PlacedBid[] = [];
    for (const p of plan) {
      bids.push(await placeBid(p.name, auction, p.deposit, (bid) => encryptBid(p.price, p.nfts, bid)));
    }
    await waitForValidatorTime(opened.endTime.toNumber());
    await checkAll(auction, bids);
    // Above 1_000 only T's 2 NFTs are wanted; at 1_000, P, Q and R add 3.
    const cleared = await findClearing(auction);
    expect(cleared.clearingPrice).to.equal(1_000);
    expect(cleared.filled).to.equal(true);
    expect(cleared.weightAbove.toNumber()).to.equal(2);
    expect(cleared.weightAt.toNumber()).to.equal(3);
    const price = 1_000 * tick;

    // T settles at once and pays the clearing price, not its own; P, Q and
    // R wait for each other; U and V get nothing.
    for (const [i, b] of bids.entries()) {
      const settled = await settle(auction, b);
      if (["P", "Q", "R"].includes(b.name)) {
        expect(settled.status, b.name).to.deep.equal({ atClearing: {} });
        expect(settled.won.toNumber(), b.name).to.equal(0);
        continue;
      }
      expect(settled.status, b.name).to.deep.equal({ settled: {} });
      expect(settled.won.toNumber(), b.name).to.equal(plan[i].won);
      expect(settled.payment.toNumber(), b.name).to.equal(plan[i].won * price);
    }
    // Once the last of them is revealed, the 2 NFTs left count as sold.
    const revealed = await program.account.auction.fetch(auction);
    expect(revealed.atRevealed.toNumber()).to.equal(3);
    expect(revealed.sold.toNumber()).to.equal(4);
    // One NFT each would round down to nothing; the earliest two get one.
    for (const b of [bids[3], bids[1], bids[2]]) await finalizeShare(auction, b);
    const won = await Promise.all(
      bids.map(async (b) => (await program.account.bid.fetch(b.bid)).won.toNumber())
    );
    expect(won).to.deep.equal(plan.map((p) => p.won));
    expect((await program.account.auction.fetch(auction)).proceeds.toNumber()).to.equal(4 * price);

    // Each winner took the next places as it settled: T first, then the
    // shares in the order they were finalized.
    const firstPositions = await Promise.all(
      bids.map(async (b) => (await program.account.bid.fetch(b.bid)).firstPosition)
    );
    expect([0, 1, 2, 3, 4, 5].filter((i) => won[i] > 0).map((i) => firstPositions[i])).to.deep.equal([0, 2, 3]);
    const mintNfts = (b: PlacedBid, assets: PublicKey[]) =>
      program.methods
        .claimNfts()
        .accountsPartial({
          payer: admin.publicKey,
          auction,
          bid: b.bid,
          bidder: b.kp.publicKey,
          collection,
          mplCoreProgram: MPL_CORE_ID,
          itemList: null,
        })
        .remainingAccounts(assets.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
        .preInstructions([computeLimit(400_000)])
        .rpc({ commitment: "confirmed" });

    // Nothing is minted before Arcium shuffles the NFTs; then the seed is
    // drawn once and only once.
    await expectError(mintNfts(bids[0], [assetPda(auction, 0)]), "NftsNotShuffled");
    const shuffled = await drawSeed(auction);
    expect(shuffled.seedDrawn).to.equal(true);
    const nftSeed = BigInt(shuffled.nftSeed.toString());
    console.log(`    NFT seed ${nftSeed.toString(16)}`);
    await expectError(drawSeed(auction, true), "SeedAlreadyDrawn");

    // Anyone (here the admin) mints each winner's NFTs to them; each place
    // becomes the NFT the shuffle gives it.
    const numbers: number[] = [];
    for (const [i, b] of bids.entries()) {
      if (won[i] === 0) continue;
      const places = Array.from({ length: won[i] }, (_, k) => firstPositions[i] + k);
      const assets = places.map((place) => assetPda(auction, place));
      await mintNfts(b, assets);
      const items = shuffledItems(places, 4, nftSeed);
      for (const [k, asset] of assets.entries()) {
        const nft = (await connection.getAccountInfo(asset, "confirmed"))!;
        expect(nft.owner.equals(MPL_CORE_ID)).to.equal(true);
        expect(new PublicKey(nft.data.subarray(1, 33)).equals(b.kp.publicKey), b.name).to.equal(true);
        // AssetV1: key, owner, update authority (kind + collection), then the name.
        const nameLength = nft.data.readUInt32LE(66);
        const name = nft.data.subarray(70, 70 + nameLength).toString("utf8");
        expect(name, b.name).to.equal(`Test Cat #${items[k] + 1}`);
        numbers.push(items[k] + 1);
      }
    }
    console.log(`    NFTs by winner: ${numbers.join(", ")}`);
    expect([...numbers].sort((x, y) => x - y)).to.deep.equal([1, 2, 3, 4]);
    for (const [i, b] of bids.entries()) {
      await closeAndCheckRefund(b, won[i] * price);
    }

    // The seller is paid less the sale fee, and closing hands over the
    // collection.
    const proceeds = 4 * price;
    const before = await connection.getBalance(seller.publicKey, "confirmed");
    await program.methods
      .claimCollectionProceeds()
      .accountsPartial({ seller: seller.publicKey, auction, treasury: fees.treasury })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
    const after = await connection.getBalance(seller.publicKey, "confirmed");
    // The admin, as the provider's wallet, pays the transaction fee.
    expect(after - before).to.equal(proceeds - saleFee(proceeds));
    await program.methods
      .closeCollectionAuction()
      .accountsPartial({ seller: seller.publicKey, auction, book, collection, mplCoreProgram: MPL_CORE_ID, itemList: null })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
    const handedOver = (await connection.getAccountInfo(collection, "confirmed"))!;
    expect(new PublicKey(handedOver.data.subarray(1, 33)).equals(seller.publicKey)).to.equal(true);
    expect(await connection.getAccountInfo(auction, "confirmed")).to.equal(null);
  });

  it("names NFTs per item, and mints a hidden collection only once it is revealed", async () => {
    const seller = Keypair.generate();
    await fund(seller, 0.15);
    const seed = newSeed();
    const auction = auctionPda(seller.publicKey, seed);
    const book = bookPda(auction);
    const collection = collectionPda(auction);
    const itemList = itemListPda(auction);

    // Five NFTs: two editions of the first item, the only Lale, two Çini.
    const items = [
      { name: "Gün Batımı", supply: 2 },
      { name: "Lale", supply: 1 },
      { name: "Çini", supply: 2 },
    ];
    await program.methods
      .initItemList(seed)
      .accountsPartial({ seller: seller.publicKey, auction, itemList })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
    await program.methods
      .addItems(items)
      .accountsPartial({ seller: seller.publicKey, itemList })
      .signers([seller])
      .rpc({ commitment: "confirmed" });

    // The metadata's address is fixed now; its files need not exist until
    // the seller reveals them.
    const itemUri = `https://arweave.net/${randomBytes(32).toString("base64url")}/`;
    await program.methods
      .createCollectionAuction(
        seed,
        { supply: new BN(5), minPrice: 500, maxPerBid: 3, durationSecs: new BN(DURATION_SECS) },
        acceptedFees(),
        {
          name: "Veiling Test Tiles",
          uri: "https://example.com/tiles/collection.json",
          itemName: "Test Tile",
          itemUri,
          uriPerItem: true,
          royaltyBps: 0,
          hidden: true,
        }
      )
      .accountsPartial({
        seller: seller.publicKey,
        auction,
        book,
        collection,
        feeConfig: feeConfigPda,
        treasury: fees.treasury,
        mplCoreProgram: MPL_CORE_ID,
        itemList,
      })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
    const opened = await program.account.auction.fetch(auction);
    expect(opened.namedItems).to.equal(true);
    expect(opened.unrevealed).to.equal(true);
    const list = await program.account.itemList.fetch(itemList);
    expect([list.count, list.total, list.sealed]).to.deep.equal([3, 5, true]);

    // A wants 3 NFTs at up to 1_000 ticks, B 2 at up to 800: all five sell
    // at 800.
    const tick = NFT_PRICE_SCALE;
    const plan = [
      { name: "A", nfts: 3, price: 1_000, deposit: 3_000 * tick, won: 3 },
      { name: "B", nfts: 2, price: 800, deposit: 1_600 * tick, won: 2 },
    ];
    const bids: PlacedBid[] = [];
    for (const p of plan) {
      bids.push(await placeBid(p.name, auction, p.deposit, (bid) => encryptBid(p.price, p.nfts, bid)));
    }
    await waitForValidatorTime(opened.endTime.toNumber());
    await checkAll(auction, bids);
    const cleared = await findClearing(auction);
    expect(cleared.clearingPrice).to.equal(800);
    const price = 800 * tick;
    expect((await settle(auction, bids[0])).won.toNumber()).to.equal(3);
    expect((await settle(auction, bids[1])).status).to.deep.equal({ atClearing: {} });
    await finalizeShare(auction, bids[1]);
    const shuffled = await drawSeed(auction);
    const nftSeed = BigInt(shuffled.nftSeed.toString());

    const firstPositions = await Promise.all(
      bids.map(async (b) => (await program.account.bid.fetch(b.bid)).firstPosition)
    );
    const mintNfts = (b: PlacedBid, assets: PublicKey[]) =>
      program.methods
        .claimNfts()
        .accountsPartial({
          payer: admin.publicKey,
          auction,
          bid: b.bid,
          bidder: b.kp.publicKey,
          collection,
          mplCoreProgram: MPL_CORE_ID,
          itemList,
        })
        .remainingAccounts(assets.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
        .preInstructions([computeLimit(400_000)])
        .rpc({ commitment: "confirmed" });

    // Until the seller reveals, nothing can be minted and the seller is not
    // paid; while the seller still has time, winners cannot take their
    // payments back either.
    await expectError(mintNfts(bids[0], [assetPda(auction, firstPositions[0])]), "NotRevealed");
    await expectError(
      program.methods
        .claimCollectionProceeds()
        .accountsPartial({ seller: seller.publicKey, auction, treasury: fees.treasury })
        .signers([seller])
        .rpc({ commitment: "confirmed" }),
      "NotRevealed"
    );
    await expectError(
      program.methods.refundUnrevealed().accountsPartial({ auction, bid: bids[0].bid }).rpc({ commitment: "confirmed" }),
      "TooEarly"
    );
    const reveal = () =>
      program.methods
        .revealCollection()
        .accountsPartial({ seller: seller.publicKey, auction })
        .signers([seller])
        .rpc({ commitment: "confirmed" });
    await reveal();
    expect((await program.account.auction.fetch(auction)).unrevealed).to.equal(false);
    await expectError(reveal(), "AlreadyRevealed");

    // Each NFT reads the committed link and is named after its item.
    const names: string[] = [];
    for (const [i, b] of bids.entries()) {
      const places = Array.from({ length: plan[i].won }, (_, k) => firstPositions[i] + k);
      const assets = places.map((place) => assetPda(auction, place));
      await mintNfts(b, assets);
      const numbers = shuffledItems(places, 5, nftSeed);
      for (const [k, asset] of assets.entries()) {
        const nft = (await connection.getAccountInfo(asset, "confirmed"))!;
        expect(new PublicKey(nft.data.subarray(1, 33)).equals(b.kp.publicKey), b.name).to.equal(true);
        const { name, uri } = readAsset(nft.data);
        expect(uri).to.equal(`${itemUri}${numbers[k]}.json`);
        names[numbers[k]] = name;
      }
    }
    console.log(`    NFTs: ${names.join(", ")}`);
    expect(names).to.deep.equal(["Gün Batımı #1", "Gün Batımı #2", "Lale", "Çini #1", "Çini #2"]);
    for (const [i, b] of bids.entries()) {
      await closeAndCheckRefund(b, plan[i].won * price);
    }

    // The seller is paid, and the item list closes with the auction.
    const proceeds = 5 * price;
    const before = await connection.getBalance(seller.publicKey, "confirmed");
    await program.methods
      .claimCollectionProceeds()
      .accountsPartial({ seller: seller.publicKey, auction, treasury: fees.treasury })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
    const after = await connection.getBalance(seller.publicKey, "confirmed");
    expect(after - before).to.equal(proceeds - saleFee(proceeds));
    await program.methods
      .closeCollectionAuction()
      .accountsPartial({ seller: seller.publicKey, auction, book, collection, mplCoreProgram: MPL_CORE_ID, itemList })
      .signers([seller])
      .rpc({ commitment: "confirmed" });
    expect(await connection.getAccountInfo(itemList, "confirmed")).to.equal(null);
    expect(await connection.getAccountInfo(auction, "confirmed")).to.equal(null);
  });
});
