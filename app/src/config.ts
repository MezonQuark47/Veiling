import { PublicKey } from "@solana/web3.js";

/** The deployed sealed_auction program. */
export const PROGRAM_ID = new PublicKey("CjUVaVK3jF9o4EehHWtB13TGg9SPXBWKGBepmZHwyLK2");

/** Arcium's public devnet cluster. */
export const CLUSTER_OFFSET = 456;

/**
 * The MXE's x25519 encryption key (hex). Bids are only encrypted when the key
 * read from chain matches this one, so a misbehaving RPC cannot swap in its
 * own key and read bids. If the cluster ever rotates the key, update it here.
 * Empty means "trust the chain" and is only meant for local development.
 */
export const MXE_X25519_PUBLIC_KEY: string = "3af7353bdb51c48ff2af7fe35b740509b4bb4fa4feb756e5b68389f2c9047f3d";

export const RPC_URL: string = import.meta.env.VITE_RPC_URL || "https://api.devnet.solana.com";
/**
 * Where the keeper (scripts/keeper.ts) serves all-time totals and points,
 * e.g. https://stats.veiling.xyz/stats.json. Without it the site shows what
 * is on chain right now, and no Stats page data.
 */
export const STATS_URL: string | null = import.meta.env.VITE_STATS_URL || null;
export const WALLET_CHAIN = "solana:devnet";
const MAINNET = (WALLET_CHAIN as string) === "solana:mainnet";
/** Shown in the header on a test network, so nobody takes it for mainnet; empty on mainnet. */
export const NETWORK_LABEL = MAINNET ? "" : "Devnet";
/** What explorer links add to point at this network. */
export const EXPLORER_CLUSTER = MAINNET ? "" : "?cluster=devnet";

// Must match the on-chain program and circuits.
export const BATCH_SIZE = 4;
/** Bids one page of an auction's bid book holds. */
export const PAGE_BIDS = 256;
/**
 * Pages a bid book can have. It opens new ones as it fills: up to 4 for a
 * token auction (1,024 bids) and 40 for a collection (10,240 bids, so even a
 * 10,000-NFT collection can sell out at one NFT per bid). Either way it is
 * one auction with one final price.
 */
export const MAX_TOKEN_PAGES = 4;
export const MAX_COLLECTION_PAGES = 40;
/** Most bids an auction can hold, with every page open. */
export const MAX_TOKEN_BIDS = PAGE_BIDS * MAX_TOKEN_PAGES;
export const MAX_COLLECTION_BIDS = PAGE_BIDS * MAX_COLLECTION_PAGES;
/** Pages a seller can pay for ahead of time (`add_book_page`). */
export const MAX_PREPAID_PAGES = 4;
/** Passes of the clearing across pages, each fixing four bits of the price. */
export const FOLD_PASSES = 8;
/** What one step of that clearing pays its caller, as a share of the clearing reward. */
export const FOLD_REWARD_PERCENT = 100n;
/** A bid into a full auction must out-deposit the smallest bid by this much. */
export const EVICTION_PREMIUM_PERCENT = 10n;
/** Soft close: a replacement this close to the end pushes the end this far away... */
export const SOFT_CLOSE_SECS = 10 * 60;
/** ...but never more than this past the end the auction opened with. */
export const MAX_SOFT_CLOSE_EXTENSION_SECS = 24 * 60 * 60;
export const PENDING_TIMEOUT_SECS = 30 * 60;
export const EMERGENCY_DELAY_SECS = 3 * 24 * 60 * 60;
/** The same for a fair launch (`LAUNCH_EMERGENCY_DELAY_SECS`). */
export const LAUNCH_EMERGENCY_DELAY_SECS = 24 * 60 * 60;

/** Fair launches (`create_launch_mint`, `create_launch`). */
export const LAUNCH_DECIMALS = 6;
/** A billion tokens, in base units; half is sold, half seeds the pool. */
export const LAUNCH_SUPPLY = 1_000_000_000n * 1_000_000n;
export const LAUNCH_SALE_SUPPLY = LAUNCH_SUPPLY / 2n;
/** Smallest bid: 0.1 SOL. */
export const LAUNCH_MIN_BID = 100_000_000n;
/** Smallest graduation target: 10 SOL. */
export const LAUNCH_MIN_RAISE = 10_000_000_000n;
/** How long bidding may run, in hours. */
export const LAUNCH_HOURS = [1, 2, 5] as const;
export const MAX_LAUNCH_NAME_LEN = 32;
export const MAX_LAUNCH_SYMBOL_LEN = 10;
/** A launch's pool takes every lamport raised. */
export const LAUNCH_LP_BPS = 10_000;
export const BID_NONCE_DOMAIN = "sealed-auction/bid-nonce/v1";
export const MIN_DURATION_SECS = 60;
export const MAX_DURATION_SECS = 14 * 24 * 60 * 60;
/** How far ahead an auction can schedule the start of bidding. */
export const MAX_START_DELAY_SECS = 30 * 24 * 60 * 60;

/** Prices are whole "price ticks", a u32. */
export const MAX_PRICE_TICKS = 4_294_967_295n;
/** Token prices refer to a power of ten of base units, at most this. */
export const MAX_PRICE_UNIT_EXPONENT = 16;
/**
 * The app picks a token auction's price unit so that its minimum price is at
 * least this many ticks: fine enough for any price a bidder types, with room
 * for bids tens of thousands of times higher.
 */
export const TARGET_MIN_PRICE_TICKS = 10_000n;
/** Lamports per price tick of a collection auction: prices go in steps of 0.000001 SOL. */
export const NFT_PRICE_SCALE = 1_000n;

// NFT collections, sold through Metaplex Core.
export const MPL_CORE_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const MAX_COLLECTION_SIZE = 10_000;
/** NFTs minted per transaction when a winner collects. */
export const MAX_NFTS_PER_CLAIM = 5;
export const MAX_ROYALTY_BPS = 1_000;
export const MAX_COLLECTION_NAME_LEN = 32;
export const MAX_ITEM_NAME_LEN = 24;
export const MAX_URI_LEN = 200;
/** How long after bidding ends the seller of a hidden drop has to reveal it; winners are refunded after that. */
export const REVEAL_DELAY_SECS = 7 * 24 * 60 * 60;
/** Most items a collection's item list holds; each has its own name and editions. */
export const MAX_ITEMS = 500;
/** Rent and Metaplex's fee for one NFT, paid by whoever mints it (measured). */
export const NFT_MINT_COST_LAMPORTS = 3_300_000n;

// Image uploads. Files go to Arweave through ArDrive Turbo, which stores small
// files for free: each up to 105 KiB, 10 MiB in all per wallet and per
// network connection (its /v1/info lists the current limits).
export const UPLOAD_SERVICE_URL = "https://upload.ardrive.io";
/**
 * The gateway written into uploaded metadata and on-chain links. It serves a
 * new upload a few minutes after it is made (about seven in testing).
 */
export const ARWEAVE_GATEWAY = "https://arweave.net";
/** An AR.IO gateway that serves new uploads at once; the app shows them from here until arweave.net has them. */
export const FRESH_ARWEAVE_GATEWAY = "https://ardrive.net";
/** Images are fitted under this many bytes, leaving room for the upload's own header. */
export const MAX_IMAGE_BYTES = 100 * 1024;
/** The free tier's limit on one upload, header included. */
export const FREE_UPLOAD_ITEM_BYTES = 105 * 1024;
/** The free tier's lifetime allowance per wallet and per connection. */
export const FREE_UPLOAD_TOTAL_BYTES = 10 * 1024 * 1024;
/** One image per NFT can be uploaded for up to this many NFTs, as on OpenSea. */
export const MAX_UPLOADED_ITEMS = 10_000;

// Paid storage. Sellers who keep their original files, or upload more than
// the free allowance, buy Turbo storage credit with SOL from their wallet.
// The payment goes to Turbo's Solana address below, which is checked against
// what the service reports before anything is sent. On Devnet these are
// Turbo's test services: they take devnet SOL and serve files from their own
// gateway.
export const PAID_STORAGE = MAINNET
  ? {
      uploadUrl: "https://upload.ardrive.io",
      paymentUrl: "https://payment.ardrive.io",
      gateway: "https://arweave.net",
      paymentAddress: "HepiT2k93CFQaSB7i3ZNXhybZKn5MeWiv3UkLsaJKk4i",
    }
  : {
      uploadUrl: "https://upload.services.ar-io.dev",
      paymentUrl: "https://payment.services.ar-io.dev",
      gateway: "https://ar-io.dev",
      paymentAddress: "Bg5HnSVtgHVXEGqJYWqxWad9Vrcgva9JrKw3XFSEGvaB",
    };
/** Images kept as they are can be up to this size. */
export const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;
/** A paid upload's file, header included, goes up in one request up to this size. */
export const MAX_PAID_ITEM_BYTES = MAX_ORIGINAL_BYTES + 64 * 1024;
/**
 * Added to Turbo's price, so a small move in prices before Turbo counts the
 * payment does not leave the upload short. What is not used stays as credit
 * for the seller's next upload.
 */
export const STORAGE_PRICE_MARGIN_PERCENT = 1n;

/** Compute units for the instructions that queue an MPC computation. */
export const QUEUE_COMPUTE_UNITS = { check: 400_000, clear: 1_000_000, fold: 1_000_000, settle: 400_000, settleBatch: 400_000, draw: 400_000 } as const;

/** Where sellers ask to have an auction featured. */
export const FEATURE_CONTACT = { label: "@mezonquark47", href: "https://x.com/mezonquark47" };
/** The project's source code: the program, the circuits and this app. */
export const GITHUB_URL = "https://github.com/MezonQuark47/Veiling";
/** Veiling's own X account. The X icon in the footer shows once this is set. */
export const PROJECT_X_URL: string | null = null;

// Auto-liquidity: a token sale can open a Meteora DAMM v2 pool at its
// final price. Must match the program's `liquidity` module.
export const CP_AMM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
/** Share of the net proceeds a pool takes, in bps: 20% to 100%. */
export const MIN_LP_BPS = 2_000;
export const MAX_LP_BPS = 10_000;
/** Trading fees a pool settles at, in bps. */
export const POOL_FEE_TIERS = [25, 100, 200] as const;
/** The anti-sniper fee: 50% at opening, down to the pool's fee over 10 minutes. */
export const ANTI_SNIPER_FEE_BPS = 5_000;
export const ANTI_SNIPER_MINUTES = 10;
/** The seller's share of the pool's trading fees; the platform gets the rest. */
export const SELLER_POOL_FEE_BPS = 8_000;
/** DAMM v2's own cut of every trading fee, before the pool's position gets the rest. */
export const DAMM_PROTOCOL_FEE_PERCENT = 20;
/** Sent with the plan for the pool's rent; what the pool does not use comes back. */
export const LP_RENT_DEPOSIT = 25_000_000n;
/** Compute units for opening the pool and for claiming its fees (measured about 300k and 100k). */
export const LP_COMPUTE_UNITS = { bootstrap: 500_000, claimFees: 300_000 } as const;
/** Compute for `graduate_launch`: the token, its metadata and three accounts. */
export const LAUNCH_COMPUTE_UNITS = { graduate: 400_000 } as const;
/** Where a pool can be seen and traded. */
export const meteoraPoolUrl = (pool: PublicKey) => `https://app.meteora.ag/dammv2/${pool.toBase58()}`;
