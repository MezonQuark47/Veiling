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
export const WALLET_CHAIN = "solana:devnet";
const MAINNET = (WALLET_CHAIN as string) === "solana:mainnet";
/** Shown in the header on a test network, so nobody takes it for mainnet; empty on mainnet. */
export const NETWORK_LABEL = MAINNET ? "" : "Devnet";
/** What explorer links add to point at this network. */
export const EXPLORER_CLUSTER = MAINNET ? "" : "?cluster=devnet";

// Must match the on-chain program and circuits.
export const BATCH_SIZE = 4;
export const MAX_BIDS = 256;
/** A bid into a full auction must out-deposit the smallest bid by this much. */
export const EVICTION_PREMIUM_PERCENT = 10n;
export const PENDING_TIMEOUT_SECS = 30 * 60;
export const EMERGENCY_DELAY_SECS = 3 * 24 * 60 * 60;
export const BID_NONCE_DOMAIN = "sealed-auction/bid-nonce/v1";
export const MIN_DURATION_SECS = 60;
export const MAX_DURATION_SECS = 14 * 24 * 60 * 60;

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
export const QUEUE_COMPUTE_UNITS = { check: 400_000, clear: 1_000_000, settle: 400_000, draw: 400_000 } as const;

/** Where sellers ask to have an auction featured. */
export const FEATURE_CONTACT = { label: "@velaryon69", href: "https://x.com/velaryon69" };
