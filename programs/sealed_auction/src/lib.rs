//! Sealed-bid, uniform-price auctions for SPL tokens and for NFT
//! collections, with open prices.
//!
//! Anyone can open an auction, either for a fixed-supply token or for a new
//! Metaplex Core NFT collection, with a minimum price. Bidders name any price
//! they like in an encrypted bid with a public SOL deposit:
//! - for tokens, the bid names a budget, the most it spends, and the
//!   highest price per token it accepts;
//! - for collections, the bid names how many NFTs it wants and the highest
//!   price per NFT, and the deposit has to cover that.
//!
//! Bids stay encrypted on chain. Arcium's MPC cluster checks them, finds the
//! single clearing price (the highest price at which demand covers the
//! supply) and decides each bid's outcome. Every winner pays the clearing
//! price and the unused part of every deposit is refunded. Losing bids are
//! never revealed.
//!
//! Lifecycle:
//! 1. `create_auction` escrows the tokens being sold;
//!    `create_collection_auction` creates the collection, whose NFTs are
//!    minted only when winners claim them. Both create the auction's bid book
//!    and charge the platform's listing fee.
//!    An auction can be scheduled: bidding then opens at its `start_time`,
//!    up to `MAX_START_DELAY_SECS` ahead, and runs for its duration from
//!    there. Until the first bid, the seller can still cancel it.
//!    The bid book holds `PAGE_BIDS` (256) bids per page; until bidding
//!    ends the seller can add pages with `add_book_page`, up to `MAX_PAGES`
//!    (`MAX_BIDS`, 1,024 bids).
//! 2. `place_bid` stores an encrypted bid and escrows its deposit (no MPC).
//!    Once every page is full, a new bid must out-deposit the smallest
//!    one by `EVICTION_PREMIUM_PERCENT`; that bid is refunded and replaced.
//!    `save_bid_note` can keep the bidder's own note of the bid next to it,
//!    encrypted by their app under a key made from their wallet's signature,
//!    so they can see what they sealed on any device.
//!    Each bid also pays a small settlement fee, and the seller one when the
//!    auction opens, into the auction's crank pool (`CrankRewards`).
//!    `increase_bid` lets a bidder replace their sealed bid and add to its
//!    deposit while bidding is open; a deposit can never shrink.
//! 3. After `end_time`, `check_batch` checks bids `BATCH_SIZE` at a time and
//!    stores each checked batch, encrypted, in the bid book. One computation
//!    is in flight at a time.
//! 4. `find_clearing` reads every batch and reveals the clearing price. When
//!    the bids fill more than one page, `fold_clearing` finds the same price
//!    a page at a time instead: `FOLD_PASSES` passes over the pages, each
//!    fixing four bits of the price, with the totals in between kept
//!    encrypted (`ClearingFold`).
//! 5. `settle_bid` decides one bid against that price. Its callback records
//!    what the bid won and moves the payment to the auction. A collection bid
//!    exactly at the clearing price only records its size, and
//!    `finalize_share` splits the remaining NFTs between those bids once they
//!    are all known. Neither touches any other account, so nobody can block
//!    their own settlement.
//! 6. `claim_tokens` (or `claim_nfts`) delivers what a bid won and
//!    `close_bid` returns the unused deposit; anyone can call both, funds only
//!    go to the bid's owner.
//! 7. `claim_proceeds` (or `claim_collection_proceeds`) pays the seller, less
//!    the platform's sale fee, once every bid is settled, and `close_auction`
//!    (or `close_collection_auction`) returns the remaining rent once every
//!    bid is closed. Closing a collection auction hands the collection to the
//!    seller.
//!
//! A collection's NFTs are named `"{item_name} #{n}"`, or per item: with an
//! item list (`init_item_list`, `add_items`) each item has its own name and
//! number of NFTs, and its NFTs are named `"{name} #{edition}"`. A hidden
//! collection commits to its metadata when it opens but shows it only after
//! the sale: its NFTs can be claimed once the seller reveals it
//! (`reveal_collection`), and if that has not happened `REVEAL_DELAY_SECS`
//! after the end of bidding, winners take their payments back
//! (`refund_unrevealed`).
//!
//! Anyone can run the MPC steps (`check_batch`, `find_clearing` or
//! `fold_clearing`, `settle_bid`, `draw_nft_seed`). Each pays its caller a
//! reward from the auction's crank pool when its computation succeeds, to
//! cover the fees the caller paid to queue it.
//!
//! Prices are whole price ticks (u32). A token auction quotes lamports per
//! `price_unit` base units, a power of ten chosen when it opens so that its
//! minimum price has enough precision; a collection auction quotes ticks of
//! `NFT_PRICE_SCALE` lamports per NFT.
//!
//! Safety net: if MPC stalls, nothing stays locked. `EMERGENCY_DELAY_SECS`
//! after the end, anyone can return an unsettled bid's full deposit to its
//! owner (`emergency_refund`) and the seller can reclaim the remaining tokens.
//!
//! Nobody, including the platform admin, can move escrowed funds outside these
//! rules. The admin can only feature or hide auctions in the listing, register
//! the pinned circuits and set the fees, within fixed caps, for auctions that
//! open later.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
};
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::accounts::ComputationAccount;
use arcium_anchor::traits::QueueCompAccs;
use arcium_client::idl::arcium::client::args::QueueComputation as QueueComputationArgs;
use arcium_client::idl::arcium::types::{
    CallbackAccount, CallbackInstruction, CircuitSource, OffChainCircuitSource,
};
use arcium_client::ARCIUM_PROGRAM_ID;
use arcium_macros::circuit_hash;
use solana_curve25519::edwards::{add_edwards, multiply_edwards, validate_edwards, PodEdwardsPoint};
use solana_curve25519::scalar::PodScalar;
use solana_sha256_hasher::hashv;

pub mod liquidity;
use liquidity::*;

declare_id!("CjUVaVK3jF9o4EehHWtB13TGg9SPXBWKGBepmZHwyLK2");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMP_DEF_OFFSET_CHECK_BIDS: u32 = comp_def_offset("check_bids_v2");
const COMP_DEF_OFFSET_CLEAR_PRICE: u32 = comp_def_offset("clear_price_v2");
const COMP_DEF_OFFSET_AWARD_BID: u32 = comp_def_offset("award_bid_v2");
const COMP_DEF_OFFSET_DRAW_SEED: u32 = comp_def_offset("draw_seed");
const COMP_DEF_OFFSET_FOLD_BATCH: u32 = comp_def_offset("fold_batch_v2");

pub const CONFIG_SEED: &[u8] = b"config";
pub const FEES_SEED: &[u8] = b"fees";
pub const AUCTION_SEED: &[u8] = b"auction";
pub const BOOK_SEED: &[u8] = b"book";
pub const BID_SEED: &[u8] = b"bid";
/// A collection auction's Core collection: `[COLLECTION_SEED, auction]`.
pub const COLLECTION_SEED: &[u8] = b"collection";
/// The NFT at `index` (u32, little-endian) of a collection auction:
/// `[ASSET_SEED, auction, index]`.
pub const ASSET_SEED: &[u8] = b"asset";
/// The item list of a collection auction named per item:
/// `[ITEMS_SEED, auction]`.
pub const ITEMS_SEED: &[u8] = b"items";
/// A bidder's encrypted note on their bid: `[NOTE_SEED, bid]`.
pub const NOTE_SEED: &[u8] = b"note";
/// The rewards paid to whoever runs the MPC steps: `[CRANK_SEED]`.
pub const CRANK_SEED: &[u8] = b"crank";
/// The state of an auction's paged clearing: `[FOLD_SEED, auction]`.
pub const FOLD_SEED: &[u8] = b"fold";

/// Account discriminators of this version's auction state. They differ from
/// the first release's, whose accounts had other layouts, so an account of
/// that release can never be read as one of these.
pub const AUCTION_DISCRIMINATOR: &[u8] = b"VAuctn03";
pub const BOOK_DISCRIMINATOR: &[u8] = b"VBook_03";
pub const BID_DISCRIMINATOR: &[u8] = b"VBid__02";
pub const ITEM_LIST_DISCRIMINATOR: &[u8] = b"VItems01";
pub const BID_NOTE_DISCRIMINATOR: &[u8] = b"VNote_01";
pub const FOLD_DISCRIMINATOR: &[u8] = b"VFold_01";
/// Bytes of a bid note. The program stores them as given: the bidder's app
/// encrypts the bid's price and size under a key only their wallet can make.
pub const BID_NOTE_LEN: usize = 32;

/// Hard caps on the platform fees, so no admin can ever charge more: 0.5 SOL
/// to open an auction and 5% of a sale's proceeds.
pub const MAX_LISTING_FEE: u64 = 500_000_000;
pub const MAX_SALE_FEE_BPS: u16 = 500;
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Metaplex Core, which holds the NFTs of collection auctions.
pub const MPL_CORE_ID: Pubkey = pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
/// Most NFTs a collection auction can sell.
pub const MAX_COLLECTION_SIZE: u64 = 10_000;
/// Most NFTs minted by one `claim_nfts`, to stay inside a transaction's
/// compute budget; larger wins are claimed over several transactions.
pub const MAX_NFTS_PER_CLAIM: usize = 5;
/// Rounds of the swap-or-not shuffle that turns places into NFT numbers
/// (see `shuffled_items`).
pub const SHUFFLE_ROUNDS: u32 = 64;
/// Tells the shuffle's pivot word apart from its per-place words, whose salt
/// is a place below `MAX_COLLECTION_SIZE`.
const SHUFFLE_PIVOT_SALT: u32 = u32::MAX;
/// Highest royalty a collection may set on secondary sales (10%).
pub const MAX_ROYALTY_BPS: u16 = 1_000;
/// Text limits for collection metadata, in bytes. Item names get " #10000"
/// appended, so they stay within 32 bytes.
pub const MAX_COLLECTION_NAME_LEN: usize = 32;
pub const MAX_ITEM_NAME_LEN: usize = 24;
pub const MAX_URI_LEN: usize = 200;
/// Most items an item list can hold.
pub const MAX_ITEMS: u32 = 500;
/// Bytes of one item list entry: where the item's NFT numbers end (u32,
/// little-endian), its name's length (u8) and its name, padded with zeros.
pub const ITEM_ENTRY_LEN: usize = 4 + 1 + MAX_ITEM_NAME_LEN;
/// Where an item list's entries start: right after its header.
pub const ITEM_LIST_HEADER_LEN: usize = 8 + ItemList::INIT_SPACE;
/// How long after the end of bidding the seller of a hidden collection has
/// to reveal its art. After that, winners can take their payments back.
pub const REVEAL_DELAY_SECS: i64 = 7 * 24 * 60 * 60;
/// Metaplex Core instruction indexes used here.
const CORE_CREATE_V1: u8 = 0;
const CORE_CREATE_COLLECTION_V1: u8 = 1;
const CORE_UPDATE_COLLECTION_V1: u8 = 16;

/// Lamports per price tick of a collection auction: prices per NFT are whole
/// millionths of a SOL, up to about 4,295 SOL.
pub const NFT_PRICE_SCALE: u64 = 1_000;
/// Largest `price_unit` of a token auction. With at most `MAX_BIDS` budgets
/// below 2^64, demand times the unit stays below 2^128 in the circuits:
/// 2^10 * 2^64 * 10^16 < 2^127.2. This is what caps `MAX_BIDS` at 1,024; twice
/// as many bids would need a smaller unit.
pub const MAX_PRICE_UNIT: u64 = 10_000_000_000_000_000;
const _: () = assert!(
    (MAX_BIDS as u128) * (u64::MAX as u128) <= u128::MAX / (MAX_PRICE_UNIT as u128)
);

/// Bids checked per computation; must match the circuits' batch width.
pub const BATCH_SIZE: usize = 4;
/// Byte offset and length of a bid's two ciphertexts inside `Bid`.
pub const BID_CIPHERTEXT_OFFSET: u32 = 8;
pub const BID_CIPHERTEXT_LEN: u32 = 64;
/// Byte offset of the batch records inside `BidBook` (right after the
/// discriminator) and the length of one record: two ciphertexts, the four
/// bids' `(price: u32, quantity: u64)` packed by the circuits.
pub const BATCH_RECORDS_OFFSET: u32 = 8;
pub const BATCH_RECORD_CIPHERTEXTS: usize = 2;
pub const BATCH_RECORD_LEN: u32 = 32 * BATCH_RECORD_CIPHERTEXTS as u32;

/// Bids one page of the bid book holds (`BidBook`). Every auction has its
/// first page; the seller can add up to `MAX_PAGES - 1` more before bidding
/// ends (`add_book_page`).
pub const PAGE_BIDS: u32 = 256;
const PAGE_BIDS_USIZE: usize = PAGE_BIDS as usize;
pub const MAX_PAGES: u8 = 4;
const MAX_EXTRA_PAGES: usize = MAX_PAGES as usize - 1;
/// Most bids an auction can hold, with every page added.
pub const MAX_BIDS: u32 = PAGE_BIDS * MAX_PAGES as u32;
/// Batch records per page. One computation reads at most one page:
/// `clear_price` reads the only page of a one-page auction and
/// `fold_batch` reads one page per step.
pub const PAGE_BATCHES: usize = PAGE_BIDS_USIZE / BATCH_SIZE;
const _: () = assert!(PAGE_BATCHES * BATCH_SIZE == PAGE_BIDS_USIZE);
const _: () = assert!(PAGE_BATCHES <= u8::MAX as usize);
/// Passes of the paged clearing (`fold_clearing`): each fixes four bits of
/// the u32 clearing price. A pass reads every page in use, forwards and
/// backwards in turn, and the step that ends a pass also starts the next on
/// the same page, so `pages` pages take `FOLD_PASSES * (pages - 1) + 1` steps.
pub const FOLD_PASSES: u8 = 8;
pub const FOLD_DIGIT_BITS: u8 = 4;
const _: () = assert!(FOLD_PASSES as u32 * FOLD_DIGIT_BITS as u32 == 32);
/// Ciphertexts of the state `fold_batch` carries between steps: 17 demand
/// totals of 80 bits, packed together.
pub const FOLD_STATE_CIPHERTEXTS: usize = 7;
/// Byte offset and length of that state inside `ClearingFold`, right after
/// the discriminator; the MPC cluster reads it in place.
pub const FOLD_STATE_OFFSET: u32 = 8;
pub const FOLD_STATE_LEN: u32 = 32 * FOLD_STATE_CIPHERTEXTS as u32;
/// What one `fold_batch` step pays its caller, as a share of the auction's
/// clearing reward, in percent. A step reads one page and costs about as
/// much as a whole `clear_price` run (measured on devnet: 0.0232 SOL against
/// 0.0224), so it pays the same.
pub const FOLD_REWARD_PERCENT: u64 = 100;
pub const MIN_DURATION_SECS: i64 = 60;
pub const MAX_DURATION_SECS: i64 = 14 * 24 * 60 * 60;
/// How far ahead an auction can schedule the start of bidding.
pub const MAX_START_DELAY_SECS: i64 = 30 * 24 * 60 * 60;
/// Cap on each crank reward, so no admin can make bidding or listing
/// expensive through them: 0.1 SOL.
pub const MAX_CRANK_REWARD: u64 = 100_000_000;
/// Once an auction holds `MAX_BIDS` bids, a new bid must deposit at least this
/// much more (in percent, rounded up) than the smallest deposit, which is then
/// refunded in full. Filling every slot to crowd others out therefore costs
/// more the more other bidders are willing to deposit.
pub const EVICTION_PREMIUM_PERCENT: u64 = 10;
/// After this long without a callback, a stuck computation may be re-queued.
/// Its late callback, if any, is rejected because it no longer matches. Long
/// enough that a healthy but busy cluster finishes first, so re-queuing at
/// every expiry cannot be used to keep results from landing.
pub const PENDING_TIMEOUT_SECS: i64 = 30 * 60;
/// Time after the end of bidding when the safety net opens.
pub const EMERGENCY_DELAY_SECS: i64 = 3 * 24 * 60 * 60;
/// Compute budget requested for every callback transaction. Callbacks verify
/// the cluster's BLS signature, which is too close to the default budget to
/// leave to chance. No priority fee is set, so this costs nothing extra.
pub const CALLBACK_CU_LIMIT: u32 = 400_000;

/// Outcomes revealed by the `award_bid` circuit. A bid at the clearing price
/// gets what the bids above it left (see `token_award` and `clearing_share`).
pub const OUTCOME_NONE: u8 = 0;
pub const OUTCOME_ABOVE: u8 = 1;
pub const OUTCOME_AT: u8 = 2;

/// Domain separator for the nonce every bid must be encrypted under.
pub const BID_NONCE_DOMAIN: &[u8] = b"sealed-auction/bid-nonce/v1";

/// Where an Arcium computation account (arcium-client 0.15) keeps the MXE
/// program that queued it and the slot and per-slot counter that the
/// cluster's output signature covers.
const COMPUTATION_MXE_PROGRAM_OFFSET: usize = 8 + 32;
const COMPUTATION_SLOT_OFFSET: usize = 100;
const COMPUTATION_SLOT_COUNTER_OFFSET: usize = 108;

/// 2^255 - 19, little-endian: the field that ciphertexts and x25519 keys
/// live in.
const FIELD_MODULUS_LE: [u8; 32] = [
    0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
];

/// x25519 public keys that Arcis refuses by value: the canonical keys of small
/// order (Curve25519 and its twist) and the base point `u = 9`, which no
/// clamped private key can produce. Everything else is refused by the curve
/// and subgroup checks in `is_usable_x25519_key`.
const REFUSED_KEYS: [[u8; 32]; 6] = [
    [0u8; 32],
    [
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0,
    ],
    [
        0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4,
        0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49,
        0xb8, 0x00,
    ],
    [
        0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef,
        0x5b, 0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f,
        0x11, 0x57,
    ],
    // p - 1
    [
        0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
    // 9, the base point
    [
        9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0,
    ],
];

/// ℓ - 1, where ℓ = 2^252 + 27742317777372353535851937790883648493 is the
/// order of Curve25519's prime-order subgroup; little-endian, a canonical
/// scalar.
const SUBGROUP_ORDER_MINUS_ONE: [u8; 32] = [
    0xec, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
];

/// The Edwards identity point (x = 0, y = 1), compressed.
const EDWARDS_IDENTITY: [u8; 32] = [
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

#[arcium_program]
pub mod sealed_auction {
    use super::*;

    // -----------------------------------------------------------------------
    // Platform administration
    // -----------------------------------------------------------------------

    /// Creates the platform config. Only the program's upgrade authority can
    /// call this, so nobody can front-run the deployment and claim the admin.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.authority.key();
        config.pending_admin = None;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// First step of a two-step admin handover.
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = Some(new_admin);
        Ok(())
    }

    /// Second step: the proposed admin accepts.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.pending_admin == Some(ctx.accounts.new_admin.key()),
            AuctionError::Unauthorized
        );
        config.admin = ctx.accounts.new_admin.key();
        config.pending_admin = None;
        Ok(())
    }

    /// Features or hides an auction in the listing. Affects display only.
    pub fn set_listing(ctx: Context<SetListing>, featured: bool, hidden: bool) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        auction.featured = featured;
        auction.hidden = hidden;
        emit!(ListingUpdated {
            auction: auction.key(),
            featured,
            hidden,
        });
        Ok(())
    }

    /// Sets the platform fees and the wallet that receives them. They apply
    /// to auctions opened afterwards: an auction keeps the sale fee and
    /// treasury it opened with. Both fees are capped (`MAX_LISTING_FEE`,
    /// `MAX_SALE_FEE_BPS`), and sellers name the most they accept when they
    /// open an auction, so a change can never surprise one.
    pub fn set_fees(ctx: Context<SetFees>, listing_fee: u64, sale_fee_bps: u16) -> Result<()> {
        require!(
            listing_fee <= MAX_LISTING_FEE && sale_fee_bps <= MAX_SALE_FEE_BPS,
            AuctionError::FeeTooHigh
        );
        // Fees are plain lamport transfers, which only a funded system account
        // is sure to accept.
        let treasury = &ctx.accounts.treasury;
        require_keys_eq!(*treasury.owner, System::id(), AuctionError::InvalidTreasury);
        require!(
            Rent::get()?.is_exempt(treasury.lamports(), treasury.data_len()),
            AuctionError::InvalidTreasury
        );
        let fees = &mut ctx.accounts.fee_config;
        fees.listing_fee = listing_fee;
        fees.sale_fee_bps = sale_fee_bps;
        fees.treasury = treasury.key();
        fees.bump = ctx.bumps.fee_config;
        emit!(FeesUpdated {
            listing_fee,
            sale_fee_bps,
            treasury: treasury.key(),
        });
        Ok(())
    }

    /// Sets the rewards paid to whoever runs each MPC step, for auctions
    /// opened from now on (each auction keeps the rewards it opened with).
    /// Each is capped at `MAX_CRANK_REWARD`. Admin only.
    pub fn set_crank_rewards(ctx: Context<SetCrankRewards>, rewards: CrankRewards) -> Result<()> {
        require!(
            [rewards.check_batch, rewards.clearing, rewards.settlement, rewards.seed_draw]
                .iter()
                .all(|&r| r <= MAX_CRANK_REWARD),
            AuctionError::FeeTooHigh
        );
        let config = &mut ctx.accounts.crank_config;
        config.rewards = rewards;
        config.bump = ctx.bumps.crank_config;
        emit!(CrankRewardsUpdated { rewards });
        Ok(())
    }

    /// Registers the `check_bids` circuit. Nodes fetch it from `circuit_url`
    /// and refuse any file whose hash differs from the one compiled into this
    /// program, so the URL's host cannot change what the circuit computes.
    pub fn init_check_bids_comp_def(
        ctx: Context<InitCheckBidsCompDef>,
        circuit_url: String,
    ) -> Result<()> {
        init_computation_def(
            ctx.accounts,
            circuit_source(circuit_url, circuit_hash!("check_bids_v2"))?,
        )?;
        Ok(())
    }

    pub fn init_clear_price_comp_def(
        ctx: Context<InitClearPriceCompDef>,
        circuit_url: String,
    ) -> Result<()> {
        init_computation_def(
            ctx.accounts,
            circuit_source(circuit_url, circuit_hash!("clear_price_v2"))?,
        )?;
        Ok(())
    }

    pub fn init_award_bid_comp_def(
        ctx: Context<InitAwardBidCompDef>,
        circuit_url: String,
    ) -> Result<()> {
        init_computation_def(
            ctx.accounts,
            circuit_source(circuit_url, circuit_hash!("award_bid_v2"))?,
        )?;
        Ok(())
    }

    pub fn init_draw_seed_comp_def(
        ctx: Context<InitDrawSeedCompDef>,
        circuit_url: String,
    ) -> Result<()> {
        init_computation_def(
            ctx.accounts,
            circuit_source(circuit_url, circuit_hash!("draw_seed"))?,
        )?;
        Ok(())
    }

    pub fn init_fold_batch_comp_def(
        ctx: Context<InitFoldBatchCompDef>,
        circuit_url: String,
    ) -> Result<()> {
        init_computation_def(
            ctx.accounts,
            circuit_source(circuit_url, circuit_hash!("fold_batch_v2"))?,
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Auction lifecycle
    // -----------------------------------------------------------------------

    /// Opens a token auction: escrows `terms.supply` base units, creates the
    /// auction's bid book (its rent comes back with `close_auction`) and
    /// charges the listing fee.
    ///
    /// Prices are lamports per `terms.price_unit` base units, a power of ten
    /// up to `MAX_PRICE_UNIT`; bids below `terms.min_price` do not count, and
    /// every bid deposits at least `terms.min_deposit` and names a private
    /// budget of at least that much, which its deposit covers. `fees` are
    /// the most the seller accepts to pay; opening fails if the platform's
    /// are higher.
    pub fn create_auction(
        ctx: Context<CreateAuction>,
        seed: u64,
        terms: TokenSaleTerms,
        fees: FeeTerms,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (start_time, end_time) = terms.check(now)?;
        check_mint_is_safe(&ctx.accounts.mint)?;

        let listing_fee = charge_listing_fee(
            &ctx.accounts.fee_config,
            &fees,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
        )?;

        let auction_key = ctx.accounts.auction.key();
        let mut auction = new_auction(
            AuctionKind::Token,
            seed,
            ctx.accounts.seller.key(),
            ctx.accounts.mint.key(),
            ctx.accounts.token_program.key(),
            start_time,
            end_time,
            [ctx.bumps.auction, ctx.bumps.book],
            &ctx.accounts.fee_config,
            ctx.accounts.crank_config.rewards,
        );
        auction.supply = terms.supply;
        auction.price_unit = terms.price_unit;
        auction.price_scale = 1;
        auction.min_price = terms.min_price;
        auction.min_deposit = terms.min_deposit;
        ctx.accounts.auction.set_inner(auction);
        let mut book = ctx.accounts.book.load_init()?;
        book.auction = auction_key;
        drop(book);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.seller_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            terms.supply,
            ctx.accounts.mint.decimals,
        )?;

        fund_crank_pool(
            &mut ctx.accounts.auction,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.system_program,
        )?;
        emit_auction_created(&ctx.accounts.auction, listing_fee);
        Ok(())
    }

    /// Opens an auction for a new NFT collection of `terms.supply` items. The
    /// Metaplex Core collection is created here, with the auction as its
    /// update authority so that only this program can add NFTs to it. Each
    /// NFT is minted straight to its winner by `claim_nfts`; unsold NFTs are
    /// never minted. `close_collection_auction` hands the collection to the
    /// seller.
    ///
    /// Prices are ticks of `NFT_PRICE_SCALE` lamports per NFT. A bid asks for
    /// 1 to `terms.max_per_bid` NFTs and deposits at least that many times its
    /// price.
    ///
    /// NFT `i` (from 0) is named `"{item_name} #{i + 1}"`; its metadata is
    /// `item_uri` followed by `"{i}.json"` when `uri_per_item` is set, or
    /// `item_uri` itself otherwise. Which NFT numbers each winner gets is
    /// drawn after the sale (`draw_nft_seed`). A non-zero `royalty_bps` adds
    /// a Royalties plugin that pays the seller on secondary sales.
    ///
    /// With `item_list` (made with `init_item_list` and `add_items` for this
    /// auction's address), NFTs are named per item instead (`item_nft_name`);
    /// the list must add up to the supply, and is sealed here. With
    /// `collection.hidden`, `item_uri` is a commitment: its files need not
    /// exist yet, and NFTs can be claimed only once the seller reveals them
    /// (`reveal_collection`). Both need `uri_per_item`.
    pub fn create_collection_auction(
        ctx: Context<CreateCollectionAuction>,
        seed: u64,
        terms: CollectionSaleTerms,
        fees: FeeTerms,
        collection: CollectionTerms,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (start_time, end_time) = terms.check(now)?;
        collection.check()?;

        let listing_fee = charge_listing_fee(
            &ctx.accounts.fee_config,
            &fees,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
        )?;

        let auction_key = ctx.accounts.auction.key();
        let seller_key = ctx.accounts.seller.key();
        let named_items = ctx.accounts.item_list.is_some();
        if let Some(list) = ctx.accounts.item_list.as_mut() {
            require!(
                !list.sealed && list.seller == seller_key && list.auction == auction_key,
                AuctionError::ItemListMismatch
            );
            require!(
                list.count > 0 && list.total as u64 == terms.supply,
                AuctionError::ItemListMismatch
            );
            list.sealed = true;
        }
        require!(
            collection.uri_per_item || !(named_items || collection.hidden),
            AuctionError::InvalidCollectionTerms
        );
        let collection_info = ctx.accounts.collection.to_account_info();
        let collection_seeds: &[&[u8]] = &[
            COLLECTION_SEED,
            auction_key.as_ref(),
            &[ctx.bumps.collection],
        ];
        reclaim_prefunded(
            &collection_info,
            collection_seeds,
            &ctx.accounts.seller.to_account_info(),
        )?;
        let create = Instruction {
            program_id: MPL_CORE_ID,
            accounts: vec![
                AccountMeta::new(collection_info.key(), true),
                // Update authority: the auction, until the collection is handed over.
                AccountMeta::new_readonly(auction_key, false),
                AccountMeta::new(seller_key, true),
                AccountMeta::new_readonly(System::id(), false),
            ],
            data: core_create_collection_data(
                &collection.name,
                &collection.uri,
                collection.royalty_bps,
                &seller_key,
            ),
        };
        invoke_signed(
            &create,
            &[
                collection_info.clone(),
                ctx.accounts.auction.to_account_info(),
                ctx.accounts.seller.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.mpl_core_program.to_account_info(),
            ],
            &[collection_seeds],
        )?;

        let mut auction = new_auction(
            AuctionKind::Collection,
            seed,
            seller_key,
            collection_info.key(),
            MPL_CORE_ID,
            start_time,
            end_time,
            [ctx.bumps.auction, ctx.bumps.book],
            &ctx.accounts.fee_config,
            ctx.accounts.crank_config.rewards,
        );
        auction.supply = terms.supply;
        auction.price_unit = 1;
        auction.price_scale = NFT_PRICE_SCALE;
        auction.min_price = terms.min_price;
        // The cheapest valid bid: one NFT at the minimum price.
        auction.min_deposit = terms.min_price as u64 * NFT_PRICE_SCALE;
        auction.max_per_bid = terms.max_per_bid;
        auction.royalty_bps = collection.royalty_bps;
        auction.uri_per_item = collection.uri_per_item;
        auction.item_name = collection.item_name;
        auction.item_uri = collection.item_uri;
        auction.named_items = named_items;
        auction.unrevealed = collection.hidden;
        ctx.accounts.auction.set_inner(auction);
        let mut book = ctx.accounts.book.load_init()?;
        book.auction = auction_key;
        drop(book);

        fund_crank_pool(
            &mut ctx.accounts.auction,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.system_program,
        )?;
        emit_auction_created(&ctx.accounts.auction, listing_fee);
        Ok(())
    }

    /// Lets the seller withdraw a token auction that nobody has bid on yet.
    pub fn cancel_auction(ctx: Context<SellerWithdraw>) -> Result<()> {
        require!(
            ctx.accounts.auction.status == AuctionStatus::Open,
            AuctionError::WrongStatus
        );
        require!(ctx.accounts.auction.bid_count == 0, AuctionError::HasBids);
        let escrowed = ctx.accounts.vault.amount;
        pay_out_vault(&ctx, escrowed, true)?;
        ctx.accounts.auction.status = AuctionStatus::Cancelled;
        emit!(AuctionCancelled {
            auction: ctx.accounts.auction.key(),
        });
        Ok(())
    }

    /// Lets the seller withdraw a collection auction that nobody has bid on
    /// yet. `close_collection_auction` then hands over the empty collection.
    pub fn cancel_collection_auction(ctx: Context<CollectionSeller>) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        require!(auction.status == AuctionStatus::Open, AuctionError::WrongStatus);
        require!(auction.bid_count == 0, AuctionError::HasBids);
        auction.status = AuctionStatus::Cancelled;
        emit!(AuctionCancelled {
            auction: auction.key(),
        });
        Ok(())
    }

    /// Adds a page to the auction's bid book, room for `PAGE_BIDS` more bids,
    /// up to `MAX_PAGES` pages (`MAX_BIDS` bids). Only the seller, while
    /// bidding is still open; `page` is the next page's number (1 to 3).
    ///
    /// The seller pays the page's rent, which comes back when the auction is
    /// closed, and adds to the crank pool what finding the clearing price
    /// across the pages may cost (`page_crank_fee`); what is not used comes
    /// back then too. Once more than one page holds bids, the clearing price
    /// is found a page at a time (`fold_clearing`) instead of in one step.
    pub fn add_book_page(ctx: Context<AddBookPage>, page: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let auction_key = ctx.accounts.auction.key();
        let auction = &mut ctx.accounts.auction;
        require!(auction.status == AuctionStatus::Open, AuctionError::WrongStatus);
        require!(now < auction.end_time, AuctionError::BiddingClosed);
        require!(
            page as usize == auction.extra_pages as usize + 1 && page < MAX_PAGES,
            AuctionError::TooManyPages
        );
        auction.page_bumps[page as usize - 1] = ctx.bumps.page_book;
        auction.extra_pages = page;
        let mut book = ctx.accounts.page_book.load_init()?;
        book.auction = auction_key;
        drop(book);

        let fold = &mut ctx.accounts.fold;
        if fold.auction == Pubkey::default() {
            fold.auction = auction_key;
            fold.bump = ctx.bumps.fold;
        }

        let crank_fee = page_crank_fee(&ctx.accounts.auction.crank_rewards, page);
        add_to_crank_pool(
            &mut ctx.accounts.auction,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.system_program,
            crank_fee,
        )?;
        emit!(BookPageAdded {
            auction: auction_key,
            page,
            max_bids: bid_capacity(&ctx.accounts.auction),
            crank_fee,
        });
        Ok(())
    }

    /// Starts the item list of the collection auction that the seller will
    /// open with `seed`, for a collection named per item: each item has a
    /// name and a number of NFTs, its editions. `add_items` fills the list
    /// and `create_collection_auction` seals it.
    pub fn init_item_list(ctx: Context<InitItemList>, seed: u64) -> Result<()> {
        // `seed` only locates the auction's address (see `InitItemList`).
        let _ = seed;
        let list = &mut ctx.accounts.item_list;
        list.auction = ctx.accounts.auction.key();
        list.seller = ctx.accounts.seller.key();
        list.count = 0;
        list.total = 0;
        list.sealed = false;
        list.bump = ctx.bumps.item_list;
        Ok(())
    }

    /// Appends items to an item list that is not sealed yet. Each item needs
    /// a name (display text of at most `MAX_ITEM_NAME_LEN` bytes) and at
    /// least one NFT; a list holds at most `MAX_ITEMS` items and
    /// `MAX_COLLECTION_SIZE` NFTs. Items keep their order: the first item's
    /// NFTs are numbers 0 onwards, the next item's follow, and so on.
    pub fn add_items(ctx: Context<AddItems>, items: Vec<NewItem>) -> Result<()> {
        require!(!items.is_empty(), AuctionError::InvalidItems);
        let info = ctx.accounts.item_list.to_account_info();
        let list = &mut ctx.accounts.item_list;
        require!(!list.sealed, AuctionError::ItemListSealed);
        let count = (list.count as usize)
            .checked_add(items.len())
            .ok_or(AuctionError::MathOverflow)?;
        require!(count <= MAX_ITEMS as usize, AuctionError::TooManyItems);
        let mut total = list.total as u64;
        let mut data = info.try_borrow_mut_data()?;
        for (k, item) in items.iter().enumerate() {
            require!(
                is_display_text(&item.name, MAX_ITEM_NAME_LEN) && item.supply > 0,
                AuctionError::InvalidItems
            );
            total = total
                .checked_add(item.supply as u64)
                .ok_or(AuctionError::MathOverflow)?;
            require!(total <= MAX_COLLECTION_SIZE, AuctionError::InvalidItems);
            let at = ITEM_LIST_HEADER_LEN + (list.count as usize + k) * ITEM_ENTRY_LEN;
            let entry = data
                .get_mut(at..at + ITEM_ENTRY_LEN)
                .ok_or(AuctionError::InvalidItems)?;
            entry[..4].copy_from_slice(&(total as u32).to_le_bytes());
            entry[4] = item.name.len() as u8;
            entry[5..].fill(0);
            entry[5..5 + item.name.len()].copy_from_slice(item.name.as_bytes());
        }
        drop(data);
        list.count = count as u32;
        list.total = total as u32;
        Ok(())
    }

    /// Closes an item list that no auction uses, returning its rent to the
    /// seller. A list sealed into an auction closes with it
    /// (`close_collection_auction`).
    pub fn close_item_list(ctx: Context<CloseItemList>) -> Result<()> {
        require!(!ctx.accounts.item_list.sealed, AuctionError::ItemListSealed);
        Ok(())
    }

    /// Reveals a hidden collection: from now on its NFTs can be claimed, with
    /// the metadata committed when the auction opened (`item_uri`), which
    /// cannot change. Only the seller, once bidding has ended and before
    /// `REVEAL_DELAY_SECS` have passed since. The files must be at
    /// `item_uri` by then; the program cannot see them, but anyone can.
    pub fn reveal_collection(ctx: Context<RevealCollection>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let auction = &mut ctx.accounts.auction;
        require!(auction.unrevealed, AuctionError::AlreadyRevealed);
        require!(auction.status != AuctionStatus::Cancelled, AuctionError::WrongStatus);
        require!(now >= auction.end_time, AuctionError::BiddingOpen);
        require!(before_reveal_deadline(auction, now)?, AuctionError::RevealClosed);
        auction.unrevealed = false;
        emit!(CollectionRevealed {
            auction: auction.key(),
            item_uri: auction.item_uri.clone(),
        });
        Ok(())
    }

    /// When a hidden collection was not revealed in time, gives a winning bid
    /// its payment back. Once `REVEAL_DELAY_SECS` have passed since the end
    /// of bidding and every bid is settled or refunded (the safety net
    /// refunds any that cannot be), the payment moves from the auction back
    /// to the bid, which then counts as having won nothing, so `close_bid`
    /// returns its whole deposit. Anyone can call it; the lamports only go to
    /// the bid.
    pub fn refund_unrevealed(ctx: Context<RefundUnrevealed>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let auction = &ctx.accounts.auction;
        let bid = &ctx.accounts.bid;
        require!(auction.unrevealed, AuctionError::AlreadyRevealed);
        require!(!before_reveal_deadline(auction, now)?, AuctionError::TooEarly);
        // Every bid must be settled or refunded first, so no share at the
        // clearing price is still being worked out from what was sold.
        require!(
            auction.resolved_count == auction.bid_count,
            AuctionError::NotSettled
        );
        require!(bid.status == BidStatus::Settled, AuctionError::NotSettled);
        require!(bid.won > 0, AuctionError::NothingToClaim);
        require!(bid.nfts_claimed == 0, AuctionError::AlreadyClaimed);

        let payment = bid.payment;
        let won = bid.won;
        move_lamports(
            &ctx.accounts.auction.to_account_info(),
            &ctx.accounts.bid.to_account_info(),
            payment,
        )?;
        let auction = &mut ctx.accounts.auction;
        auction.proceeds = auction
            .proceeds
            .checked_sub(payment)
            .ok_or(AuctionError::MathOverflow)?;
        auction.sold = auction
            .sold
            .checked_sub(won)
            .ok_or(AuctionError::MathOverflow)?;
        let bid = &mut ctx.accounts.bid;
        bid.won = 0;
        bid.payment = 0;
        bid.delivered = true;
        emit!(BidRefunded {
            auction: auction.key(),
            bid: bid.key(),
            bidder: bid.bidder,
            amount: payment,
        });
        Ok(())
    }

    /// Stores an encrypted bid and escrows its deposit. No MPC runs here, so
    /// bids never contend with each other.
    ///
    /// The ciphertexts encrypt `BidInput { price, quantity }` for the MXE
    /// under the bidder's x25519 key and `nonce`, which must equal `bid_nonce`
    /// of this bid's address. That binding means a ciphertext copied from
    /// another bid decrypts to noise here, so nobody can replay someone else's
    /// bid into an auction whose terms they control and read it from the
    /// result.
    ///
    /// `client_pubkey_edwards_y` is the Edwards y-coordinate of the key, which
    /// lets the program check the key exactly as Arcis does (see
    /// `is_usable_x25519_key`). `terms` are the auction terms the bidder saw;
    /// the bid is refused if the auction does not have exactly those.
    ///
    /// Once every page of the auction's bid book is full (`bid_capacity`),
    /// pass the bid with the smallest deposit as `evicted_bid` (and its owner
    /// as `evicted_bidder`); the new deposit must exceed it by
    /// `EVICTION_PREMIUM_PERCENT`. The evicted bid is closed and its owner
    /// gets the deposit and rent back.
    ///
    /// `book` is the first page; pass every further page
    /// (`add_book_page`), in order, as remaining accounts.
    ///
    /// For a token auction the encrypted quantity is the bid's budget in
    /// lamports: a budget the deposit does not cover, or below
    /// `min_deposit`, counts as no bid. For a collection auction a bid whose
    /// price times quantity exceeds the deposit counts as no bid. Either way
    /// such a bid is fully refunded later, and the deposit may exceed what it
    /// covers to hide the bid.
    #[allow(clippy::too_many_arguments)]
    pub fn place_bid<'info>(
        ctx: Context<'info, PlaceBid<'info>>,
        bid_seed: u64,
        terms: ExpectedTerms,
        price_ciphertext: [u8; 32],
        quantity_ciphertext: [u8; 32],
        client_pubkey: [u8; 32],
        client_pubkey_edwards_y: [u8; 32],
        nonce: u128,
        deposit: u64,
    ) -> Result<()> {
        // `bid_seed` only locates the bid's address (see `PlaceBid`).
        let _ = bid_seed;
        require!(
            nonce == bid_nonce(&ctx.accounts.bid.key()),
            AuctionError::InvalidNonce
        );
        require!(
            is_canonical_field_element(&price_ciphertext)
                && is_canonical_field_element(&quantity_ciphertext),
            AuctionError::InvalidCiphertext
        );
        require!(
            is_usable_x25519_key(&client_pubkey, &client_pubkey_edwards_y),
            AuctionError::InvalidEncryptionKey
        );

        let now = Clock::get()?.unix_timestamp;
        let auction_key = ctx.accounts.auction.key();
        let auction = &mut ctx.accounts.auction;
        require!(terms.matches(auction), AuctionError::TermsMismatch);
        require!(
            auction.status == AuctionStatus::Open,
            AuctionError::WrongStatus
        );
        require!(now >= auction.start_time, AuctionError::BiddingNotStarted);
        require!(now < auction.end_time, AuctionError::BiddingClosed);
        // Anything less cannot win, so it is refused before it takes a slot.
        require!(deposit >= auction.min_deposit, AuctionError::DepositTooSmall);

        let extra = extra_pages(auction, ctx.remaining_accounts)?;
        let index = if auction.bid_count < bid_capacity(auction) {
            require!(
                ctx.accounts.evicted_bid.is_none(),
                AuctionError::WrongBidAccounts
            );
            let index = auction.bid_count;
            auction.bid_count = index.checked_add(1).ok_or(AuctionError::MathOverflow)?;
            auction.live_bids = auction
                .live_bids
                .checked_add(1)
                .ok_or(AuctionError::MathOverflow)?;
            index
        } else {
            let (Some(evicted), Some(evicted_bidder)) = (
                ctx.accounts.evicted_bid.as_ref(),
                ctx.accounts.evicted_bidder.as_ref(),
            ) else {
                return err!(AuctionError::TooManyBids);
            };
            require_keys_eq!(evicted.auction, auction_key, AuctionError::WrongBidAccounts);
            require_keys_eq!(
                evicted_bidder.key(),
                evicted.bidder,
                AuctionError::Unauthorized
            );
            let index = evicted.index;
            let (page, slot) = page_slot(index);
            require!(
                page <= auction.extra_pages
                    && page_of(&ctx.accounts.book, &extra, page).load()?.deposits[slot] == evicted.deposit,
                AuctionError::WrongBidAccounts
            );
            // Every page is full, so every deposit counts.
            let mut smallest = u64::MAX;
            for page in 0..=auction.extra_pages {
                let book = page_of(&ctx.accounts.book, &extra, page).load()?;
                smallest = smallest.min(book.deposits.iter().copied().min().unwrap_or(u64::MAX));
            }
            require!(evicted.deposit == smallest, AuctionError::NotSmallestBid);
            require!(
                deposit >= eviction_threshold(smallest)?,
                AuctionError::DepositTooSmall
            );
            let refund = evicted.deposit;
            let evicted_key = evicted.key();
            let evicted_owner = evicted.bidder;
            auction.total_deposited = auction
                .total_deposited
                .checked_sub(refund)
                .ok_or(AuctionError::MathOverflow)?;
            // Returns the whole balance (deposit and rent) to its owner.
            evicted.close(evicted_bidder.to_account_info())?;
            emit!(BidEvicted {
                auction: auction_key,
                bid: evicted_key,
                bidder: evicted_owner,
                index,
                refund,
            });
            index
        };
        let (page, slot) = page_slot(index);
        page_of(&ctx.accounts.book, &extra, page).load_mut()?.deposits[slot] = deposit;
        auction.total_deposited = auction
            .total_deposited
            .checked_add(deposit)
            .ok_or(AuctionError::MathOverflow)?;

        let bid = &mut ctx.accounts.bid;
        bid.price_ciphertext = price_ciphertext;
        bid.quantity_ciphertext = quantity_ciphertext;
        bid.client_pubkey = client_pubkey;
        bid.nonce = nonce;
        bid.auction = auction_key;
        bid.bidder = ctx.accounts.bidder.key();
        bid.index = index;
        bid.deposit = deposit;
        bid.status = BidStatus::Sealed;
        bid.pending_computation = Pubkey::default();
        bid.pending_since = 0;
        bid.pending_slot = 0;
        bid.pending_slot_counter = 0;
        bid.outcome = OUTCOME_NONE;
        bid.won = 0;
        bid.payment = 0;
        bid.delivered = false;
        bid.nfts_claimed = 0;
        bid.bump = ctx.bumps.bid;
        bid.first_position = 0;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.bidder.to_account_info(),
                    to: ctx.accounts.bid.to_account_info(),
                },
            ),
            deposit,
        )?;
        // The bid's share of the crank pool: not refunded, it pays whoever
        // checks and settles the bids.
        let crank_fee = bid_crank_fee(&ctx.accounts.auction.crank_rewards);
        add_to_crank_pool(
            &mut ctx.accounts.auction,
            &ctx.accounts.bidder.to_account_info(),
            &ctx.accounts.system_program,
            crank_fee,
        )?;

        emit!(BidPlaced {
            auction: ctx.accounts.auction.key(),
            bid: ctx.accounts.bid.key(),
            bidder: ctx.accounts.bidder.key(),
            index,
            deposit,
            crank_fee,
        });
        Ok(())
    }

    /// Replaces a sealed bid while bidding is open: a new encryption of
    /// `BidInput { price, quantity }` under a fresh key (with the same
    /// address-bound nonce as `place_bid`), and `extra_deposit` more lamports
    /// on its deposit. A deposit can only grow, so a bid can never be shrunk
    /// or pulled to fake demand; the app only offers raising the price and
    /// size. Only the latest version is checked when bidding closes, against
    /// the whole deposit. `book` is the page of the bid book that holds the
    /// bid (`page_slot`).
    #[allow(clippy::too_many_arguments)]
    pub fn increase_bid(
        ctx: Context<IncreaseBid>,
        price_ciphertext: [u8; 32],
        quantity_ciphertext: [u8; 32],
        client_pubkey: [u8; 32],
        client_pubkey_edwards_y: [u8; 32],
        nonce: u128,
        extra_deposit: u64,
    ) -> Result<()> {
        require!(
            nonce == bid_nonce(&ctx.accounts.bid.key()),
            AuctionError::InvalidNonce
        );
        require!(
            is_canonical_field_element(&price_ciphertext)
                && is_canonical_field_element(&quantity_ciphertext),
            AuctionError::InvalidCiphertext
        );
        require!(
            is_usable_x25519_key(&client_pubkey, &client_pubkey_edwards_y),
            AuctionError::InvalidEncryptionKey
        );
        let now = Clock::get()?.unix_timestamp;
        let auction = &mut ctx.accounts.auction;
        require!(auction.status == AuctionStatus::Open, AuctionError::WrongStatus);
        require!(now >= auction.start_time, AuctionError::BiddingNotStarted);
        require!(now < auction.end_time, AuctionError::BiddingClosed);
        require!(
            ctx.accounts.bid.status == BidStatus::Sealed,
            AuctionError::BidAlreadySettled
        );

        let deposit = ctx
            .accounts
            .bid
            .deposit
            .checked_add(extra_deposit)
            .ok_or(AuctionError::MathOverflow)?;
        let (page, slot) = page_slot(ctx.accounts.bid.index);
        require_keys_eq!(
            ctx.accounts.book.key(),
            page_address(auction, page)?,
            AuctionError::WrongBookPage
        );
        ctx.accounts.book.load_mut()?.deposits[slot] = deposit;
        auction.total_deposited = auction
            .total_deposited
            .checked_add(extra_deposit)
            .ok_or(AuctionError::MathOverflow)?;

        let bid = &mut ctx.accounts.bid;
        bid.price_ciphertext = price_ciphertext;
        bid.quantity_ciphertext = quantity_ciphertext;
        bid.client_pubkey = client_pubkey;
        bid.deposit = deposit;
        if extra_deposit > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: ctx.accounts.bidder.to_account_info(),
                        to: ctx.accounts.bid.to_account_info(),
                    },
                ),
                extra_deposit,
            )?;
        }
        emit!(BidIncreased {
            auction: ctx.accounts.auction.key(),
            bid: ctx.accounts.bid.key(),
            bidder: ctx.accounts.bidder.key(),
            deposit,
        });
        Ok(())
    }

    /// Checks the next batch of bids and stores it, encrypted, in the bid
    /// book. Anyone can call this once bidding has closed. Pass the bids with
    /// indices `checked_count..checked_count + min(BATCH_SIZE, remaining)` as
    /// remaining accounts, in order, and as `book` the page that holds them.
    pub fn check_batch<'info>(
        ctx: Context<'info, CheckBatch<'info>>,
        computation_offset: u64,
    ) -> Result<()> {
        require_pinned_circuit(&ctx.accounts.comp_def_account, circuit_hash!("check_bids_v2"))?;
        let now = Clock::get()?.unix_timestamp;
        let auction = &ctx.accounts.auction;
        let count = check_allowed(auction, now)?;
        let bids = load_batch(auction, ctx.remaining_accounts, count)?;
        let (page, _) = page_slot(auction.checked_count);
        require_keys_eq!(
            ctx.accounts.book.key(),
            page_address(auction, page)?,
            AuctionError::WrongBookPage
        );

        // Parameter order follows the circuit: the bids, then the public
        // terms.
        let args = push_bid_batch(ArgBuilder::new(), &bids, count)
            .plaintext_u8(count as u8)
            .plaintext_bool(auction.kind == AuctionKind::Token)
            .plaintext_u32(auction.min_price)
            .plaintext_u64(auction.price_scale)
            .plaintext_u64(auction.max_per_bid as u64)
            .plaintext_u64(min_budget(auction))
            .build();

        let auction_key = auction.key();
        let book_key = ctx.accounts.book.key();
        let computation = ctx.accounts.computation_account.key();
        let auction = &mut ctx.accounts.auction;
        auction.pending_computation = computation;
        auction.pending_since = now;
        auction.pending_batch = count as u8;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Order must match the custom accounts of `CheckBidsV2Callback`.
        let callback_accounts = [
            CallbackAccount {
                pubkey: auction_key,
                is_writable: true,
            },
            CallbackAccount {
                pubkey: book_key,
                is_writable: true,
            },
            CallbackAccount {
                pubkey: ctx.accounts.payer.key(),
                is_writable: true,
            },
        ];
        let callback = CheckBidsV2Callback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &callback_accounts,
        )?;
        queue_computation_exact(ctx.accounts, computation_offset, args, callback)?;
        let (slot, counter) = computation_identity(&ctx.accounts.computation_account)?;
        ctx.accounts.auction.pending_slot = slot;
        ctx.accounts.auction.pending_slot_counter = counter;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "check_bids_v2")]
    pub fn check_bids_v2_callback(
        ctx: Context<CheckBidsV2Callback>,
        output: SignedComputationOutputs<CheckBidsV2Output>,
    ) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        check_callback_computation(
            &ctx.accounts.computation_account,
            &auction.pending_computation,
            auction.pending_slot,
            auction.pending_slot_counter,
        )?;
        require!(
            auction.status == AuctionStatus::Open,
            AuctionError::WrongStatus
        );
        let record = match output {
            SignedComputationOutputs::Failure(_) => {
                clear_auction_pending(auction);
                emit!(ComputationFailed {
                    auction: auction.key(),
                    bid: None,
                });
                return Ok(());
            }
            other => {
                let CheckBidsV2Output { field_0 } = other.verify_output(
                    &ctx.accounts.cluster_account,
                    &ctx.accounts.computation_account,
                )?;
                field_0
            }
        };
        let reward = auction.crank_rewards.check_batch;
        pay_cranker(auction, &ctx.accounts.cranker.to_account_info(), reward)?;

        // Every batch starts at a multiple of BATCH_SIZE, so this is the
        // batch's position in its page of the book.
        let (page, slot) = page_slot(auction.checked_count);
        require_keys_eq!(
            ctx.accounts.book.key(),
            page_address(auction, page)?,
            AuctionError::WrongBookPage
        );
        let batch = slot / BATCH_SIZE;
        let mut book = ctx.accounts.book.load_mut()?;
        book.batch_records[batch] = record.ciphertexts;
        book.batch_nonces[batch] = record.nonce.to_le_bytes();
        drop(book);

        auction.checked_count = auction
            .checked_count
            .checked_add(auction.pending_batch as u32)
            .ok_or(AuctionError::MathOverflow)?;
        require!(
            auction.checked_count <= auction.bid_count,
            AuctionError::MathOverflow
        );
        clear_auction_pending(auction);
        emit!(BatchChecked {
            auction: auction.key(),
            checked_count: auction.checked_count,
            bid_count: auction.bid_count,
        });
        Ok(())
    }

    /// Reveals the clearing price once every bid is checked, from all the
    /// batch records at once. Anyone can call it. Only while the bids fit on
    /// the first page of the book; with more, `fold_clearing` finds the
    /// price a page at a time.
    pub fn find_clearing(ctx: Context<FindClearing>, computation_offset: u64) -> Result<()> {
        require_pinned_circuit(
            &ctx.accounts.comp_def_account,
            circuit_hash!("clear_price_v2"),
        )?;
        let auction = &ctx.accounts.auction;
        let now = Clock::get()?.unix_timestamp;
        require!(
            auction.status == AuctionStatus::Open,
            AuctionError::WrongStatus
        );
        require!(now >= auction.end_time, AuctionError::BiddingOpen);
        require!(before_emergency(auction, now)?, AuctionError::EmergencyActive);
        require!(auction.bid_count > 0, AuctionError::NoBids);
        require!(
            auction.checked_count == auction.bid_count,
            AuctionError::BidsNotChecked
        );
        require!(pages_in_use(auction) == 1, AuctionError::UsePagedClearing);
        ensure_idle(&auction.pending_computation, auction.pending_since, now)?;

        let active_batches = page_active_batches(auction.bid_count, 0);
        let args = {
            let book = ctx.accounts.book.load()?;
            clearing_arguments(
                &book.batch_nonces,
                ctx.accounts.book.key(),
                active_batches,
                auction.kind == AuctionKind::Token,
                auction.price_unit,
                auction.supply,
            )
        };

        let auction_key = auction.key();
        let computation = ctx.accounts.computation_account.key();
        let auction = &mut ctx.accounts.auction;
        auction.pending_computation = computation;
        auction.pending_since = now;
        auction.pending_batch = 0;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let callback = ClearPriceV2Callback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: auction_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: ctx.accounts.payer.key(),
                    is_writable: true,
                },
            ],
        )?;
        queue_computation_exact(ctx.accounts, computation_offset, args, callback)?;
        let (slot, counter) = computation_identity(&ctx.accounts.computation_account)?;
        ctx.accounts.auction.pending_slot = slot;
        ctx.accounts.auction.pending_slot_counter = counter;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "clear_price_v2")]
    pub fn clear_price_v2_callback(
        ctx: Context<ClearPriceV2Callback>,
        output: SignedComputationOutputs<ClearPriceV2Output>,
    ) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        check_callback_computation(
            &ctx.accounts.computation_account,
            &auction.pending_computation,
            auction.pending_slot,
            auction.pending_slot_counter,
        )?;
        require!(
            auction.status == AuctionStatus::Open,
            AuctionError::WrongStatus
        );
        let result = match output {
            SignedComputationOutputs::Failure(_) => {
                clear_auction_pending(auction);
                emit!(ComputationFailed {
                    auction: auction.key(),
                    bid: None,
                });
                return Ok(());
            }
            other => {
                let ClearPriceV2Output { field_0 } = other.verify_output(
                    &ctx.accounts.cluster_account,
                    &ctx.accounts.computation_account,
                )?;
                field_0
            }
        };
        let reward = auction.crank_rewards.clearing;
        pay_cranker(auction, &ctx.accounts.cranker.to_account_info(), reward)?;
        apply_clearing(auction, result.field_0, result.field_1, result.field_2)?;
        clear_auction_pending(auction);
        Ok(())
    }

    /// Runs the next step of the paged clearing, for an auction whose bids
    /// fill more than one page of its book: `fold_batch` reads one page for
    /// one digit of the clearing price (see `FOLD_PASSES`), and the step that
    /// ends the last pass reveals the price as `find_clearing` does. Anyone
    /// can call it once every bid is checked; pass as `book` the page the
    /// auction's `ClearingFold` names. Each step that succeeds pays its
    /// caller `fold_reward` from the crank pool.
    pub fn fold_clearing(ctx: Context<FoldClearing>, computation_offset: u64) -> Result<()> {
        require_pinned_circuit(&ctx.accounts.comp_def_account, circuit_hash!("fold_batch_v2"))?;
        let auction = &ctx.accounts.auction;
        let fold = &ctx.accounts.fold;
        let now = Clock::get()?.unix_timestamp;
        require!(
            auction.status == AuctionStatus::Open,
            AuctionError::WrongStatus
        );
        require!(now >= auction.end_time, AuctionError::BiddingOpen);
        require!(before_emergency(auction, now)?, AuctionError::EmergencyActive);
        require!(
            auction.checked_count == auction.bid_count,
            AuctionError::BidsNotChecked
        );
        let pages = pages_in_use(auction);
        require!(pages > 1, AuctionError::UseSingleClearing);
        require!(fold.pass < FOLD_PASSES, AuctionError::WrongStatus);
        ensure_idle(&auction.pending_computation, auction.pending_since, now)?;
        require_keys_eq!(
            ctx.accounts.book.key(),
            page_address(auction, fold.page)?,
            AuctionError::WrongBookPage
        );

        let step = fold_step(fold, pages);
        let args = {
            let book = ctx.accounts.book.load()?;
            fold_arguments(
                fold,
                ctx.accounts.fold.key(),
                &book.batch_nonces,
                ctx.accounts.book.key(),
                page_active_batches(auction.bid_count, fold.page),
                step,
                auction,
            )
        };

        let auction_key = auction.key();
        let fold_key = ctx.accounts.fold.key();
        let computation = ctx.accounts.computation_account.key();
        let auction = &mut ctx.accounts.auction;
        auction.pending_computation = computation;
        auction.pending_since = now;
        auction.pending_batch = 0;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Order must match the custom accounts of `FoldBatchV2Callback`.
        let callback = FoldBatchV2Callback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: auction_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: fold_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: ctx.accounts.payer.key(),
                    is_writable: true,
                },
            ],
        )?;
        queue_computation_exact(ctx.accounts, computation_offset, args, callback)?;
        let (slot, counter) = computation_identity(&ctx.accounts.computation_account)?;
        ctx.accounts.auction.pending_slot = slot;
        ctx.accounts.auction.pending_slot_counter = counter;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "fold_batch_v2")]
    pub fn fold_batch_v2_callback(
        ctx: Context<FoldBatchV2Callback>,
        output: SignedComputationOutputs<FoldBatchV2Output>,
    ) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        check_callback_computation(
            &ctx.accounts.computation_account,
            &auction.pending_computation,
            auction.pending_slot,
            auction.pending_slot_counter,
        )?;
        require!(
            auction.status == AuctionStatus::Open,
            AuctionError::WrongStatus
        );
        let (state, result) = match output {
            SignedComputationOutputs::Failure(_) => {
                clear_auction_pending(auction);
                emit!(ComputationFailed {
                    auction: auction.key(),
                    bid: None,
                });
                return Ok(());
            }
            other => {
                let FoldBatchV2Output { field_0 } = other.verify_output(
                    &ctx.accounts.cluster_account,
                    &ctx.accounts.computation_account,
                )?;
                (field_0.field_0, field_0.field_1)
            }
        };
        let reward = fold_reward(&auction.crank_rewards);
        pay_cranker(auction, &ctx.accounts.cranker.to_account_info(), reward)?;

        let fold = &mut ctx.accounts.fold;
        let pages = pages_in_use(auction);
        let step = fold_step(fold, pages);
        fold.state = state.ciphertexts;
        fold.state_nonce = state.nonce;
        fold.steps = fold.steps.checked_add(1).ok_or(AuctionError::MathOverflow)?;
        let (pass, page) = (fold.pass, fold.page);
        if step.decide {
            let digit = result.field_0;
            require!(digit < 1 << FOLD_DIGIT_BITS, AuctionError::InvalidClearing);
            fold.prefix = fold
                .prefix
                .checked_add((digit as u32) << step.shift)
                .ok_or(AuctionError::InvalidClearing)?;
            if step.last_pass {
                fold.pass = FOLD_PASSES;
                let price = fold.prefix;
                apply_clearing(auction, price, result.field_1, result.field_2)?;
            } else {
                fold.pass += 1;
                fold.page = next_fold_page(fold.pass, fold.page);
            }
        } else {
            fold.page = next_fold_page(fold.pass, fold.page);
        }
        clear_auction_pending(auction);
        emit!(ClearingFolded {
            auction: auction.key(),
            pass,
            page,
            steps: fold.steps,
            total_steps: fold_total_steps(pages),
            prefix: fold.prefix,
        });
        Ok(())
    }

    /// Decides one bid against the public clearing price, from the batch
    /// record `check_batch` stored for it in the page of the book that holds
    /// the bid (`book`). Anyone can call it. The callback
    /// only records what the bid won and moves the payment to the auction; a
    /// collection bid at the clearing price records its size and waits for
    /// `finalize_share`. Tokens and the unused deposit are collected
    /// afterwards with `claim_tokens` and `close_bid`, so settlement never
    /// depends on the bidder's accounts.
    pub fn settle_bid(ctx: Context<SettleBid>, computation_offset: u64) -> Result<()> {
        require_pinned_circuit(&ctx.accounts.comp_def_account, circuit_hash!("award_bid_v2"))?;
        let auction = &ctx.accounts.auction;
        let bid = &ctx.accounts.bid;
        let now = Clock::get()?.unix_timestamp;
        require!(
            auction.status == AuctionStatus::Settling,
            AuctionError::WrongStatus
        );
        // Once the safety net opens, no new computation may be queued, so an
        // endless chain of settlement attempts cannot hold off a refund.
        require!(before_emergency(auction, now)?, AuctionError::EmergencyActive);
        require!(
            auction.liquidity != LIQUIDITY_FAILED,
            AuctionError::LiquidityFloorMissed
        );
        require!(bid.status == BidStatus::Sealed, AuctionError::BidAlreadySettled);
        ensure_idle(&bid.pending_computation, bid.pending_since, now)?;

        // Settling implies every bid was checked, so this record exists.
        let (page, local) = page_slot(bid.index);
        require_keys_eq!(
            ctx.accounts.book.key(),
            page_address(auction, page)?,
            AuctionError::WrongBookPage
        );
        let batch = local / BATCH_SIZE;
        let slot = (local % BATCH_SIZE) as u8;
        let record_nonce = u128::from_le_bytes(ctx.accounts.book.load()?.batch_nonces[batch]);
        let record_offset = BATCH_RECORDS_OFFSET + BATCH_RECORD_LEN * batch as u32;

        let args = ArgBuilder::new()
            .plaintext_u128(record_nonce)
            .account(ctx.accounts.book.key(), record_offset, BATCH_RECORD_LEN)
            .plaintext_u8(slot)
            .plaintext_u32(auction.clearing_price)
            .plaintext_bool(auction.filled)
            .build();

        // Order must match the custom accounts of `AwardBidV2Callback`. The book
        // records the size of a collection bid at the clearing price.
        let callback_accounts = [
            CallbackAccount {
                pubkey: ctx.accounts.auction.key(),
                is_writable: true,
            },
            CallbackAccount {
                pubkey: ctx.accounts.bid.key(),
                is_writable: true,
            },
            CallbackAccount {
                pubkey: ctx.accounts.book.key(),
                is_writable: true,
            },
            CallbackAccount {
                pubkey: ctx.accounts.payer.key(),
                is_writable: true,
            },
        ];

        let computation = ctx.accounts.computation_account.key();
        let bid = &mut ctx.accounts.bid;
        bid.pending_computation = computation;
        bid.pending_since = now;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let callback = AwardBidV2Callback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &callback_accounts,
        )?;
        queue_computation_exact(ctx.accounts, computation_offset, args, callback)?;
        let (slot, counter) = computation_identity(&ctx.accounts.computation_account)?;
        ctx.accounts.bid.pending_slot = slot;
        ctx.accounts.bid.pending_slot_counter = counter;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "award_bid_v2")]
    pub fn award_bid_v2_callback(
        ctx: Context<AwardBidV2Callback>,
        output: SignedComputationOutputs<AwardBidV2Output>,
    ) -> Result<()> {
        check_callback_computation(
            &ctx.accounts.computation_account,
            &ctx.accounts.bid.pending_computation,
            ctx.accounts.bid.pending_slot,
            ctx.accounts.bid.pending_slot_counter,
        )?;
        let award = match output {
            SignedComputationOutputs::Failure(_) => {
                let bid = &mut ctx.accounts.bid;
                bid.pending_computation = Pubkey::default();
                bid.pending_since = 0;
                emit!(ComputationFailed {
                    auction: ctx.accounts.auction.key(),
                    bid: Some(bid.key()),
                });
                return Ok(());
            }
            other => {
                let AwardBidV2Output { field_0 } = other.verify_output(
                    &ctx.accounts.cluster_account,
                    &ctx.accounts.computation_account,
                )?;
                field_0
            }
        };
        let outcome = award.field_0;
        let quantity = award.field_1 as u64;
        let reward = ctx.accounts.auction.crank_rewards.settlement;
        pay_cranker(&mut ctx.accounts.auction, &ctx.accounts.cranker.to_account_info(), reward)?;

        require!(
            ctx.accounts.auction.status == AuctionStatus::Settling,
            AuctionError::WrongStatus
        );
        require!(
            ctx.accounts.bid.status == BidStatus::Sealed,
            AuctionError::BidAlreadySettled
        );

        if ctx.accounts.auction.kind == AuctionKind::Token {
            // The bid's private budget, revealed because it won something;
            // the check made sure its deposit covers it.
            let budget = quantity;
            require!(
                (outcome == OUTCOME_NONE) == (budget == 0) && budget <= ctx.accounts.bid.deposit,
                AuctionError::InvalidAllocation
            );
            let (won, payment) = token_award(&ctx.accounts.auction, outcome, budget)?;
            let auction = &mut ctx.accounts.auction;
            auction.sold = auction.sold.checked_add(won).ok_or(AuctionError::MathOverflow)?;
            require!(auction.sold <= auction.supply, AuctionError::Oversold);
            return settle_payment(&mut ctx.accounts.auction, &mut ctx.accounts.bid, outcome, won, payment);
        }

        if outcome == OUTCOME_AT {
            // The share depends on every other bid at the clearing price, so
            // only the size is recorded now; `finalize_share` does the rest.
            let (page, index) = page_slot(ctx.accounts.bid.index);
            let size = u32::try_from(quantity).map_err(|_| AuctionError::InvalidAllocation)?;
            require_keys_eq!(
                ctx.accounts.book.key(),
                page_address(&ctx.accounts.auction, page)?,
                AuctionError::WrongBookPage
            );
            let mut book = ctx.accounts.book.load_mut()?;
            require!(
                book.clearing_quantities[index] == 0,
                AuctionError::InvalidAllocation
            );
            book.clearing_quantities[index] = size;
            drop(book);
            record_clearing_quantity(&mut ctx.accounts.auction, quantity)?;

            let bid = &mut ctx.accounts.bid;
            bid.status = BidStatus::AtClearing;
            bid.outcome = outcome;
            bid.pending_computation = Pubkey::default();
            bid.pending_since = 0;
            emit!(BidAtClearing {
                auction: bid.auction,
                bid: bid.key(),
                bidder: bid.bidder,
                quantity,
            });
            return Ok(());
        }

        let won = collection_fill(&ctx.accounts.auction, outcome, quantity)?;
        let payment = nft_payment(&ctx.accounts.auction, won)?;
        let auction = &mut ctx.accounts.auction;
        auction.sold = auction.sold.checked_add(won).ok_or(AuctionError::MathOverflow)?;
        require!(auction.sold <= auction.supply, AuctionError::Oversold);
        settle_payment(&mut ctx.accounts.auction, &mut ctx.accounts.bid, outcome, won, payment)
    }

    /// Settles a collection bid at the clearing price once every such bid is
    /// revealed: they share what the bids above them left, in proportion to
    /// their size and rounded down, and the NFTs lost to rounding go one each
    /// to the earliest of them (lowest bid index), so every NFT is sold.
    /// Anyone can call it; the payment moves to the auction as in any
    /// settlement. `book` is the first page; pass every further page, in
    /// order, as remaining accounts.
    pub fn finalize_share<'info>(ctx: Context<'info, FinalizeShare<'info>>) -> Result<()> {
        let auction = &ctx.accounts.auction;
        let bid = &ctx.accounts.bid;
        require!(bid.status == BidStatus::AtClearing, AuctionError::NotAtClearing);
        require!(shares_are_final(auction), AuctionError::SharesNotReady);
        let remaining = clearing_remainder(auction)?;
        let weight_at = u64::try_from(auction.weight_at).map_err(|_| AuctionError::InvalidAllocation)?;
        let extra = extra_pages(auction, ctx.remaining_accounts)?;
        let share = {
            // Sizes by bid index across every page.
            let mut sizes = Vec::with_capacity(PAGE_BIDS_USIZE * (1 + extra.len()));
            for page in 0..=auction.extra_pages {
                sizes.extend_from_slice(&page_of(&ctx.accounts.book, &extra, page).load()?.clearing_quantities);
            }
            clearing_share(&sizes, bid.index, remaining, weight_at)?
        };
        let payment = nft_payment(auction, share)?;
        settle_payment(&mut ctx.accounts.auction, &mut ctx.accounts.bid, OUTCOME_AT, share, payment)
    }

    /// Has Arcium draw the seed that decides which NFTs each winner of a
    /// collection gets. It can only be drawn once every bid is settled: by
    /// then each winning bid holds its places (`Bid::first_position`), and
    /// nobody knew the seed while they were handed out, so nobody can steer
    /// which NFTs a win becomes. Anyone can call it.
    pub fn draw_nft_seed(ctx: Context<DrawNftSeed>, computation_offset: u64) -> Result<()> {
        require_pinned_circuit(&ctx.accounts.comp_def_account, circuit_hash!("draw_seed"))?;
        let auction = &ctx.accounts.auction;
        let now = Clock::get()?.unix_timestamp;
        require!(
            auction.kind == AuctionKind::Collection,
            AuctionError::WrongAuctionKind
        );
        require!(
            matches!(
                auction.status,
                AuctionStatus::Settling | AuctionStatus::Finished
            ),
            AuctionError::WrongStatus
        );
        require!(!auction.seed_drawn, AuctionError::SeedAlreadyDrawn);
        require!(
            auction.resolved_count == auction.bid_count,
            AuctionError::NotSettled
        );
        require!(auction.sold > 0, AuctionError::NothingSold);
        require!(
            auction.assigned_positions as u64 == auction.sold,
            AuctionError::InvalidAllocation
        );
        // From the safety net on, places are their own NFT numbers (see
        // `claim_nfts`), so a seed drawn later must not change them.
        require!(before_emergency(auction, now)?, AuctionError::EmergencyActive);
        ensure_idle(&auction.pending_computation, auction.pending_since, now)?;

        let auction_key = auction.key();
        let computation = ctx.accounts.computation_account.key();
        let auction = &mut ctx.accounts.auction;
        auction.pending_computation = computation;
        auction.pending_since = now;
        auction.pending_batch = 0;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let callback = DrawSeedCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                CallbackAccount {
                    pubkey: auction_key,
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: ctx.accounts.payer.key(),
                    is_writable: true,
                },
            ],
        )?;
        queue_computation_exact(ctx.accounts, computation_offset, ArgBuilder::new().build(), callback)?;
        let (slot, counter) = computation_identity(&ctx.accounts.computation_account)?;
        ctx.accounts.auction.pending_slot = slot;
        ctx.accounts.auction.pending_slot_counter = counter;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "draw_seed")]
    pub fn draw_seed_callback(
        ctx: Context<DrawSeedCallback>,
        output: SignedComputationOutputs<DrawSeedOutput>,
    ) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        check_callback_computation(
            &ctx.accounts.computation_account,
            &auction.pending_computation,
            auction.pending_slot,
            auction.pending_slot_counter,
        )?;
        let seed = match output {
            SignedComputationOutputs::Failure(_) => {
                clear_auction_pending(auction);
                emit!(ComputationFailed {
                    auction: auction.key(),
                    bid: None,
                });
                return Ok(());
            }
            other => {
                let DrawSeedOutput { field_0 } = other.verify_output(
                    &ctx.accounts.cluster_account,
                    &ctx.accounts.computation_account,
                )?;
                field_0
            }
        };
        let reward = auction.crank_rewards.seed_draw;
        pay_cranker(auction, &ctx.accounts.cranker.to_account_info(), reward)?;
        clear_auction_pending(auction);
        // Once the safety net is open, NFTs may already have been minted with
        // places as their numbers; a seed arriving now must not change the
        // numbers of the rest.
        let now = Clock::get()?.unix_timestamp;
        if auction.seed_drawn || !before_emergency(auction, now)? {
            return Ok(());
        }
        auction.nft_seed = seed;
        auction.seed_drawn = true;
        emit!(NftsShuffled {
            auction: auction.key(),
            seed,
        });
        Ok(())
    }

    /// Delivers a winning bid's tokens to its owner's associated token
    /// account. Anyone can call it and pays for that account if it does not
    /// exist yet; the tokens only ever go to the bid's owner. Once the seller
    /// has been paid and the last winner has collected, the empty vault is
    /// closed and its rent returned to the seller.
    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        let auction = &ctx.accounts.auction;
        let bid = &ctx.accounts.bid;
        require!(bid.status == BidStatus::Settled, AuctionError::NotSettled);
        require!(bid.won > 0, AuctionError::NothingToClaim);
        require!(!bid.delivered, AuctionError::AlreadyClaimed);
        let amount = bid.won;
        let delivered = auction
            .delivered
            .checked_add(amount)
            .ok_or(AuctionError::MathOverflow)?;
        require!(delivered <= auction.sold, AuctionError::Oversold);

        let seed_bytes = auction.seed.to_le_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[
            AUCTION_SEED,
            auction.seller.as_ref(),
            &seed_bytes,
            &[auction.bump],
        ]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.bidder_token_account.to_account_info(),
                    authority: ctx.accounts.auction.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        if auction.status == AuctionStatus::Finished && delivered == auction.sold {
            ctx.accounts.vault.reload()?;
            if ctx.accounts.vault.amount == 0 {
                token_interface::close_account(CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    CloseAccount {
                        account: ctx.accounts.vault.to_account_info(),
                        destination: ctx.accounts.seller.to_account_info(),
                        authority: ctx.accounts.auction.to_account_info(),
                    },
                    signer_seeds,
                ))?;
            }
        }

        ctx.accounts.auction.delivered = delivered;
        let bid = &mut ctx.accounts.bid;
        bid.delivered = true;
        emit!(TokensClaimed {
            auction: bid.auction,
            bid: bid.key(),
            bidder: bid.bidder,
            amount,
        });
        Ok(())
    }

    /// Pays the seller: SOL proceeds, less the platform's sale fee, plus any
    /// unsold tokens. Allowed once every bid is resolved, once an auction
    /// without bids has ended, or once the safety net is open (unsettled bids
    /// then stay refundable by their owners). Tokens that winners have not
    /// collected yet stay in the vault for them.
    pub fn claim_proceeds(ctx: Context<SellerWithdraw>) -> Result<()> {
        let auction = &ctx.accounts.auction;
        let now = Clock::get()?.unix_timestamp;
        require!(seller_can_claim(auction, now)?, AuctionError::NotSettled);
        // A planned pool opens first (`bootstrap_liquidity`), or the plan is
        // released (`release_liquidity`).
        require!(
            auction.liquidity != LIQUIDITY_PLANNED,
            AuctionError::LiquidityPending
        );

        let owed = auction
            .sold
            .checked_sub(auction.delivered)
            .ok_or(AuctionError::MathOverflow)?;
        let unsold = ctx
            .accounts
            .vault
            .amount
            .checked_sub(owed)
            .ok_or(AuctionError::MathOverflow)?;
        pay_out_vault(&ctx, unsold, owed == 0)?;
        let (proceeds, fee) = pay_proceeds(
            &ctx.accounts.auction,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
        )?;

        let auction = &mut ctx.accounts.auction;
        auction.status = AuctionStatus::Finished;
        emit!(ProceedsClaimed {
            auction: auction.key(),
            seller: auction.seller,
            proceeds,
            fee,
            unsold_amount: unsold,
        });
        Ok(())
    }

    /// Pays the seller of a collection auction its proceeds, less the
    /// platform's sale fee, on the same conditions as `claim_proceeds`.
    /// Unsold NFTs are simply never minted; winners can still claim theirs
    /// afterwards. A hidden collection pays out only once revealed. If it
    /// sold nothing it can finish without a reveal; if it sold NFTs and was
    /// never revealed, it can finish (with nothing to pay) once the time to
    /// reveal is over and every winner has taken their payment back.
    pub fn claim_collection_proceeds(ctx: Context<CollectionSeller>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            seller_can_claim(&ctx.accounts.auction, now)?,
            AuctionError::NotSettled
        );
        let auction = &ctx.accounts.auction;
        require!(
            !auction.unrevealed
                || auction.sold == 0
                || (!before_reveal_deadline(auction, now)? && auction.proceeds == 0),
            AuctionError::NotRevealed
        );
        let (proceeds, fee) = pay_proceeds(
            &ctx.accounts.auction,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
        )?;
        let auction = &mut ctx.accounts.auction;
        auction.status = AuctionStatus::Finished;
        emit!(ProceedsClaimed {
            auction: auction.key(),
            seller: auction.seller,
            proceeds,
            fee,
            unsold_amount: auction.supply.saturating_sub(auction.sold),
        });
        Ok(())
    }

    /// Mints NFTs that a winning bid of a collection auction is owed,
    /// straight to the bid's owner. The bid holds places `first_position`
    /// onwards, one per NFT it won; each place becomes an NFT number through
    /// the shuffle `draw_nft_seed` drew (`shuffled_items`). Should the draw
    /// never have happened by the time the safety net opens, each place is
    /// its own number, so winners can always collect. Pass the asset
    /// addresses of the bid's next places as remaining accounts, writable:
    /// `[ASSET_SEED, auction, place]` for each place from `first_position +
    /// nfts_claimed` on, at most `MAX_NFTS_PER_CLAIM` and no more than the
    /// bid is still owed. Anyone can call it and pays the NFTs' rent; the
    /// NFTs only ever go to the bid's owner. A collection named per item
    /// needs its `item_list`, and a hidden one must have been revealed.
    pub fn claim_nfts<'info>(ctx: Context<'info, ClaimNfts<'info>>) -> Result<()> {
        let auction = &ctx.accounts.auction;
        let bid = &ctx.accounts.bid;
        require!(!auction.unrevealed, AuctionError::NotRevealed);
        require!(bid.status == BidStatus::Settled, AuctionError::NotSettled);
        require!(bid.won > 0, AuctionError::NothingToClaim);
        let owed = bid
            .won
            .checked_sub(bid.nfts_claimed as u64)
            .ok_or(AuctionError::MathOverflow)?;
        require!(owed > 0, AuctionError::AlreadyClaimed);
        let now = Clock::get()?.unix_timestamp;
        let shuffled = auction.seed_drawn;
        require!(
            shuffled || !before_emergency(auction, now)?,
            AuctionError::NftsNotShuffled
        );
        let assets = ctx.remaining_accounts;
        let count = assets.len();
        require!(
            count > 0 && count <= MAX_NFTS_PER_CLAIM && count as u64 <= owed,
            AuctionError::WrongAssetAccounts
        );
        let delivered = auction
            .delivered
            .checked_add(count as u64)
            .ok_or(AuctionError::MathOverflow)?;
        require!(delivered <= auction.sold, AuctionError::Oversold);
        let first_position = (bid.first_position as u64)
            .checked_add(bid.nfts_claimed as u64)
            .ok_or(AuctionError::MathOverflow)?;
        let positions = (0..count as u64)
            .map(|k| u32::try_from(first_position + k).map_err(|_| AuctionError::MathOverflow.into()))
            .collect::<Result<Vec<u32>>>()?;
        // A bid's places were handed out when it settled, inside the range
        // every winning bid shares.
        require!(
            first_position + count as u64 <= auction.assigned_positions as u64,
            AuctionError::InvalidAllocation
        );
        let items = if shuffled {
            let supply = u32::try_from(auction.supply).map_err(|_| AuctionError::MathOverflow)?;
            shuffled_items(&positions, supply, auction.nft_seed)?
        } else {
            positions.clone()
        };
        let names = if auction.named_items {
            let list = ctx
                .accounts
                .item_list
                .as_ref()
                .ok_or(AuctionError::ItemListMismatch)?;
            let info = list.to_account_info();
            let data = info.try_borrow_data()?;
            let entries = data
                .get(ITEM_LIST_HEADER_LEN..)
                .ok_or(AuctionError::ItemListMismatch)?;
            items
                .iter()
                .map(|&item| item_nft_name(entries, list.count, item))
                .collect::<Result<Vec<String>>>()?
        } else {
            items.iter().map(|&item| nft_name(&auction.item_name, item)).collect()
        };

        let auction_key = auction.key();
        let seed_bytes = auction.seed.to_le_bytes();
        let auction_bump = [auction.bump];
        let auction_seeds: &[&[u8]] = &[
            AUCTION_SEED,
            auction.seller.as_ref(),
            &seed_bytes,
            &auction_bump,
        ];
        let payer = ctx.accounts.payer.to_account_info();
        for (k, asset) in assets.iter().enumerate() {
            let position_bytes = positions[k].to_le_bytes();
            let item = items[k];
            let (expected, asset_bump) = Pubkey::find_program_address(
                &[ASSET_SEED, auction_key.as_ref(), &position_bytes],
                &crate::ID,
            );
            require_keys_eq!(asset.key(), expected, AuctionError::WrongAssetAccounts);
            let asset_seeds: &[&[u8]] = &[
                ASSET_SEED,
                auction_key.as_ref(),
                &position_bytes,
                &[asset_bump],
            ];
            reclaim_prefunded(asset, asset_seeds, &payer)?;
            let create = Instruction {
                program_id: MPL_CORE_ID,
                accounts: vec![
                    AccountMeta::new(expected, true),
                    AccountMeta::new(ctx.accounts.collection.key(), false),
                    // The collection's update authority signs for the new NFT.
                    AccountMeta::new_readonly(auction_key, true),
                    AccountMeta::new(payer.key(), true),
                    AccountMeta::new_readonly(ctx.accounts.bidder.key(), false),
                    // No update authority of its own: it uses the collection's.
                    AccountMeta::new_readonly(MPL_CORE_ID, false),
                    AccountMeta::new_readonly(System::id(), false),
                    // No log wrapper.
                    AccountMeta::new_readonly(MPL_CORE_ID, false),
                ],
                data: core_create_asset_data(
                    &names[k],
                    &nft_uri(&auction.item_uri, item, auction.uri_per_item),
                ),
            };
            invoke_signed(
                &create,
                &[
                    asset.clone(),
                    ctx.accounts.collection.to_account_info(),
                    ctx.accounts.auction.to_account_info(),
                    payer.clone(),
                    ctx.accounts.bidder.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                    ctx.accounts.mpl_core_program.to_account_info(),
                ],
                &[auction_seeds, asset_seeds],
            )?;
        }

        ctx.accounts.auction.delivered = delivered;
        let bid = &mut ctx.accounts.bid;
        bid.nfts_claimed = bid
            .nfts_claimed
            .checked_add(count as u32)
            .ok_or(AuctionError::MathOverflow)?;
        bid.delivered = bid.nfts_claimed as u64 == bid.won;
        emit!(NftsClaimed {
            auction: auction_key,
            bid: bid.key(),
            bidder: bid.bidder,
            first_position: positions[0],
            items,
        });
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Auto-liquidity (see the `liquidity` module)
    // -----------------------------------------------------------------------

    /// Opts a token auction into auto-liquidity before any bid: `lp_bps` of
    /// the net proceeds (20% to 100%), raised to at least `floor` lamports,
    /// will open a Meteora DAMM v2 pool at the clearing price with a
    /// `trade_fee_bps` fee (0.25%, 1% or 2%) after a 10-minute anti-sniper
    /// fee. Escrows a reserve of as many tokens as are for sale and the
    /// pool's rent; what the pool does not use comes back.
    pub fn plan_liquidity(
        ctx: Context<PlanLiquidity>,
        lp_bps: u16,
        floor: u64,
        trade_fee_bps: u16,
    ) -> Result<()> {
        liquidity::plan(ctx, lp_bps, floor, trade_fee_bps)
    }

    /// Opens the planned pool once every bid is settled, locks its position
    /// for good and pays the seller the rest of the proceeds, less the sale
    /// fee. Anyone can call it. If DAMM v2's pool for this token and SOL
    /// already exists, no pool opens and the seller gets everything.
    pub fn bootstrap_liquidity<'info>(ctx: Context<'info, BootstrapLiquidity<'info>>) -> Result<()> {
        liquidity::bootstrap(ctx)
    }

    /// Claims the pool's trading fees and pays them out: 80% to the seller,
    /// 20% to the platform. Anyone can call it.
    pub fn claim_pool_fees(ctx: Context<ClaimPoolFees>) -> Result<()> {
        liquidity::claim_fees(ctx)
    }

    /// Returns the reserve and the rent deposit to the seller when no pool
    /// will open: the sale missed the floor, was cancelled, ended without
    /// bids, or stalled until the safety net opened.
    pub fn release_liquidity(ctx: Context<ReleaseLiquidity>) -> Result<()> {
        liquidity::release(ctx)
    }

    /// Refunds a bid of a sale that missed its pool's minimum: no MPC
    /// needed, the whole deposit and the account's rent go back to the
    /// bidder. Anyone can call it.
    pub fn refund_failed_bid(ctx: Context<EmergencyRefund>) -> Result<()> {
        let auction = &ctx.accounts.auction;
        require!(
            auction.liquidity == LIQUIDITY_FAILED && auction.status == AuctionStatus::Settling,
            AuctionError::LiquidityNotPlanned
        );
        require!(
            ctx.accounts.bid.status == BidStatus::Sealed,
            AuctionError::BidAlreadySettled
        );
        let deposit = ctx.accounts.bid.deposit;
        let auction = &mut ctx.accounts.auction;
        auction.resolved_count = auction
            .resolved_count
            .checked_add(1)
            .ok_or(AuctionError::MathOverflow)?;
        auction.live_bids = auction
            .live_bids
            .checked_sub(1)
            .ok_or(AuctionError::MathOverflow)?;
        emit!(BidRefunded {
            auction: auction.key(),
            bid: ctx.accounts.bid.key(),
            bidder: ctx.accounts.bid.bidder,
            amount: deposit,
        });
        Ok(())
    }

    /// Safety net: once `EMERGENCY_DELAY_SECS` have passed since the end of
    /// bidding, an unsettled bid's full deposit and the account's rent go back
    /// to its owner and the bid counts as lost. That includes a collection bid
    /// at the clearing price whose share can no longer be finalized because
    /// another such bid was never revealed. Anyone can call it; the lamports
    /// only ever go to the bid's owner.
    pub fn emergency_refund(ctx: Context<EmergencyRefund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let auction = &ctx.accounts.auction;
        let bid = &ctx.accounts.bid;
        require!(!before_emergency(auction, now)?, AuctionError::TooEarly);
        match bid.status {
            BidStatus::Sealed => ensure_idle(&bid.pending_computation, bid.pending_since, now)?,
            // A share that can still be finalized must be: refunding it
            // would leave its NFTs counted as sold.
            BidStatus::AtClearing => require!(!shares_are_final(auction), AuctionError::ShareReady),
            BidStatus::Settled => return err!(AuctionError::BidAlreadySettled),
        }

        let deposit = bid.deposit;
        let auction = &mut ctx.accounts.auction;
        auction.resolved_count = auction
            .resolved_count
            .checked_add(1)
            .ok_or(AuctionError::MathOverflow)?;
        auction.live_bids = auction
            .live_bids
            .checked_sub(1)
            .ok_or(AuctionError::MathOverflow)?;
        // The `close = bidder` constraint returns every lamport in the bid
        // account (deposit and rent) when the instruction ends.
        emit!(BidRefunded {
            auction: auction.key(),
            bid: ctx.accounts.bid.key(),
            bidder: ctx.accounts.bid.bidder,
            amount: deposit,
        });
        Ok(())
    }

    /// Stores the bidder's note on their bid, so they can see what they
    /// sealed on any device, or rewrites it after `increase_bid`. The note is opaque here: the bidder's app
    /// encrypts it under a key made from their wallet's signature, so only
    /// they can read it. Its rent comes back with `close_bid_note`.
    pub fn save_bid_note(ctx: Context<SaveBidNote>, note: [u8; BID_NOTE_LEN]) -> Result<()> {
        let account = &mut ctx.accounts.note;
        account.bid = ctx.accounts.bid.key();
        account.bidder = ctx.accounts.bidder.key();
        account.note = note;
        account.bump = ctx.bumps.note;
        Ok(())
    }

    /// Closes a bid note and returns its rent to the bidder: at any time by
    /// the bidder, and by anyone once the bid itself is closed.
    pub fn close_bid_note(ctx: Context<CloseBidNote>) -> Result<()> {
        let bid = &ctx.accounts.bid;
        let bid_closed = bid.owner != &crate::ID || bid.data_is_empty();
        require!(
            bid_closed || ctx.accounts.closer.key() == ctx.accounts.note.bidder,
            AuctionError::BidStillOpen
        );
        Ok(())
    }

    /// Returns what is left of a settled bid's deposit, plus the account's
    /// rent, to its owner once anything it won has been delivered. Anyone can
    /// call it; the lamports only ever go to the bid's owner.
    pub fn close_bid(ctx: Context<CloseBid>) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        auction.live_bids = auction
            .live_bids
            .checked_sub(1)
            .ok_or(AuctionError::MathOverflow)?;
        let bid = &ctx.accounts.bid;
        emit!(BidClosed {
            auction: bid.auction,
            bid: bid.key(),
            bidder: bid.bidder,
            refund: bid.deposit.saturating_sub(bid.payment),
        });
        Ok(())
    }

    /// Closes a finished or cancelled auction once every bid account is
    /// closed, returning the rent of the auction, its bid book and its vault
    /// to the seller. Nothing is owed to anyone at that point, so tokens still
    /// in the vault (sent there by someone after the sale) go to the seller.
    /// An auction with more than one page of bid book passes the further
    /// pages, in order, as remaining accounts, and its `fold`; they close too.
    pub fn close_auction<'info>(ctx: Context<'info, CloseAuction<'info>>) -> Result<()> {
        let auction = &ctx.accounts.auction;
        require!(
            matches!(
                auction.status,
                AuctionStatus::Finished | AuctionStatus::Cancelled
            ),
            AuctionError::WrongStatus
        );
        require!(auction.live_bids == 0, AuctionError::BidsOutstanding);
        require!(
            matches!(
                auction.liquidity,
                LIQUIDITY_NONE | LIQUIDITY_POOLED | LIQUIDITY_RELEASED
            ),
            AuctionError::LiquidityPending
        );
        close_extra_pages(
            auction,
            ctx.remaining_accounts,
            ctx.accounts.fold.is_some(),
            &ctx.accounts.seller.to_account_info(),
        )?;

        let vault = ctx.accounts.vault.to_account_info();
        let mut swept = 0u64;
        // A vault closed earlier, possibly by `cancel_auction` in this same
        // transaction, has no lamports left.
        if vault.lamports() > 0 && !vault.data_is_empty() {
            // Still open: the last winner collected before the seller was
            // paid, or someone sent tokens after the vault emptied.
            require_keys_eq!(
                *vault.owner,
                ctx.accounts.token_program.key(),
                AuctionError::WrongVault
            );
            swept = {
                let data = vault.try_borrow_data()?;
                spl_token_2022::extension::StateWithExtensions::<
                    spl_token_2022::state::Account,
                >::unpack(&data)?
                .base
                .amount
            };
            let seed_bytes = auction.seed.to_le_bytes();
            let signer_seeds: &[&[&[u8]]] = &[&[
                AUCTION_SEED,
                auction.seller.as_ref(),
                &seed_bytes,
                &[auction.bump],
            ]];
            if swept > 0 {
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        TransferChecked {
                            from: vault.clone(),
                            mint: ctx.accounts.mint.to_account_info(),
                            to: ctx.accounts.seller_token_account.to_account_info(),
                            authority: ctx.accounts.auction.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    swept,
                    ctx.accounts.mint.decimals,
                )?;
            }
            token_interface::close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                CloseAccount {
                    account: vault,
                    destination: ctx.accounts.seller.to_account_info(),
                    authority: ctx.accounts.auction.to_account_info(),
                },
                signer_seeds,
            ))?;
        }
        // The `close = seller` constraints return the auction's and the
        // book's lamports (rent and anything sent there) when this ends.
        emit!(AuctionClosed {
            auction: ctx.accounts.auction.key(),
            seller: ctx.accounts.auction.seller,
            swept_amount: swept,
        });
        Ok(())
    }

    /// Closes a finished or cancelled collection auction once every bid
    /// account is closed, which means every NFT sold has been minted. Makes
    /// the seller the collection's update authority and returns the rent of
    /// the auction, its bid book and its item list to the seller. Further
    /// pages of the book and the `fold` close too, as in `close_auction`.
    pub fn close_collection_auction<'info>(
        ctx: Context<'info, CloseCollectionAuction<'info>>,
    ) -> Result<()> {
        let auction = &ctx.accounts.auction;
        require!(
            matches!(
                auction.status,
                AuctionStatus::Finished | AuctionStatus::Cancelled
            ),
            AuctionError::WrongStatus
        );
        require!(auction.live_bids == 0, AuctionError::BidsOutstanding);
        close_extra_pages(
            auction,
            ctx.remaining_accounts,
            ctx.accounts.fold.is_some(),
            &ctx.accounts.seller.to_account_info(),
        )?;
        // The item list, if any, closes with the auction (`close = seller`).
        require!(
            !auction.named_items || ctx.accounts.item_list.is_some(),
            AuctionError::ItemListMismatch
        );

        let seed_bytes = auction.seed.to_le_bytes();
        let auction_bump = [auction.bump];
        let auction_seeds: &[&[u8]] = &[
            AUCTION_SEED,
            auction.seller.as_ref(),
            &seed_bytes,
            &auction_bump,
        ];
        let seller = ctx.accounts.seller.to_account_info();
        let update = Instruction {
            program_id: MPL_CORE_ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.collection.key(), false),
                AccountMeta::new(seller.key(), true),
                AccountMeta::new_readonly(auction.key(), true),
                // The new update authority.
                AccountMeta::new_readonly(seller.key(), false),
                AccountMeta::new_readonly(System::id(), false),
                // No log wrapper.
                AccountMeta::new_readonly(MPL_CORE_ID, false),
            ],
            data: core_update_collection_data(),
        };
        invoke_signed(
            &update,
            &[
                ctx.accounts.collection.to_account_info(),
                seller.clone(),
                ctx.accounts.auction.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.mpl_core_program.to_account_info(),
            ],
            &[auction_seeds],
        )?;
        // The `close = seller` constraints return the auction's and the
        // book's lamports when this ends.
        emit!(AuctionClosed {
            auction: auction.key(),
            seller: auction.seller,
            swept_amount: 0,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Circuits are always fetched off chain and pinned to `hash`; registering an
/// unpinned, on-chain circuit is deliberately impossible.
fn circuit_source(url: String, hash: [u8; 32]) -> Result<Option<CircuitSource>> {
    require!(url.starts_with("https://"), AuctionError::InvalidCircuitUrl);
    Ok(Some(CircuitSource::OffChain(OffChainCircuitSource {
        source: url,
        hash,
    })))
}

/// Refuses to queue a computation unless its definition is active and pinned
/// to the circuit compiled into this program. Definitions can also be
/// registered directly with the Arcium program by the MXE authority; this
/// check makes sure only the pinned circuit ever runs on auction data.
fn require_pinned_circuit(comp_def: &ComputationDefinitionAccount, hash: [u8; 32]) -> Result<()> {
    require!(
        comp_def.deactivation_slot.is_none(),
        AuctionError::CircuitNotPinned
    );
    match &comp_def.circuit_source {
        CircuitSource::OffChain(source) if source.hash == hash => Ok(()),
        _ => err!(AuctionError::CircuitNotPinned),
    }
}

/// Smallest deposit that may evict a bid holding `smallest`.
pub fn eviction_threshold(smallest: u64) -> Result<u64> {
    let premium = smallest
        .checked_mul(EVICTION_PREMIUM_PERCENT)
        .ok_or(AuctionError::MathOverflow)?
        .div_ceil(100)
        .max(1);
    Ok(smallest
        .checked_add(premium)
        .ok_or(AuctionError::MathOverflow)?)
}

/// The nonce a bid stored at `bid` must be encrypted under: the first 16
/// bytes of `sha256(BID_NONCE_DOMAIN || bid)`, read as a little-endian u128.
pub fn bid_nonce(bid: &Pubkey) -> u128 {
    let digest = hashv(&[BID_NONCE_DOMAIN, bid.as_ref()]).to_bytes();
    let mut first = [0u8; 16];
    first.copy_from_slice(&digest[..16]);
    u128::from_le_bytes(first)
}

/// True when the little-endian `bytes` are below 2^255 - 19, i.e. the
/// canonical encoding of a field element. Honest clients only produce these.
pub fn is_canonical_field_element(bytes: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if bytes[i] != FIELD_MODULUS_LE[i] {
            return bytes[i] < FIELD_MODULUS_LE[i];
        }
    }
    false
}

/// Accepts exactly the x25519 public keys that Arcis accepts
/// (`is_valid_x25519_public_key`): a canonical u-coordinate, not one of
/// `REFUSED_KEYS`, of a point on Curve25519 itself (not its twist) that lies in
/// the prime-order subgroup. A key the cluster would refuse could otherwise
/// make every check of its batch fail and stall the auction.
///
/// `edwards_y` must be the y-coordinate of the matching Edwards point,
/// `(u - 1) / (u + 1)`; the caller computes it so the program only has to
/// check one multiplication instead of computing an inverse. Curve membership
/// and the subgroup check then run on the Edwards point through Solana's
/// curve25519 syscalls.
pub fn is_usable_x25519_key(key: &[u8; 32], edwards_y: &[u8; 32]) -> bool {
    if !is_canonical_field_element(key)
        || !is_canonical_field_element(edwards_y)
        || REFUSED_KEYS.contains(key)
    {
        return false;
    }
    let u = field::from_bytes(key);
    let y = field::from_bytes(edwards_y);
    // y * (u + 1) == u - 1 (mod p). For u = p - 1 the left side is 0 and
    // the right side is not, so that key is refused here.
    if field::mul(&y, &field::add_small(&u, 1)) != field::sub_small(&u, 1) {
        return false;
    }
    // With the sign bit clear this is one of the two points with this y; the
    // other is its negation, which has the same order.
    let point = PodEdwardsPoint(*edwards_y);
    if !validate_edwards(&point) {
        // No such point: u is on the twist.
        return false;
    }
    let Some(almost) = multiply_edwards(&PodScalar(SUBGROUP_ORDER_MINUS_ONE), &point) else {
        return false;
    };
    // (ℓ - 1) P + P = ℓ P is the identity exactly when P has order dividing ℓ.
    matches!(add_edwards(&almost, &point), Some(PodEdwardsPoint(bytes)) if bytes == EDWARDS_IDENTITY)
}

/// Minimal arithmetic modulo p = 2^255 - 19 on canonical little-endian
/// values, just enough to check an x25519 key's Edwards y-coordinate.
mod field {
    /// A value below p as four little-endian 64-bit limbs.
    pub type Fe = [u64; 4];

    const P: Fe = [
        0xffff_ffff_ffff_ffed,
        0xffff_ffff_ffff_ffff,
        0xffff_ffff_ffff_ffff,
        0x7fff_ffff_ffff_ffff,
    ];

    pub fn from_bytes(bytes: &[u8; 32]) -> Fe {
        let mut out = [0u64; 4];
        for (i, limb) in out.iter_mut().enumerate() {
            let mut chunk = [0u8; 8];
            chunk.copy_from_slice(&bytes[8 * i..8 * i + 8]);
            *limb = u64::from_le_bytes(chunk);
        }
        out
    }

    fn geq_p(a: &Fe) -> bool {
        for i in (0..4).rev() {
            if a[i] != P[i] {
                return a[i] > P[i];
            }
        }
        true
    }

    /// a - p, assuming a >= p.
    fn minus_p(a: &Fe) -> Fe {
        let mut out = [0u64; 4];
        let mut borrow = 0u64;
        for i in 0..4 {
            let (d1, b1) = a[i].overflowing_sub(P[i]);
            let (d2, b2) = d1.overflowing_sub(borrow);
            out[i] = d2;
            borrow = (b1 | b2) as u64;
        }
        out
    }

    /// Reduces a value below 2^256 to its canonical form below p.
    fn canonical(mut a: Fe) -> Fe {
        // 2^255 = 19 (mod p): fold the top bit back in, then subtract p once
        // if still needed.
        let top = a[3] >> 63;
        a[3] &= 0x7fff_ffff_ffff_ffff;
        let mut carry = 19 * top as u128;
        for limb in a.iter_mut() {
            let sum = *limb as u128 + carry;
            *limb = sum as u64;
            carry = sum >> 64;
        }
        if geq_p(&a) {
            minus_p(&a)
        } else {
            a
        }
    }

    /// a * b mod p.
    pub fn mul(a: &Fe, b: &Fe) -> Fe {
        let mut wide = [0u64; 8];
        for i in 0..4 {
            let mut carry = 0u128;
            for j in 0..4 {
                let cur = wide[i + j] as u128 + (a[i] as u128) * (b[j] as u128) + carry;
                wide[i + j] = cur as u64;
                carry = cur >> 64;
            }
            wide[i + 4] = carry as u64;
        }
        // 2^256 = 38 (mod p): fold the high half into the low half twice.
        let mut low = [0u64; 4];
        let mut carry = 0u128;
        for i in 0..4 {
            let cur = wide[i] as u128 + (wide[i + 4] as u128) * 38 + carry;
            low[i] = cur as u64;
            carry = cur >> 64;
        }
        let mut carry = carry * 38;
        for limb in low.iter_mut() {
            let cur = *limb as u128 + carry;
            *limb = cur as u64;
            carry = cur >> 64;
        }
        // A final carry means the sum wrapped past 2^256, which is again 38;
        // after the previous step `low` is small enough that this cannot
        // wrap a second time.
        if carry != 0 {
            let mut add = 38u128;
            for limb in low.iter_mut() {
                let cur = *limb as u128 + add;
                *limb = cur as u64;
                add = cur >> 64;
            }
        }
        canonical(low)
    }

    /// a + k mod p for a canonical `a` and a small `k`.
    pub fn add_small(a: &Fe, k: u64) -> Fe {
        let mut out = *a;
        let mut carry = k as u128;
        for limb in out.iter_mut() {
            let sum = *limb as u128 + carry;
            *limb = sum as u64;
            carry = sum >> 64;
        }
        // a < p and k is small, so out < 2^256 and `canonical` finishes it.
        canonical(out)
    }

    /// a - k mod p for a canonical `a` and a small `k`.
    pub fn sub_small(a: &Fe, k: u64) -> Fe {
        // a - k = a + (p - k) (mod p); p - k for small k is P with its lowest
        // limb lowered.
        let mut neg = P;
        neg[0] -= k;
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        for i in 0..4 {
            let sum = a[i] as u128 + neg[i] as u128 + carry;
            out[i] = sum as u64;
            carry = sum >> 64;
        }
        canonical(out)
    }
}

/// Reads the slot and per-slot counter of an Arcium computation queued by this
/// program. These are the bytes the cluster's output signature covers.
fn computation_identity(computation: &AccountInfo) -> Result<(u64, u16)> {
    require_keys_eq!(
        *computation.owner,
        ARCIUM_PROGRAM_ID,
        AuctionError::UnexpectedComputation
    );
    let data = computation.try_borrow_data()?;
    require!(
        data.len() >= COMPUTATION_SLOT_COUNTER_OFFSET + 2
            && data[..8] == *ComputationAccount::DISCRIMINATOR,
        AuctionError::UnexpectedComputation
    );
    require!(
        data[COMPUTATION_MXE_PROGRAM_OFFSET..COMPUTATION_MXE_PROGRAM_OFFSET + 32]
            == crate::ID.to_bytes(),
        AuctionError::UnexpectedComputation
    );
    let mut slot = [0u8; 8];
    slot.copy_from_slice(&data[COMPUTATION_SLOT_OFFSET..COMPUTATION_SLOT_OFFSET + 8]);
    let mut counter = [0u8; 2];
    counter.copy_from_slice(
        &data[COMPUTATION_SLOT_COUNTER_OFFSET..COMPUTATION_SLOT_COUNTER_OFFSET + 2],
    );
    Ok((u64::from_le_bytes(slot), u16::from_le_bytes(counter)))
}

/// A callback must come from the computation queued last: same account and
/// same slot and counter as recorded when it was queued. The address alone is
/// not enough, because a closed computation account can be re-created at the
/// same address for a different computation.
fn check_callback_computation(
    computation: &AccountInfo,
    pending: &Pubkey,
    pending_slot: u64,
    pending_slot_counter: u16,
) -> Result<()> {
    require_keys_eq!(
        computation.key(),
        *pending,
        AuctionError::UnexpectedComputation
    );
    let (slot, counter) = computation_identity(computation)?;
    require!(
        slot == pending_slot && counter == pending_slot_counter,
        AuctionError::UnexpectedComputation
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers: clearing and settlement
// ---------------------------------------------------------------------------

/// Checks the result of `clear_price` against the auction and returns whether
/// demand covered the supply (the price reached the minimum). These always
/// hold for an honest cluster; anything else fails loudly instead of paying
/// out.
///
/// The price `p` is the highest at which demand covers the supply, so demand
/// at `p` (the weight above plus at it) covers it and demand just above
/// (the weight above alone) does not, unless `p` is the largest price there
/// is. When demand never covered the supply at the minimum price, the weight
/// above is all the valid demand and falls short of it there.
pub fn clearing_is_consistent(
    auction: &Auction,
    price: u32,
    weight_above: u128,
    weight_at: u128,
) -> Result<bool> {
    let filled = price >= auction.min_price;
    let supply = auction.supply as u128;
    let consistent = match auction.kind {
        AuctionKind::Collection => {
            if filled {
                weight_above < supply
                    && weight_above.checked_add(weight_at).ok_or(AuctionError::InvalidClearing)? >= supply
            } else {
                weight_above < supply
            }
        }
        AuctionKind::Token => {
            let unit = auction.price_unit as u128;
            let budget_cost = |weight: u128| weight.checked_mul(unit).ok_or(AuctionError::InvalidClearing);
            if filled {
                let at_or_above = weight_above.checked_add(weight_at).ok_or(AuctionError::InvalidClearing)?;
                budget_cost(at_or_above)? >= supply * price as u128
                    && (price == u32::MAX || budget_cost(weight_above)? < supply * (price as u128 + 1))
            } else {
                budget_cost(weight_above)? < supply * auction.min_price as u128
            }
        }
    };
    require!(consistent, AuctionError::InvalidClearing);
    Ok(filled)
}

/// Base units `budget` lamports buy at `price` lamports per `unit`.
fn affordable(budget: u64, unit: u64, price: u32) -> u128 {
    budget as u128 * unit as u128 / price as u128
}

/// What a token bid with `budget` lamports receives for its outcome, in base
/// units, and what it pays, in lamports. Every winner pays the clearing
/// price, rounded up to a whole lamport and never more than its budget.
///
/// - Without a fill, every valid bid buys all its budget affords at the
///   minimum price; together they cannot exceed the supply.
/// - With a fill, a bid above the clearing price buys all its budget affords,
///   unless the bids above alone could already buy the whole supply (the
///   price sits just below the next bid); then they share the supply in
///   proportion to their budgets.
/// - A bid at the clearing price shares what the bids above left, in
///   proportion to its budget, up to what its budget affords.
///
/// Shares are rounded down; the base units lost to rounding stay unsold and
/// go back to the seller.
pub fn token_award(auction: &Auction, outcome: u8, budget: u64) -> Result<(u64, u64)> {
    let price = auction.clearing_price;
    let unit = auction.price_unit;
    require!(price > 0 && unit > 0, AuctionError::InvalidAllocation);
    let supply = auction.supply as u128;
    let above_cost = auction
        .weight_above
        .checked_mul(unit as u128)
        .ok_or(AuctionError::InvalidAllocation)?;
    let above_take_all = above_cost >= supply * price as u128;
    let won: u128 = match outcome {
        OUTCOME_NONE => 0,
        OUTCOME_ABOVE if !auction.filled || !above_take_all => affordable(budget, unit, price),
        OUTCOME_ABOVE => {
            require!(
                auction.weight_above >= budget as u128 && budget > 0,
                AuctionError::InvalidAllocation
            );
            supply * budget as u128 / auction.weight_above
        }
        OUTCOME_AT => {
            require!(
                auction.filled && auction.weight_at >= budget as u128 && budget > 0,
                AuctionError::InvalidAllocation
            );
            if above_take_all {
                0
            } else {
                let left = supply - above_cost / price as u128;
                (left * budget as u128 / auction.weight_at).min(affordable(budget, unit, price))
            }
        }
        _ => return err!(AuctionError::InvalidAllocation),
    };
    let won = u64::try_from(won).map_err(|_| AuctionError::Oversold)?;
    require!(won <= auction.supply, AuctionError::Oversold);
    let cost = (won as u128 * price as u128).div_ceil(unit as u128);
    let payment = u64::try_from(cost.min(budget as u128)).map_err(|_| AuctionError::MathOverflow)?;
    Ok((won, payment))
}

/// NFTs a collection bid that is not at the clearing price receives: nothing
/// for a losing bid, everything it asked for otherwise.
pub fn collection_fill(auction: &Auction, outcome: u8, quantity: u64) -> Result<u64> {
    match outcome {
        OUTCOME_NONE => {
            require!(quantity == 0, AuctionError::InvalidAllocation);
            Ok(0)
        }
        OUTCOME_ABOVE => {
            require!(
                quantity > 0 && quantity <= auction.max_per_bid as u64 && quantity <= auction.supply,
                AuctionError::InvalidAllocation
            );
            Ok(quantity)
        }
        _ => err!(AuctionError::InvalidAllocation),
    }
}

/// What `nfts` cost at the clearing price, in lamports.
pub fn nft_payment(auction: &Auction, nfts: u64) -> Result<u64> {
    nfts.checked_mul(auction.clearing_price as u64)
        .and_then(|cost| cost.checked_mul(auction.price_scale))
        .ok_or_else(|| AuctionError::MathOverflow.into())
}

/// NFTs left for the bids at the clearing price once the bids above it have
/// what they asked for.
pub fn clearing_remainder(auction: &Auction) -> Result<u64> {
    let above = u64::try_from(auction.weight_above).map_err(|_| AuctionError::InvalidAllocation)?;
    Ok(auction
        .supply
        .checked_sub(above)
        .ok_or(AuctionError::InvalidAllocation)?)
}

/// Adds a collection bid revealed at the clearing price to the running total.
/// Once every such bid is known their shares add up to exactly the NFTs the
/// bids above them left, so from then on those NFTs count as sold.
pub fn record_clearing_quantity(auction: &mut Auction, quantity: u64) -> Result<()> {
    require!(
        auction.filled && quantity > 0 && quantity <= auction.max_per_bid as u64,
        AuctionError::InvalidAllocation
    );
    let revealed = auction
        .at_revealed
        .checked_add(quantity as u128)
        .ok_or(AuctionError::MathOverflow)?;
    require!(revealed <= auction.weight_at, AuctionError::InvalidAllocation);
    auction.at_revealed = revealed;
    if revealed == auction.weight_at {
        let remaining = clearing_remainder(auction)?;
        auction.sold = auction
            .sold
            .checked_add(remaining)
            .ok_or(AuctionError::MathOverflow)?;
        require!(auction.sold <= auction.supply, AuctionError::Oversold);
    }
    Ok(())
}

/// True once every collection bid at the clearing price has been revealed,
/// so their shares are fixed. The seller may already have been paid by then:
/// the shares were counted as sold.
pub fn shares_are_final(auction: &Auction) -> bool {
    auction.kind == AuctionKind::Collection
        && matches!(
            auction.status,
            AuctionStatus::Settling | AuctionStatus::Finished
        )
        && auction.filled
        && auction.weight_at > 0
        && auction.at_revealed == auction.weight_at
}

/// Share of the bid at `index` among the bids at the clearing price, whose
/// sizes `sizes` holds by bid index (0 for every other bid). `remaining` NFTs
/// are left after the bids above the clearing price and `total` is the
/// demand at it, so `0 < remaining <= total`.
///
/// Each bid first gets `floor(size * remaining / total)`. That leaves fewer
/// NFTs than there are bids at the price, and they go one each to the bids
/// with the lowest indices, so the shares add up to `remaining` and no share
/// exceeds its bid. Without this, a small sale (one NFT per bid, say) could
/// leave most of its NFTs unsold.
pub fn clearing_share(
    sizes: &[u32],
    index: u32,
    remaining: u64,
    total: u64,
) -> Result<u64> {
    let own = *sizes.get(index as usize).ok_or(AuctionError::NotAtClearing)? as u64;
    require!(own > 0, AuctionError::NotAtClearing);
    require!(
        remaining > 0 && remaining <= total,
        AuctionError::InvalidAllocation
    );
    // Sizes are at most MAX_COLLECTION_SIZE, so no product here comes near
    // u64's limit.
    let mut sum = 0u64;
    let mut floors = 0u64;
    let mut earlier = 0u64;
    for (j, &size) in sizes.iter().enumerate() {
        if size == 0 {
            continue;
        }
        let size = size as u64;
        sum = sum.checked_add(size).ok_or(AuctionError::MathOverflow)?;
        let floor = size
            .checked_mul(remaining)
            .ok_or(AuctionError::MathOverflow)?
            / total;
        floors = floors.checked_add(floor).ok_or(AuctionError::MathOverflow)?;
        if (j as u32) < index {
            earlier += 1;
        }
    }
    require!(sum == total, AuctionError::SharesNotReady);
    let leftover = remaining
        .checked_sub(floors)
        .ok_or(AuctionError::InvalidAllocation)?;
    let share = own * remaining / total + u64::from(earlier < leftover);
    require!(share <= own, AuctionError::InvalidAllocation);
    Ok(share)
}

/// Last step of settling a bid: moves `payment` from the bid's deposit to
/// the auction and records what the bid won. The rest of the deposit stays in
/// the bid account until `close_bid` returns it, and the tokens or NFTs wait
/// for `claim_tokens` or `claim_nfts`.
fn settle_payment<'info>(
    auction: &mut Account<'info, Auction>,
    bid: &mut Account<'info, Bid>,
    outcome: u8,
    won: u64,
    payment: u64,
) -> Result<()> {
    require!(payment <= bid.deposit, AuctionError::Underfunded);
    let refund = bid.deposit - payment;
    move_lamports(&bid.to_account_info(), &auction.to_account_info(), payment)?;

    auction.proceeds = auction
        .proceeds
        .checked_add(payment)
        .ok_or(AuctionError::MathOverflow)?;
    auction.resolved_count = auction
        .resolved_count
        .checked_add(1)
        .ok_or(AuctionError::MathOverflow)?;
    // A winning collection bid takes the next places in settlement order.
    // Which NFTs they become is only decided by the seed drawn after every
    // bid is settled (`draw_nft_seed`).
    if auction.kind == AuctionKind::Collection && won > 0 {
        let count = u32::try_from(won).map_err(|_| AuctionError::MathOverflow)?;
        bid.first_position = auction.assigned_positions;
        auction.assigned_positions = auction
            .assigned_positions
            .checked_add(count)
            .ok_or(AuctionError::MathOverflow)?;
        require!(
            auction.assigned_positions as u64 <= auction.sold,
            AuctionError::Oversold
        );
    }
    bid.status = BidStatus::Settled;
    bid.outcome = outcome;
    bid.won = won;
    bid.payment = payment;
    bid.pending_computation = Pubkey::default();
    bid.pending_since = 0;
    emit!(BidSettled {
        auction: auction.key(),
        bid: bid.key(),
        bidder: bid.bidder,
        outcome,
        won,
        payment,
        refund,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers: opening auctions and fees
// ---------------------------------------------------------------------------

/// Checks a requested start and a duration, and returns when bidding starts
/// and ends. A start of 0, or any time not after `now`, means right away.
fn bidding_window(start_time: i64, duration_secs: i64, now: i64) -> Result<(i64, i64)> {
    require!(
        (MIN_DURATION_SECS..=MAX_DURATION_SECS).contains(&duration_secs),
        AuctionError::InvalidDuration
    );
    let start = start_time.max(now);
    require!(
        start - now <= MAX_START_DELAY_SECS,
        AuctionError::InvalidStartTime
    );
    let end = start
        .checked_add(duration_secs)
        .ok_or(AuctionError::MathOverflow)?;
    Ok((start, end))
}

impl TokenSaleTerms {
    fn check(&self, now: i64) -> Result<(i64, i64)> {
        require!(self.supply > 0, AuctionError::InvalidSupply);
        let mut unit = 1u64;
        while unit < self.price_unit && unit < MAX_PRICE_UNIT {
            unit *= 10;
        }
        require!(unit == self.price_unit, AuctionError::InvalidPriceUnit);
        require!(self.min_price > 0, AuctionError::InvalidPrice);
        require!(self.min_deposit > 0, AuctionError::InvalidMinDeposit);
        bidding_window(self.start_time, self.duration_secs, now)
    }
}

impl CollectionSaleTerms {
    fn check(&self, now: i64) -> Result<(i64, i64)> {
        require!(
            self.supply > 0 && self.supply <= MAX_COLLECTION_SIZE,
            AuctionError::InvalidSupply
        );
        require!(self.min_price > 0, AuctionError::InvalidPrice);
        require!(
            self.max_per_bid >= 1 && self.max_per_bid as u64 <= self.supply,
            AuctionError::InvalidMaxPerBid
        );
        bidding_window(self.start_time, self.duration_secs, now)
    }
}

impl CollectionTerms {
    fn check(&self) -> Result<()> {
        require!(
            is_display_text(&self.name, MAX_COLLECTION_NAME_LEN)
                && is_display_text(&self.item_name, MAX_ITEM_NAME_LEN)
                && is_metadata_uri(&self.uri)
                && is_metadata_uri(&self.item_uri)
                && self.royalty_bps <= MAX_ROYALTY_BPS,
            AuctionError::InvalidCollectionTerms
        );
        Ok(())
    }
}

/// Control characters, and invisible or text-direction characters that
/// could disguise a name in wallets and explorers.
fn is_hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2069}' | '\u{feff}'
        )
}

/// Non-blank text of at most `max_len` bytes without hidden characters.
pub fn is_display_text(text: &str, max_len: usize) -> bool {
    !text.trim().is_empty() && text.len() <= max_len && !text.chars().any(is_hidden_char)
}

/// An `https://`, `ipfs://` or `ar://` link of at most `MAX_URI_LEN` bytes
/// without spaces or hidden characters.
pub fn is_metadata_uri(uri: &str) -> bool {
    uri.len() <= MAX_URI_LEN
        && ["https://", "ipfs://", "ar://"]
            .iter()
            .any(|scheme| uri.len() > scheme.len() && uri.starts_with(scheme))
        && !uri.chars().any(|c| c.is_whitespace() || is_hidden_char(c))
}

/// A newly opened auction without its sale terms, which the caller fills in.
#[allow(clippy::too_many_arguments)]
fn new_auction(
    kind: AuctionKind,
    seed: u64,
    seller: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
    start_time: i64,
    end_time: i64,
    [bump, book_bump]: [u8; 2],
    fees: &FeeConfig,
    crank_rewards: CrankRewards,
) -> Auction {
    Auction {
        seed,
        seller,
        kind,
        mint,
        token_program,
        supply: 0,
        price_unit: 1,
        price_scale: 1,
        min_price: 0,
        min_deposit: 0,
        max_per_bid: 0,
        start_time,
        end_time,
        status: AuctionStatus::Open,
        featured: false,
        hidden: false,
        bid_count: 0,
        checked_count: 0,
        resolved_count: 0,
        live_bids: 0,
        pending_computation: Pubkey::default(),
        pending_since: 0,
        pending_slot: 0,
        pending_slot_counter: 0,
        pending_batch: 0,
        clearing_price: 0,
        filled: false,
        weight_above: 0,
        weight_at: 0,
        at_revealed: 0,
        sold: 0,
        delivered: 0,
        proceeds: 0,
        total_deposited: 0,
        sale_fee_bps: fees.sale_fee_bps,
        treasury: fees.treasury,
        bump,
        book_bump,
        royalty_bps: 0,
        uri_per_item: false,
        item_name: String::new(),
        item_uri: String::new(),
        assigned_positions: 0,
        nft_seed: 0,
        seed_drawn: false,
        named_items: false,
        unrevealed: false,
        crank_rewards,
        crank_pool: 0,
        extra_pages: 0,
        page_bumps: [0; MAX_EXTRA_PAGES],
        liquidity: LIQUIDITY_NONE,
        liquidity_floor: 0,
    }
}

fn emit_auction_created(auction: &Account<Auction>, listing_fee: u64) {
    emit!(AuctionCreated {
        auction: auction.key(),
        kind: auction.kind,
        seed: auction.seed,
        seller: auction.seller,
        mint: auction.mint,
        supply: auction.supply,
        price_unit: auction.price_unit,
        price_scale: auction.price_scale,
        min_price: auction.min_price,
        min_deposit: auction.min_deposit,
        max_per_bid: auction.max_per_bid,
        start_time: auction.start_time,
        end_time: auction.end_time,
        listing_fee,
        crank_pool: auction.crank_pool,
        bid_crank_fee: bid_crank_fee(&auction.crank_rewards),
        sale_fee_bps: auction.sale_fee_bps,
    });
}

/// What each bid adds to the crank pool: its share of a batch check and its
/// own settlement.
pub fn bid_crank_fee(rewards: &CrankRewards) -> u64 {
    rewards
        .check_batch
        .div_ceil(BATCH_SIZE as u64)
        .saturating_add(rewards.settlement)
}

/// What the seller puts in the crank pool when the auction opens: the
/// clearing, one batch check (bids pay for their share of the others, so a
/// last, partial batch is covered) and, for a collection, the seed draw.
pub fn seller_crank_fee(auction: &Auction) -> u64 {
    let rewards = &auction.crank_rewards;
    let draw = if auction.kind == AuctionKind::Collection {
        rewards.seed_draw
    } else {
        0
    };
    rewards
        .clearing
        .saturating_add(rewards.check_batch)
        .saturating_add(draw)
}

/// Moves `amount` from `payer` into the auction's crank pool.
fn add_to_crank_pool<'info>(
    auction: &mut Account<'info, Auction>,
    payer: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(
            system_program.key(),
            system_program::Transfer {
                from: payer.clone(),
                to: auction.to_account_info(),
            },
        ),
        amount,
    )?;
    auction.crank_pool = auction
        .crank_pool
        .checked_add(amount)
        .ok_or(AuctionError::MathOverflow)?;
    Ok(())
}

fn fund_crank_pool<'info>(
    auction: &mut Account<'info, Auction>,
    seller: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    let amount = seller_crank_fee(auction);
    add_to_crank_pool(auction, seller, system_program, amount)
}

/// Pays whoever queued a computation that succeeded its reward, as far as
/// the crank pool reaches. The pool sits in the auction account on top of its
/// rent and proceeds, so paying from it never touches anyone else's funds.
fn pay_cranker<'info>(
    auction: &mut Account<'info, Auction>,
    cranker: &AccountInfo<'info>,
    reward: u64,
) -> Result<()> {
    let amount = reward.min(auction.crank_pool);
    if amount == 0 || cranker.key() == auction.key() {
        return Ok(());
    }
    auction.crank_pool -= amount;
    auction.to_account_info().sub_lamports(amount)?;
    cranker.add_lamports(amount)?;
    emit!(CrankPaid {
        auction: auction.key(),
        cranker: cranker.key(),
        amount,
    });
    Ok(())
}

/// Charges the listing fee, provided the seller accepted the current fees,
/// and returns what was paid.
fn charge_listing_fee<'info>(
    fees: &FeeConfig,
    accepted: &FeeTerms,
    seller: &AccountInfo<'info>,
    treasury: &AccountInfo<'info>,
) -> Result<u64> {
    require!(
        fees.listing_fee <= accepted.listing_fee && fees.sale_fee_bps <= accepted.sale_fee_bps,
        AuctionError::FeesChanged
    );
    let fee = receivable_fee(treasury, fees.listing_fee)?;
    if fee > 0 {
        system_program::transfer(
            CpiContext::new(
                System::id(),
                system_program::Transfer {
                    from: seller.clone(),
                    to: treasury.clone(),
                },
            ),
            fee,
        )?;
    }
    Ok(fee)
}

/// `fee`, or nothing if the treasury could not accept it: a closed account
/// cannot receive less than the rent-exempt minimum. A misconfigured
/// treasury then costs the platform its fee instead of blocking sellers.
fn receivable_fee(treasury: &AccountInfo, fee: u64) -> Result<u64> {
    if fee == 0 {
        return Ok(0);
    }
    let after = treasury
        .lamports()
        .checked_add(fee)
        .ok_or(AuctionError::MathOverflow)?;
    Ok(if Rent::get()?.is_exempt(after, treasury.data_len()) {
        fee
    } else {
        0
    })
}

/// The platform's cut of `proceeds`, rounded down.
pub fn sale_fee(proceeds: u64, fee_bps: u16) -> u64 {
    // fee_bps <= 10_000 in practice (capped at MAX_SALE_FEE_BPS), so the
    // result never exceeds `proceeds` and fits in u64.
    (proceeds as u128 * fee_bps.min(BPS_DENOMINATOR as u16) as u128 / BPS_DENOMINATOR as u128) as u64
}

/// The seller may be paid once every bid is resolved, once an auction
/// without bids has ended, or once the safety net is open.
fn seller_can_claim(auction: &Auction, now: i64) -> Result<bool> {
    let emergency = !before_emergency(auction, now)?;
    let all_resolved =
        auction.status == AuctionStatus::Settling && auction.resolved_count == auction.bid_count;
    let ended_without_bids =
        auction.status == AuctionStatus::Open && auction.bid_count == 0 && now >= auction.end_time;
    let stalled = emergency
        && matches!(
            auction.status,
            AuctionStatus::Open | AuctionStatus::Settling
        );
    Ok(all_resolved || ended_without_bids || stalled)
}

/// Sends the auction's proceeds to the seller and the sale fee to the
/// treasury. Returns the proceeds and the fee taken from them.
fn pay_proceeds<'info>(
    auction: &Account<'info, Auction>,
    seller: &AccountInfo<'info>,
    treasury: &AccountInfo<'info>,
) -> Result<(u64, u64)> {
    let proceeds = auction.proceeds;
    let fee = receivable_fee(treasury, sale_fee(proceeds, auction.sale_fee_bps))?;
    let auction_info = auction.to_account_info();
    move_lamports(&auction_info, treasury, fee)?;
    move_lamports(&auction_info, seller, proceeds - fee)?;
    Ok((proceeds, fee))
}

// ---------------------------------------------------------------------------
// Helpers: Metaplex Core
// ---------------------------------------------------------------------------

/// Returns lamports that someone sent to a program-derived address before
/// the account was created there, so that creating it cannot fail. Only this
/// program can sign for the address, so lamports are all that can be there.
fn reclaim_prefunded<'info>(
    account: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    to: &AccountInfo<'info>,
) -> Result<()> {
    let lamports = account.lamports();
    if lamports == 0 {
        return Ok(());
    }
    require!(
        account.data_is_empty() && *account.owner == System::id(),
        AuctionError::WrongAssetAccounts
    );
    system_program::transfer(
        CpiContext::new_with_signer(
            System::id(),
            system_program::Transfer {
                from: account.clone(),
                to: to.clone(),
            },
            &[signer_seeds],
        ),
        lamports,
    )
}

/// Appends a Borsh string: a little-endian u32 length, then the bytes.
fn push_borsh_string(data: &mut Vec<u8>, text: &str) {
    data.extend_from_slice(&(text.len() as u32).to_le_bytes());
    data.extend_from_slice(text.as_bytes());
}

/// Data of Core's `CreateCollectionV1`. A non-zero royalty adds a Royalties
/// plugin paying everything to `creator`, with no rule set and its default
/// authority (the collection's update authority).
pub fn core_create_collection_data(
    name: &str,
    uri: &str,
    royalty_bps: u16,
    creator: &Pubkey,
) -> Vec<u8> {
    let mut data = vec![CORE_CREATE_COLLECTION_V1];
    push_borsh_string(&mut data, name);
    push_borsh_string(&mut data, uri);
    if royalty_bps == 0 {
        data.push(0); // plugins: None
    } else {
        data.push(1); // plugins: Some
        data.extend_from_slice(&1u32.to_le_bytes()); // one plugin
        data.push(0); // Plugin::Royalties
        data.extend_from_slice(&royalty_bps.to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes()); // one creator
        data.extend_from_slice(creator.as_ref());
        data.push(100); // with 100% of the royalties
        data.push(0); // RuleSet::None
        data.push(0); // authority: None, the plugin's default
    }
    data
}

/// Data of Core's `CreateV1` for an NFT stored in its account, without
/// plugins of its own.
pub fn core_create_asset_data(name: &str, uri: &str) -> Vec<u8> {
    let mut data = vec![CORE_CREATE_V1, 0]; // DataState::AccountState
    push_borsh_string(&mut data, name);
    push_borsh_string(&mut data, uri);
    data.push(0); // plugins: None
    data
}

/// Data of Core's `UpdateCollectionV1` that changes nothing but the update
/// authority, which is passed as an account.
pub fn core_update_collection_data() -> Vec<u8> {
    vec![CORE_UPDATE_COLLECTION_V1, 0, 0] // new_name: None, new_uri: None
}

/// Appends `value` in decimal.
fn push_decimal(out: &mut String, mut value: u32) {
    let mut digits = [0u8; 10];
    let mut start = digits.len();
    loop {
        start -= 1;
        digits[start] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    for &digit in &digits[start..] {
        out.push(digit as char);
    }
}

/// SplitMix64's finalizer: a fast 64-bit mixing function.
fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// 64 bits of the shuffle's randomness for one round: the round's pivot
/// (`salt = SHUFFLE_PIVOT_SALT`) or the coin flipped for a pair of places
/// (`salt` = the higher place of the pair).
fn shuffle_word(seed: u128, round: u32, salt: u32) -> u64 {
    let word = ((round as u64) << 32) | salt as u64;
    mix64(mix64(word ^ seed as u64) ^ (seed >> 64) as u64)
}

/// The NFT numbers (from 0) that `positions` become in a collection of
/// `supply` NFTs, through a swap-or-not shuffle keyed by `seed` (Hoang,
/// Morris and Rogaway; Ethereum shuffles its validators the same way). Each
/// round pairs every place `x` with `pivot - x` and swaps the pair on a coin
/// flip, so every place ends up with a different number, and one place can be
/// worked out without the others.
pub fn shuffled_items(positions: &[u32], supply: u32, seed: u128) -> Result<Vec<u32>> {
    require!(
        supply > 0 && positions.iter().all(|&position| position < supply),
        AuctionError::InvalidAllocation
    );
    let n = supply as u64;
    let mut items: Vec<u64> = positions.iter().map(|&position| position as u64).collect();
    for round in 0..SHUFFLE_ROUNDS {
        let pivot = shuffle_word(seed, round, SHUFFLE_PIVOT_SALT) % n;
        for item in items.iter_mut() {
            let flip = (pivot + n - *item) % n;
            let pair = (*item).max(flip) as u32;
            if shuffle_word(seed, round, pair) & 1 == 1 {
                *item = flip;
            }
        }
    }
    Ok(items.into_iter().map(|item| item as u32).collect())
}

/// Name of NFT `index` (from 0): `"{item_name} #{index + 1}"`.
pub fn nft_name(item_name: &str, index: u32) -> String {
    let mut name = String::with_capacity(item_name.len() + 7);
    name.push_str(item_name);
    name.push_str(" #");
    push_decimal(&mut name, index.saturating_add(1));
    name
}

/// Name of NFT `item` (from 0) of a collection named per item, from the
/// `count` entries of its item list (see `ItemList`): the name of the item
/// whose numbers cover `item`, followed by `" #{edition}"` when that item
/// has more than one NFT. Entries end in strictly increasing order, so a
/// binary search finds the item.
pub fn item_nft_name(entries: &[u8], count: u32, item: u32) -> Result<String> {
    let count = count as usize;
    require!(
        entries.len() >= count * ITEM_ENTRY_LEN,
        AuctionError::ItemListMismatch
    );
    let end_of = |k: usize| {
        let at = k * ITEM_ENTRY_LEN;
        u32::from_le_bytes([entries[at], entries[at + 1], entries[at + 2], entries[at + 3]])
    };
    let (mut low, mut high) = (0usize, count);
    while low < high {
        let middle = (low + high) / 2;
        if end_of(middle) > item {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    require!(low < count, AuctionError::InvalidAllocation);
    let start = if low == 0 { 0 } else { end_of(low - 1) };
    let at = low * ITEM_ENTRY_LEN;
    let length = entries[at + 4] as usize;
    require!(length <= MAX_ITEM_NAME_LEN, AuctionError::ItemListMismatch);
    let name = core::str::from_utf8(&entries[at + 5..at + 5 + length])
        .map_err(|_| AuctionError::ItemListMismatch)?;
    Ok(if end_of(low) - start == 1 {
        name.to_string()
    } else {
        nft_name(name, item - start)
    })
}

/// Metadata URI of NFT `index` (from 0): `"{item_uri}{index}.json"` when
/// each item has its own file, `item_uri` otherwise.
pub fn nft_uri(item_uri: &str, index: u32, per_item: bool) -> String {
    let mut uri = String::with_capacity(item_uri.len() + 10);
    uri.push_str(item_uri);
    if per_item {
        push_decimal(&mut uri, index);
        uri.push_str(".json");
    }
    uri
}

/// Rejects tokens whose supply can still change or that can be frozen, and
/// Token-2022 mints with any extension beyond on-chain metadata (transfer
/// fees, hooks, permanent delegates and the like could all hurt buyers).
fn check_mint_is_safe(mint: &InterfaceAccount<Mint>) -> Result<()> {
    require!(mint.mint_authority.is_none(), AuctionError::MintAuthorityActive);
    require!(
        mint.freeze_authority.is_none(),
        AuctionError::FreezeAuthorityActive
    );
    let info = mint.to_account_info();
    if *info.owner == spl_token_2022::ID {
        let data = info.try_borrow_data()?;
        let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;
        for extension in state.get_extension_types()? {
            require!(
                matches!(
                    extension,
                    ExtensionType::MetadataPointer | ExtensionType::TokenMetadata
                ),
                AuctionError::UnsupportedExtension
            );
        }
    }
    Ok(())
}

/// Common checks for `check_batch`; returns how many bids this batch takes.
fn check_allowed(auction: &Auction, now: i64) -> Result<usize> {
    require!(
        auction.status == AuctionStatus::Open,
        AuctionError::WrongStatus
    );
    require!(now >= auction.end_time, AuctionError::BiddingOpen);
    require!(before_emergency(auction, now)?, AuctionError::EmergencyActive);
    require!(
        auction.checked_count < auction.bid_count,
        AuctionError::NothingToCheck
    );
    ensure_idle(&auction.pending_computation, auction.pending_since, now)?;
    let remaining = (auction.bid_count - auction.checked_count) as usize;
    Ok(remaining.min(BATCH_SIZE))
}

/// Loads the next `count` bids, checking that they belong to this auction and
/// come in index order starting at `checked_count`, so each bid is checked
/// exactly once.
fn load_batch<'info>(
    auction: &Account<'info, Auction>,
    remaining: &'info [AccountInfo<'info>],
    count: usize,
) -> Result<Vec<Account<'info, Bid>>> {
    require!(remaining.len() == count, AuctionError::WrongBidAccounts);
    let mut bids = Vec::with_capacity(count);
    for (k, info) in remaining.iter().enumerate() {
        let bid = Account::<Bid>::try_from(info)?;
        require_keys_eq!(bid.auction, auction.key(), AuctionError::WrongBidAccounts);
        require!(
            bid.index == auction.checked_count + k as u32,
            AuctionError::WrongBidAccounts
        );
        bids.push(bid);
    }
    Ok(bids)
}

/// Appends `BATCH_SIZE` bid slots. Unused slots repeat the first bid with a
/// zero deposit; the circuit ignores them because of `active_count`.
/// The smallest budget a bid may name: the minimum deposit of a token
/// auction. Collection bids have no budget.
fn min_budget(auction: &Auction) -> u64 {
    match auction.kind {
        AuctionKind::Token => auction.min_deposit,
        AuctionKind::Collection => 0,
    }
}

// ---------------------------------------------------------------------------
// Helpers: pages of the bid book and the paged clearing
// ---------------------------------------------------------------------------

/// Bids the auction can hold: `PAGE_BIDS` per page of its book.
pub fn bid_capacity(auction: &Auction) -> u32 {
    PAGE_BIDS * (1 + auction.extra_pages as u32)
}

/// The page of the bid book that holds bid `index`, and its slot there.
pub fn page_slot(index: u32) -> (u8, usize) {
    (
        (index / PAGE_BIDS) as u8,
        (index % PAGE_BIDS) as usize,
    )
}

/// Pages of the book that hold bids (at least one).
pub fn pages_in_use(auction: &Auction) -> u8 {
    auction.bid_count.div_ceil(PAGE_BIDS).max(1) as u8
}

/// Batch records in `page` that hold bids, of an auction with `bid_count`
/// bids.
pub fn page_active_batches(bid_count: u32, page: u8) -> u8 {
    let before = page as u32 * PAGE_BIDS;
    let on_page = bid_count.saturating_sub(before).min(PAGE_BIDS);
    on_page.div_ceil(BATCH_SIZE as u32) as u8
}

/// Address of page `page` of the auction's book: `[BOOK_SEED, auction]` for
/// the first, `[BOOK_SEED, auction, [page]]` for the others.
fn page_address(auction: &Account<Auction>, page: u8) -> Result<Pubkey> {
    let key = auction.key();
    let address = if page == 0 {
        Pubkey::create_program_address(&[BOOK_SEED, key.as_ref(), &[auction.book_bump]], &crate::ID)
    } else {
        require!(page <= auction.extra_pages, AuctionError::WrongBookPage);
        Pubkey::create_program_address(
            &[BOOK_SEED, key.as_ref(), &[page], &[auction.page_bumps[page as usize - 1]]],
            &crate::ID,
        )
    };
    address.map_err(|_| AuctionError::WrongBookPage.into())
}

/// The auction's pages after the first, which must be passed in order as
/// `remaining` (and nothing else).
fn extra_pages<'info>(
    auction: &Account<'info, Auction>,
    remaining: &'info [AccountInfo<'info>],
) -> Result<Vec<AccountLoader<'info, BidBook>>> {
    require!(
        remaining.len() == auction.extra_pages as usize,
        AuctionError::WrongBookPage
    );
    remaining
        .iter()
        .enumerate()
        .map(|(k, info)| {
            require_keys_eq!(
                info.key(),
                page_address(auction, k as u8 + 1)?,
                AuctionError::WrongBookPage
            );
            AccountLoader::<BidBook>::try_from(info)
        })
        .collect()
}

fn page_of<'a, 'info>(
    first: &'a AccountLoader<'info, BidBook>,
    extra: &'a [AccountLoader<'info, BidBook>],
    page: u8,
) -> &'a AccountLoader<'info, BidBook> {
    if page == 0 {
        first
    } else {
        &extra[page as usize - 1]
    }
}

/// Closes the auction's further pages, passed in order as `remaining`, and
/// requires its `ClearingFold` to be closing too (`has_fold`) when it has
/// any; the rent goes to the seller.
fn close_extra_pages<'info>(
    auction: &Account<'info, Auction>,
    remaining: &'info [AccountInfo<'info>],
    has_fold: bool,
    seller: &AccountInfo<'info>,
) -> Result<()> {
    require!(
        auction.extra_pages == 0 || has_fold,
        AuctionError::WrongBookPage
    );
    for page in extra_pages(auction, remaining)? {
        page.close(seller.clone())?;
    }
    Ok(())
}

/// What one `fold_batch` step pays its caller.
pub fn fold_reward(rewards: &CrankRewards) -> u64 {
    rewards.clearing.saturating_mul(FOLD_REWARD_PERCENT) / 100
}

/// Steps of the paged clearing over `pages` pages.
pub fn fold_total_steps(pages: u8) -> u16 {
    FOLD_PASSES as u16 * (pages.max(1) as u16 - 1) + 1
}

/// What the seller adds to the crank pool with page `page` (from 1): the
/// fold steps it adds. Two pages take `FOLD_PASSES + 1` steps (one page needs
/// none: `clear_price` does it in one, from the seller's opening fee) and
/// each further page `FOLD_PASSES` more.
pub fn page_crank_fee(rewards: &CrankRewards, page: u8) -> u64 {
    let before = if page <= 1 { 0 } else { fold_total_steps(page) };
    let steps = fold_total_steps(page + 1) - before;
    fold_reward(rewards).saturating_mul(steps as u64)
}

/// The flags of the next `fold_batch` step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FoldStep {
    /// The very first step: there is no state yet.
    pub fresh: bool,
    /// This page ends its pass: the step fixes the pass's digit.
    pub decide: bool,
    pub last_pass: bool,
    /// Place of the pass's digit: the lowest of its four bits.
    pub shift: u8,
}

/// Even passes visit the pages forwards and odd passes backwards, so the
/// page that ends one pass starts the next.
pub fn fold_step(fold: &ClearingFold, pages: u8) -> FoldStep {
    let end = if fold.pass % 2 == 0 { pages - 1 } else { 0 };
    FoldStep {
        fresh: fold.steps == 0,
        decide: fold.page == end,
        last_pass: fold.pass + 1 == FOLD_PASSES,
        shift: (FOLD_PASSES - 1 - fold.pass.min(FOLD_PASSES - 1)) * FOLD_DIGIT_BITS,
    }
}

/// The page after `page` in pass `pass`. A step that ends a pass has also
/// done the next pass's first page, the same page, so this applies after
/// moving to the next pass too.
pub fn next_fold_page(pass: u8, page: u8) -> u8 {
    if pass % 2 == 0 {
        page + 1
    } else {
        page - 1
    }
}

/// Records a revealed clearing: checks it, sets the price, and moves the
/// auction on to settling.
fn apply_clearing(
    auction: &mut Account<Auction>,
    price: u32,
    weight_above: u128,
    weight_at: u128,
) -> Result<()> {
    // Sanity checks on what MPC revealed; these always hold for an honest
    // cluster and make a broken result fail loudly instead of paying out.
    let filled = clearing_is_consistent(auction, price, weight_above, weight_at)?;
    auction.clearing_price = if filled { price } else { auction.min_price };
    auction.filled = filled;
    auction.weight_above = weight_above;
    auction.weight_at = if filled { weight_at } else { 0 };
    auction.status = AuctionStatus::Settling;
    if auction.liquidity == LIQUIDITY_PLANNED {
        let expected_net = expected_net_proceeds(auction);
        if expected_net < auction.liquidity_floor {
            // The pool could not get its floor: the sale fails and every bid
            // is refunded (`refund_failed_bid`).
            auction.liquidity = LIQUIDITY_FAILED;
            emit!(LiquidityFloorMissed {
                auction: auction.key(),
                expected_net,
                floor: auction.liquidity_floor,
            });
        }
    }
    emit!(AuctionCleared {
        auction: auction.key(),
        clearing_price: auction.clearing_price,
        filled,
        weight_above,
        weight_at: auction.weight_at,
    });
    Ok(())
}

fn push_bid_batch(mut builder: ArgBuilder, bids: &[Account<Bid>], count: usize) -> ArgBuilder {
    for k in 0..BATCH_SIZE {
        let (bid, deposit) = if k < count {
            (&bids[k], bids[k].deposit)
        } else {
            (&bids[0], 0)
        };
        builder = builder
            .x25519_pubkey(bid.client_pubkey)
            .plaintext_u128(bid.nonce)
            .account(bid.key(), BID_CIPHERTEXT_OFFSET, BID_CIPHERTEXT_LEN)
            .plaintext_u64(deposit);
    }
    builder
}

/// The arguments of `clear_price`: every batch record of the first page,
/// read in place from the bid book, then the public terms. Records past the
/// last bid are empty; the circuit ignores them.
///
/// Built directly rather than with `ArgBuilder`, whose vectors grow by
/// doubling: on Solana's bump allocator every outgrown buffer stays
/// allocated, and these arguments are large enough for that to matter.
fn clearing_arguments(
    batch_nonces: &[[u8; 16]; PAGE_BATCHES],
    book_key: Pubkey,
    active_batches: u8,
    is_token: bool,
    price_unit: u64,
    supply: u64,
) -> ArgumentList {
    let mut list = PageArguments::new(0, 4, 2);
    list.push_records(batch_nonces, book_key);
    list.args.push(ArgumentRef::PlaintextU8(active_batches));
    list.args.push(ArgumentRef::PlaintextBool(is_token));
    list.push_u64(price_unit);
    list.push_u64(supply);
    list.finish()
}

/// The arguments of one `fold_batch` step: the carried state, read in place
/// from the `ClearingFold`, the page's batch records, read in place from the
/// book, then the step and the public terms, in the circuit's order.
fn fold_arguments(
    fold: &ClearingFold,
    fold_key: Pubkey,
    batch_nonces: &[[u8; 16]; PAGE_BATCHES],
    book_key: Pubkey,
    active_batches: u8,
    step: FoldStep,
    auction: &Auction,
) -> ArgumentList {
    let mut list = PageArguments::new(1, 10, 4);
    list.push_mxe(fold.state_nonce, fold_key, FOLD_STATE_OFFSET, FOLD_STATE_LEN);
    list.push_records(batch_nonces, book_key);
    list.args.push(ArgumentRef::PlaintextU8(active_batches));
    list.args.push(ArgumentRef::PlaintextBool(step.fresh));
    list.args.push(ArgumentRef::PlaintextBool(step.decide));
    list.args.push(ArgumentRef::PlaintextBool(step.last_pass));
    list.push_u64(fold.prefix as u64);
    list.args.push(ArgumentRef::PlaintextU8(step.shift));
    list.push_u64(1u64 << step.shift);
    list.args.push(ArgumentRef::PlaintextBool(auction.kind == AuctionKind::Token));
    list.push_u64(auction.price_unit);
    list.push_u64(auction.supply);
    list.finish()
}

/// An `ArgumentList` sized up front for a page's records plus `extra_mxe`
/// more MXE-encrypted values and the plaintext arguments.
struct PageArguments {
    args: Vec<ArgumentRef>,
    values: Vec<u128>,
    numbers: Vec<u64>,
    accounts: Vec<AccountArgument>,
}

impl PageArguments {
    /// Room for `plain` plaintext arguments, `numbers` of them u64s.
    fn new(extra_mxe: usize, plain: usize, numbers: usize) -> Self {
        // An argument reference holds a u8 index into its collection.
        const _: () = assert!(PAGE_BATCHES + 1 <= 256);
        let encrypted = PAGE_BATCHES + extra_mxe;
        PageArguments {
            args: Vec::with_capacity(2 * encrypted + plain),
            values: Vec::with_capacity(encrypted),
            numbers: Vec::with_capacity(numbers),
            accounts: Vec::with_capacity(encrypted),
        }
    }

    /// An `Enc<Mxe, _>` argument: its nonce, then its ciphertexts read in
    /// place.
    fn push_mxe(&mut self, nonce: u128, pubkey: Pubkey, offset: u32, length: u32) {
        self.args.push(ArgumentRef::PlaintextU128(self.values.len() as u8));
        self.values.push(nonce);
        self.args.push(ArgumentRef::Account(self.accounts.len() as u8));
        self.accounts.push(AccountArgument {
            pubkey,
            offset,
            length,
        });
    }

    fn push_records(&mut self, batch_nonces: &[[u8; 16]; PAGE_BATCHES], book_key: Pubkey) {
        for (batch, nonce) in batch_nonces.iter().enumerate() {
            self.push_mxe(
                u128::from_le_bytes(*nonce),
                book_key,
                BATCH_RECORDS_OFFSET + BATCH_RECORD_LEN * batch as u32,
                BATCH_RECORD_LEN,
            );
        }
    }

    fn push_u64(&mut self, value: u64) {
        self.args.push(ArgumentRef::PlaintextU64(self.numbers.len() as u8));
        self.numbers.push(value);
    }

    fn finish(self) -> ArgumentList {
        ArgumentList {
            args: self.args,
            byte_arrays: Vec::new(),
            plaintext_numbers: self.numbers,
            values_128_bit: self.values,
            accounts: self.accounts,
        }
    }
}

/// Where Arcium's signer account keeps its bump (after the discriminator).
const SIGNER_ACCOUNT_BUMP_OFFSET: usize = 8;

/// `arcium_anchor::queue_computation` with one callback transaction and no
/// priority fee, except that the instruction data of the call into Arcium is
/// allocated at its exact size. The library grows it from 256 bytes by
/// doubling; with `clear_price`'s 6 KB of arguments, the buffers left behind
/// on the bump allocator would take half of the 32 KB heap.
fn queue_computation_exact<'info, T: QueueCompAccs<'info>>(
    accs: &T,
    computation_offset: u64,
    args: ArgumentList,
    callback: CallbackInstruction,
) -> Result<()> {
    let bump = accs.signer_pda_bump();
    let signer_seeds: &[&[&[u8]]] = &[&[SIGN_PDA_SEED, &[bump]]];
    let accounts = accs.queue_comp_accs();
    accounts.sign_seed.try_borrow_mut_data()?[SIGNER_ACCOUNT_BUMP_OFFSET] = bump;
    let call = QueueComputationArgs {
        comp_offset: computation_offset,
        computation_definition_offset: accs.comp_def_offset(),
        args,
        mxe_program: accs.mxe_program(),
        custom_callback_instructions: vec![callback],
        callback_transactions_required: 1,
        callback_cu_limit: CALLBACK_CU_LIMIT,
        padding: 0,
        cu_price_micro: 0,
    };
    let len = QueueComputationArgs::DISCRIMINATOR.len()
        + borsh::object_length(&call).map_err(|_| ErrorCode::InstructionDidNotSerialize)?;
    let mut data = Vec::with_capacity(len);
    data.extend_from_slice(QueueComputationArgs::DISCRIMINATOR);
    call.serialize(&mut data)
        .map_err(|_| ErrorCode::InstructionDidNotSerialize)?;
    let instruction = Instruction {
        program_id: accs.arcium_program(),
        accounts: accounts.to_account_metas(None),
        data,
    };
    invoke_signed(&instruction, &accounts.to_account_infos(), signer_seeds)?;
    Ok(())
}

fn clear_auction_pending(auction: &mut Account<Auction>) {
    auction.pending_computation = Pubkey::default();
    auction.pending_since = 0;
    auction.pending_batch = 0;
}

/// True until the safety net opens for this auction.
fn before_emergency(auction: &Auction, now: i64) -> Result<bool> {
    let opens_at = auction
        .end_time
        .checked_add(EMERGENCY_DELAY_SECS)
        .ok_or(AuctionError::MathOverflow)?;
    Ok(now < opens_at)
}

/// True until the time to reveal a hidden collection runs out.
fn before_reveal_deadline(auction: &Auction, now: i64) -> Result<bool> {
    let closes_at = auction
        .end_time
        .checked_add(REVEAL_DELAY_SECS)
        .ok_or(AuctionError::MathOverflow)?;
    Ok(now < closes_at)
}

/// Allows a new computation unless one is still plausibly in flight.
fn ensure_idle(pending: &Pubkey, since: i64, now: i64) -> Result<()> {
    require!(
        *pending == Pubkey::default() || now >= since.saturating_add(PENDING_TIMEOUT_SECS),
        AuctionError::ComputationInFlight
    );
    Ok(())
}

/// Moves lamports out of an account owned by this program.
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let from_balance = from.lamports();
    let to_balance = to.lamports();
    **from.try_borrow_mut_lamports()? = from_balance
        .checked_sub(amount)
        .ok_or(AuctionError::MathOverflow)?;
    **to.try_borrow_mut_lamports()? = to_balance
        .checked_add(amount)
        .ok_or(AuctionError::MathOverflow)?;
    Ok(())
}

/// Sends `amount` tokens from the vault to the seller and, when nothing is
/// owed to winners any more (`close`), closes the vault with its rent going to
/// the seller.
fn pay_out_vault(ctx: &Context<SellerWithdraw>, amount: u64, close: bool) -> Result<()> {
    let auction = &ctx.accounts.auction;
    let seed_bytes = auction.seed.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        AUCTION_SEED,
        auction.seller.as_ref(),
        &seed_bytes,
        &[auction.bump],
    ]];
    if amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.seller_token_account.to_account_info(),
                    authority: ctx.accounts.auction.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
    }
    if close {
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.seller.to_account_info(),
                authority: ctx.accounts.auction.to_account_info(),
            },
            signer_seeds,
        ))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    pub bump: u8,
}

/// Platform fees for auctions opened from now on (`[FEES_SEED]`).
#[account]
#[derive(InitSpace)]
pub struct FeeConfig {
    /// Lamports charged to open an auction.
    pub listing_fee: u64,
    /// Share of each sale's proceeds, in basis points.
    pub sale_fee_bps: u16,
    /// System account receiving both fees.
    pub treasury: Pubkey,
    pub bump: u8,
}

/// Lamports paid to whoever runs each MPC step, when its computation
/// succeeds: a batch check, the clearing, one bid's settlement, and a
/// collection's seed draw. They cover the fees the caller paid to queue it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug, Default)]
pub struct CrankRewards {
    pub check_batch: u64,
    pub clearing: u64,
    pub settlement: u64,
    pub seed_draw: u64,
}

/// Crank rewards for auctions opened from now on (`[CRANK_SEED]`).
#[account]
#[derive(InitSpace)]
pub struct CrankConfig {
    pub rewards: CrankRewards,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum AuctionKind {
    /// Fungible tokens escrowed in the auction's vault; `mint` is the token.
    Token,
    /// NFTs of a new Metaplex Core collection, minted when winners claim
    /// them; `mint` is the collection and `token_program` is Core.
    Collection,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum AuctionStatus {
    /// Accepting bids from `start_time` until `end_time`; afterwards bids are
    /// checked.
    Open,
    /// The clearing price is known; bids are being settled.
    Settling,
    /// The seller has been paid.
    Finished,
    /// Withdrawn by the seller before any bid.
    Cancelled,
}

#[account(discriminator = AUCTION_DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct Auction {
    /// Seller-chosen value that, with the seller key, derives this address.
    pub seed: u64,
    pub seller: Pubkey,
    pub kind: AuctionKind,
    /// The token, or the collection of a collection auction.
    pub mint: Pubkey,
    /// The token's program, or Metaplex Core.
    pub token_program: Pubkey,
    /// Base units of the token for sale, or NFTs.
    pub supply: u64,
    /// Base units one price refers to; 1 (one NFT) for a collection.
    pub price_unit: u64,
    /// Lamports per price tick: 1 for tokens, `NFT_PRICE_SCALE` for NFTs.
    pub price_scale: u64,
    /// Lowest price that counts, in price ticks.
    pub min_price: u32,
    /// Smallest deposit a bid may make, in lamports.
    pub min_deposit: u64,
    /// Collections: most NFTs one bid may ask for; 0 for tokens.
    pub max_per_bid: u16,
    pub start_time: i64,
    pub end_time: i64,
    pub status: AuctionStatus,
    pub featured: bool,
    pub hidden: bool,
    pub bid_count: u32,
    /// Bids checked so far, in index order.
    pub checked_count: u32,
    /// Bids that are settled or refunded.
    pub resolved_count: u32,
    /// Bid accounts of this auction that are not closed yet.
    pub live_bids: u32,
    /// Computation account of the auction-level computation in flight, or the
    /// default key when none, with the slot and per-slot counter checked in
    /// its callback.
    pub pending_computation: Pubkey,
    pub pending_since: i64,
    pub pending_slot: u64,
    pub pending_slot_counter: u16,
    /// Bids covered by the check in flight.
    pub pending_batch: u8,
    /// Price every winner pays, in price ticks: the minimum price when
    /// demand never covered the supply.
    pub clearing_price: u32,
    /// Whether demand covered the supply at the minimum price.
    pub filled: bool,
    /// Demand strictly above and exactly at the clearing price: lamports of
    /// budget for tokens, NFTs for a collection.
    pub weight_above: u128,
    pub weight_at: u128,
    /// Collections: NFTs asked for by bids revealed at the clearing price so
    /// far. Once this reaches `weight_at`, their shares can be finalized.
    pub at_revealed: u128,
    /// Base units or NFTs allocated to winners.
    pub sold: u64,
    /// Base units delivered, or NFTs minted.
    pub delivered: u64,
    /// Lamports paid by winners, held in this account until claimed.
    pub proceeds: u64,
    /// Sum of the deposits of the auction's bids. A replaced bid takes its
    /// deposit out of the total; refunds after bidding ends do not change it.
    pub total_deposited: u64,
    /// Platform fee on the proceeds and where it goes, fixed when the auction
    /// opened.
    pub sale_fee_bps: u16,
    pub treasury: Pubkey,
    pub bump: u8,
    pub book_bump: u8,
    /// Collection auctions: royalty on secondary sales, paid to the seller.
    pub royalty_bps: u16,
    /// Collection auctions: whether each NFT has its own metadata file
    /// (see `nft_uri`) or all share `item_uri`.
    pub uri_per_item: bool,
    /// Collection auctions: NFT names and metadata (see `nft_name`).
    #[max_len(MAX_ITEM_NAME_LEN)]
    pub item_name: String,
    #[max_len(MAX_URI_LEN)]
    pub item_uri: String,
    /// Collection auctions: places handed out so far. Each winning bid takes
    /// the next ones, one per NFT, when it settles (`Bid::first_position`).
    pub assigned_positions: u32,
    /// Collection auctions: the seed `draw_nft_seed` drew once every bid was
    /// settled, which turns places into NFT numbers (`shuffled_items`).
    pub nft_seed: u128,
    pub seed_drawn: bool,
    /// Collection auctions: whether NFTs take their names from the auction's
    /// item list (`ItemList`) rather than `item_name`.
    pub named_items: bool,
    /// Hidden collections: whether the art is still to be revealed
    /// (`reveal_collection`). Until then no NFT can be claimed.
    pub unrevealed: bool,
    /// The rewards this auction pays for its MPC steps, fixed when it opened.
    pub crank_rewards: CrankRewards,
    /// Lamports held in this account to pay them: the seller's and every
    /// bid's crank fee, less the rewards paid. What is left goes to the
    /// seller when the auction is closed.
    pub crank_pool: u64,
    /// Pages of the bid book beyond the first (`add_book_page`), each room
    /// for `PAGE_BIDS` more bids, and the bumps of their addresses. Auctions
    /// opened before pages existed read these as zero: one page.
    pub extra_pages: u8,
    pub page_bumps: [u8; MAX_EXTRA_PAGES],
    /// Token auctions: auto-liquidity state (`LIQUIDITY_*`, see
    /// `liquidity`) and the least SOL its pool must get. Auctions opened
    /// before auto-liquidity read zero: none.
    pub liquidity: u8,
    pub liquidity_floor: u64,
}

/// The items of a collection auction named per item. Item `k` covers NFT
/// numbers from the previous item's end (0 for the first) up to its own end.
/// `count` entries of `ITEM_ENTRY_LEN` bytes follow this header, from
/// `ITEM_LIST_HEADER_LEN`.
#[account(discriminator = ITEM_LIST_DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct ItemList {
    /// The auction this list is for (its address, before it exists).
    pub auction: Pubkey,
    pub seller: Pubkey,
    /// Entries written so far.
    pub count: u32,
    /// NFTs the entries add up to: the last entry's end.
    pub total: u32,
    /// Set when the auction opens with this list; it cannot change after.
    pub sealed: bool,
    pub bump: u8,
}

/// An item for an item list: its name and how many NFTs it has.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub struct NewItem {
    pub name: String,
    pub supply: u32,
}

/// Per-auction storage too large to keep in `Auction`, which nearly every
/// instruction loads. Zero-copy, so only the parts used are touched.
///
/// One page of the book: room for `PAGE_BIDS` bids. Every auction has the
/// first page, `[BOOK_SEED, auction]`; `add_book_page` adds pages
/// `[BOOK_SEED, auction, [page]]`. Bid `index` lives on page
/// `index / PAGE_BIDS` at slot `index % PAGE_BIDS` (`page_slot`).
#[account(zero_copy, discriminator = BOOK_DISCRIMINATOR)]
#[repr(C)]
pub struct BidBook {
    /// The MXE-encrypted record of each checked batch: the `(price,
    /// quantity)` of its bids (a token bid's quantity is its budget), packed
    /// into two ciphertexts. Must stay the first field: the MPC cluster reads
    /// records in place at `BATCH_RECORDS_OFFSET`.
    pub batch_records: [[[u8; 32]; BATCH_RECORD_CIPHERTEXTS]; PAGE_BATCHES],
    /// Little-endian nonce of each batch record.
    pub batch_nonces: [[u8; 16]; PAGE_BATCHES],
    /// Deposit of the bid at each slot: how the smallest deposit is found
    /// when the auction is full.
    pub deposits: [u64; PAGE_BIDS_USIZE],
    pub auction: Pubkey,
    /// NFTs asked for by the bid at each index if it was revealed at the
    /// clearing price, else 0. `finalize_share` splits what is left there by
    /// these.
    pub clearing_quantities: [u32; PAGE_BIDS_USIZE],
}

/// The paged clearing of an auction with more than one page of bid book
/// (`[FOLD_SEED, auction]`, made with its second page): what `fold_batch`
/// carries from step to step, and where it is.
#[account(discriminator = FOLD_DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct ClearingFold {
    /// The MXE-encrypted state of the last step. Must stay the first field:
    /// the MPC cluster reads it in place at `FOLD_STATE_OFFSET`.
    pub state: [[u8; 32]; FOLD_STATE_CIPHERTEXTS],
    pub state_nonce: u128,
    pub auction: Pubkey,
    /// Pass and page of the next step; `pass` is `FOLD_PASSES` once done.
    pub pass: u8,
    pub page: u8,
    /// Steps done so far.
    pub steps: u16,
    /// The digits of the clearing price fixed so far.
    pub prefix: u32,
    pub bump: u8,
}

/// The auction terms a bidder saw when signing. `place_bid` refuses the bid
/// unless the auction has exactly these terms, so neither a stale view nor a
/// lying RPC node can make a bid land on terms the bidder did not see.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct ExpectedTerms {
    pub mint: Pubkey,
    pub supply: u64,
    pub price_unit: u64,
    pub price_scale: u64,
    pub min_price: u32,
    pub min_deposit: u64,
    pub max_per_bid: u16,
    pub end_time: i64,
}

impl ExpectedTerms {
    pub fn matches(&self, auction: &Auction) -> bool {
        self.mint == auction.mint
            && self.supply == auction.supply
            && self.price_unit == auction.price_unit
            && self.price_scale == auction.price_scale
            && self.min_price == auction.min_price
            && self.min_deposit == auction.min_deposit
            && self.max_per_bid == auction.max_per_bid
            && self.end_time == auction.end_time
    }
}

/// What a token auction sells, its minimum price and when bidding runs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct TokenSaleTerms {
    /// Base units for sale, escrowed when the auction opens.
    pub supply: u64,
    /// Base units one price refers to: a power of ten up to
    /// `MAX_PRICE_UNIT`.
    pub price_unit: u64,
    /// Lowest price that counts, in lamports per `price_unit`.
    pub min_price: u32,
    /// Smallest deposit, and smallest private budget, a bid may make, in
    /// lamports.
    pub min_deposit: u64,
    pub duration_secs: i64,
    /// When bidding opens (unix seconds); 0 or a past time for right away.
    pub start_time: i64,
}

/// What a collection auction sells, its minimum price and when bidding runs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct CollectionSaleTerms {
    /// NFTs for sale.
    pub supply: u64,
    /// Lowest price per NFT that counts, in ticks of `NFT_PRICE_SCALE`
    /// lamports.
    pub min_price: u32,
    /// Most NFTs one bid may ask for.
    pub max_per_bid: u16,
    pub duration_secs: i64,
    /// When bidding opens (unix seconds); 0 or a past time for right away.
    pub start_time: i64,
}

/// The most a seller accepts to pay in platform fees. Opening an auction
/// fails if the current fees are higher.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct FeeTerms {
    pub listing_fee: u64,
    pub sale_fee_bps: u16,
}

/// What a collection auction sells (see `create_collection_auction`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub struct CollectionTerms {
    /// Collection name and metadata URI.
    pub name: String,
    pub uri: String,
    /// NFT name, before " #1", " #2" and so on.
    pub item_name: String,
    /// NFT metadata: a base URI if `uri_per_item`, else the URI of every NFT.
    pub item_uri: String,
    pub uri_per_item: bool,
    /// Royalty on secondary sales, paid to the seller; 0 for none.
    pub royalty_bps: u16,
    /// Whether the art stays hidden until the seller reveals it after the
    /// sale (see `reveal_collection`).
    pub hidden: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum BidStatus {
    Sealed,
    /// Decided; the payment has moved to the auction. The rest of the
    /// deposit waits here for `close_bid`, what the bid won for
    /// `claim_tokens` or `claim_nfts`.
    Settled,
    /// A collection bid revealed exactly at the clearing price; waits for
    /// `finalize_share`. Nothing has moved yet.
    AtClearing,
}

#[account(discriminator = BID_DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct Bid {
    /// These two must stay the first fields: the MPC cluster reads them in
    /// place at `BID_CIPHERTEXT_OFFSET`.
    pub price_ciphertext: [u8; 32],
    pub quantity_ciphertext: [u8; 32],
    /// The bidder's x25519 public key used for this encryption.
    pub client_pubkey: [u8; 32],
    pub nonce: u128,
    pub auction: Pubkey,
    pub bidder: Pubkey,
    /// Position in the auction's check order.
    pub index: u32,
    /// Lamports escrowed in this account on top of its rent. It covers a
    /// token bid's private budget, or a collection bid's price times size.
    pub deposit: u64,
    pub status: BidStatus,
    /// Computation in flight for this bid, with the slot and per-slot counter
    /// checked in its callback.
    pub pending_computation: Pubkey,
    pub pending_since: i64,
    pub pending_slot: u64,
    pub pending_slot_counter: u16,
    pub outcome: u8,
    /// Base units or NFTs won.
    pub won: u64,
    /// Lamports paid for them.
    pub payment: u64,
    /// Whether everything this bid won has been delivered.
    pub delivered: bool,
    /// Collection auctions: NFTs minted to the bidder so far.
    pub nfts_claimed: u32,
    pub bump: u8,
    /// Collection auctions: the first of the places this bid took when it
    /// settled, one per NFT won.
    pub first_position: u32,
}

/// A bidder's note on their bid (see `save_bid_note`).
#[account(discriminator = BID_NOTE_DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct BidNote {
    pub bid: Pubkey,
    pub bidder: Pubkey,
    /// Encrypted by the bidder's app; opaque to the program.
    pub note: [u8; BID_NOTE_LEN],
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Accounts: administration
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ AuctionError::Unauthorized)]
    pub program: Program<'info, crate::program::SealedAuction>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ AuctionError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ AuctionError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetListing<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ AuctionError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub auction: Box<Account<'info, Auction>>,
}

#[derive(Accounts)]
pub struct SetFees<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ AuctionError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + FeeConfig::INIT_SPACE,
        seeds = [FEES_SEED],
        bump,
    )]
    pub fee_config: Account<'info, FeeConfig>,
    /// CHECK: the wallet that will receive fees; checked in the handler.
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetCrankRewards<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ AuctionError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + CrankConfig::INIT_SPACE,
        seeds = [CRANK_SEED],
        bump,
    )]
    pub crank_config: Account<'info, CrankConfig>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Accounts: auction lifecycle
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct CreateAuction<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        init,
        payer = seller,
        space = 8 + Auction::INIT_SPACE,
        seeds = [AUCTION_SEED, seller.key().as_ref(), &seed.to_le_bytes()],
        bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        init,
        payer = seller,
        space = 8 + std::mem::size_of::<BidBook>(),
        seeds = [BOOK_SEED, auction.key().as_ref()],
        bump,
    )]
    pub book: AccountLoader<'info, BidBook>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = seller,
        token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// `init_if_needed` because anyone can create an associated token account
    /// for any owner; a pre-created vault is still owned by this auction.
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = mint,
        associated_token::authority = auction,
        associated_token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(seeds = [FEES_SEED], bump = fee_config.bump)]
    pub fee_config: Box<Account<'info, FeeConfig>>,
    /// CHECK: the treasury named in the fee config; receives the listing fee.
    #[account(mut, address = fee_config.treasury @ AuctionError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [CRANK_SEED], bump = crank_config.bump)]
    pub crank_config: Box<Account<'info, CrankConfig>>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct CreateCollectionAuction<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        init,
        payer = seller,
        space = 8 + Auction::INIT_SPACE,
        seeds = [AUCTION_SEED, seller.key().as_ref(), &seed.to_le_bytes()],
        bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        init,
        payer = seller,
        space = 8 + std::mem::size_of::<BidBook>(),
        seeds = [BOOK_SEED, auction.key().as_ref()],
        bump,
    )]
    pub book: AccountLoader<'info, BidBook>,
    /// CHECK: created here by Metaplex Core at this program-derived address.
    #[account(mut, seeds = [COLLECTION_SEED, auction.key().as_ref()], bump)]
    pub collection: UncheckedAccount<'info>,
    #[account(seeds = [FEES_SEED], bump = fee_config.bump)]
    pub fee_config: Box<Account<'info, FeeConfig>>,
    /// CHECK: the treasury named in the fee config; receives the listing fee.
    #[account(mut, address = fee_config.treasury @ AuctionError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: the Metaplex Core program.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// Only for a collection named per item: its item list, sealed here.
    #[account(
        mut,
        seeds = [ITEMS_SEED, auction.key().as_ref()],
        bump = item_list.bump,
    )]
    pub item_list: Option<Box<Account<'info, ItemList>>>,
    #[account(seeds = [CRANK_SEED], bump = crank_config.bump)]
    pub crank_config: Box<Account<'info, CrankConfig>>,
}

#[derive(Accounts)]
#[instruction(page: u8)]
pub struct AddBookPage<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        init,
        payer = seller,
        space = 8 + std::mem::size_of::<BidBook>(),
        seeds = [BOOK_SEED, auction.key().as_ref(), &[page]],
        bump,
    )]
    pub page_book: AccountLoader<'info, BidBook>,
    /// Made with the second page.
    #[account(
        init_if_needed,
        payer = seller,
        space = 8 + ClearingFold::INIT_SPACE,
        seeds = [FOLD_SEED, auction.key().as_ref()],
        bump,
    )]
    pub fold: Box<Account<'info, ClearingFold>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct InitItemList<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: where the auction opened with `seed` will be; only its address
    /// is used.
    #[account(seeds = [AUCTION_SEED, seller.key().as_ref(), &seed.to_le_bytes()], bump)]
    pub auction: UncheckedAccount<'info>,
    #[account(
        init,
        payer = seller,
        space = ITEM_LIST_HEADER_LEN,
        seeds = [ITEMS_SEED, auction.key().as_ref()],
        bump,
    )]
    pub item_list: Box<Account<'info, ItemList>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(items: Vec<NewItem>)]
pub struct AddItems<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        has_one = seller @ AuctionError::Unauthorized,
        realloc = ITEM_LIST_HEADER_LEN + (item_list.count as usize + items.len()) * ITEM_ENTRY_LEN,
        realloc::payer = seller,
        realloc::zero = false,
    )]
    pub item_list: Box<Account<'info, ItemList>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseItemList<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, close = seller, has_one = seller @ AuctionError::Unauthorized)]
    pub item_list: Box<Account<'info, ItemList>>,
}

#[derive(Accounts)]
pub struct RevealCollection<'info> {
    pub seller: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
        constraint = auction.kind == AuctionKind::Collection @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
}

/// Permissionless: the payment only goes back to the bid.
#[derive(Accounts)]
pub struct RefundUnrevealed<'info> {
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        constraint = auction.kind == AuctionKind::Collection @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, has_one = auction @ AuctionError::WrongBidAccounts)]
    pub bid: Box<Account<'info, Bid>>,
}

/// Shared by `cancel_auction` and `claim_proceeds` of token auctions.
#[derive(Accounts)]
pub struct SellerWithdraw<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
        has_one = mint,
        has_one = treasury @ AuctionError::InvalidTreasury,
        constraint = auction.kind == AuctionKind::Token @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
    /// CHECK: the treasury fixed when the auction opened; receives the sale
    /// fee.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = auction,
        associated_token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = mint,
        associated_token::authority = seller,
        associated_token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = auction.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Shared by `cancel_collection_auction` and `claim_collection_proceeds`.
#[derive(Accounts)]
pub struct CollectionSeller<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
        has_one = treasury @ AuctionError::InvalidTreasury,
        constraint = auction.kind == AuctionKind::Collection @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
    /// CHECK: the treasury fixed when the auction opened; receives the sale
    /// fee.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseCollectionAuction<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        close = seller,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
        constraint = auction.kind == AuctionKind::Collection @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        mut,
        close = seller,
        seeds = [BOOK_SEED, auction.key().as_ref()],
        bump = auction.book_bump,
    )]
    pub book: AccountLoader<'info, BidBook>,
    /// Only for an auction with more than one page: its paged clearing.
    #[account(
        mut,
        close = seller,
        seeds = [FOLD_SEED, auction.key().as_ref()],
        bump = fold.bump,
    )]
    pub fold: Option<Box<Account<'info, ClearingFold>>>,
    /// CHECK: the auction's collection, created with it.
    #[account(mut, address = auction.mint @ AuctionError::WrongAssetAccounts)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: the Metaplex Core program.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// Only for a collection named per item: its item list, closed here.
    #[account(
        mut,
        close = seller,
        seeds = [ITEMS_SEED, auction.key().as_ref()],
        bump = item_list.bump,
    )]
    pub item_list: Option<Box<Account<'info, ItemList>>>,
}

/// Permissionless: the NFTs can only go to the bid's owner. The NFT
/// accounts follow as remaining accounts (see `claim_nfts`).
#[derive(Accounts)]
pub struct ClaimNfts<'info> {
    /// Pays the NFTs' rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        constraint = auction.kind == AuctionKind::Collection @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, has_one = auction @ AuctionError::WrongBidAccounts)]
    pub bid: Box<Account<'info, Bid>>,
    /// CHECK: the bid's owner; becomes the NFTs' owner.
    #[account(address = bid.bidder @ AuctionError::Unauthorized)]
    pub bidder: UncheckedAccount<'info>,
    /// CHECK: the auction's collection, created with it.
    #[account(mut, address = auction.mint @ AuctionError::WrongAssetAccounts)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: the Metaplex Core program.
    #[account(address = MPL_CORE_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// Only for a collection named per item: its item list.
    #[account(seeds = [ITEMS_SEED, auction.key().as_ref()], bump = item_list.bump)]
    pub item_list: Option<Box<Account<'info, ItemList>>>,
}

/// Permissionless: only moves the bid's payment to its auction.
#[derive(Accounts)]
pub struct FinalizeShare<'info> {
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        seeds = [BOOK_SEED, auction.key().as_ref()],
        bump = auction.book_bump,
    )]
    pub book: AccountLoader<'info, BidBook>,
    #[account(mut, has_one = auction @ AuctionError::WrongBidAccounts)]
    pub bid: Box<Account<'info, Bid>>,
}

#[derive(Accounts)]
#[instruction(bid_seed: u64)]
pub struct PlaceBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        mut,
        seeds = [BOOK_SEED, auction.key().as_ref()],
        bump = auction.book_bump,
    )]
    pub book: AccountLoader<'info, BidBook>,
    #[account(
        init,
        payer = bidder,
        space = 8 + Bid::INIT_SPACE,
        seeds = [BID_SEED, auction.key().as_ref(), bidder.key().as_ref(), &bid_seed.to_le_bytes()],
        bump,
    )]
    pub bid: Box<Account<'info, Bid>>,
    /// Only when the auction is full: the bid with the smallest deposit,
    /// which this bid replaces.
    #[account(mut)]
    pub evicted_bid: Option<Box<Account<'info, Bid>>>,
    /// CHECK: owner of `evicted_bid`, checked in the handler; receives its
    /// deposit and rent.
    #[account(mut)]
    pub evicted_bidder: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct IncreaseBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    /// The page of the book that holds the bid; checked in the handler.
    #[account(mut)]
    pub book: AccountLoader<'info, BidBook>,
    #[account(
        mut,
        has_one = bidder @ AuctionError::Unauthorized,
        has_one = auction @ AuctionError::WrongBidAccounts,
    )]
    pub bid: Box<Account<'info, Bid>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SaveBidNote<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(has_one = bidder @ AuctionError::Unauthorized)]
    pub bid: Box<Account<'info, Bid>>,
    #[account(
        init_if_needed,
        payer = bidder,
        space = 8 + BidNote::INIT_SPACE,
        seeds = [NOTE_SEED, bid.key().as_ref()],
        bump,
    )]
    pub note: Account<'info, BidNote>,
    pub system_program: Program<'info, System>,
}

/// The rent can only go to the note's bidder.
#[derive(Accounts)]
pub struct CloseBidNote<'info> {
    pub closer: Signer<'info>,
    /// CHECK: the note's bidder; receives its rent.
    #[account(mut, address = note.bidder @ AuctionError::Unauthorized)]
    pub bidder: UncheckedAccount<'info>,
    /// CHECK: the bid the note belongs to; whether it is closed is checked
    /// in the handler.
    #[account(address = note.bid @ AuctionError::WrongBidAccounts)]
    pub bid: UncheckedAccount<'info>,
    #[account(
        mut,
        close = bidder,
        seeds = [NOTE_SEED, note.bid.as_ref()],
        bump = note.bump,
    )]
    pub note: Account<'info, BidNote>,
}

/// Permissionless: the lamports can only go to the bid's owner.
#[derive(Accounts)]
pub struct CloseBid<'info> {
    /// CHECK: the bid's owner; receives the account's lamports.
    #[account(mut, address = bid.bidder @ AuctionError::Unauthorized)]
    pub bidder: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        mut,
        close = bidder,
        has_one = auction @ AuctionError::WrongBidAccounts,
        constraint = bid.status == BidStatus::Settled @ AuctionError::NotSettled,
        constraint = bid.won == 0 || bid.delivered @ AuctionError::TokensUnclaimed,
    )]
    pub bid: Box<Account<'info, Bid>>,
}

/// Permissionless: the lamports can only go to the bid's owner.
#[derive(Accounts)]
pub struct EmergencyRefund<'info> {
    /// CHECK: the bid's owner; receives the account's lamports.
    #[account(mut, address = bid.bidder @ AuctionError::Unauthorized)]
    pub bidder: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        mut,
        close = bidder,
        has_one = auction @ AuctionError::WrongBidAccounts,
    )]
    pub bid: Box<Account<'info, Bid>>,
}

#[derive(Accounts)]
pub struct CloseAuction<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        close = seller,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
        has_one = mint,
        constraint = auction.kind == AuctionKind::Token @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        mut,
        close = seller,
        seeds = [BOOK_SEED, auction.key().as_ref()],
        bump = auction.book_bump,
    )]
    pub book: AccountLoader<'info, BidBook>,
    /// Only for an auction with more than one page: its paged clearing.
    #[account(
        mut,
        close = seller,
        seeds = [FOLD_SEED, auction.key().as_ref()],
        bump = fold.bump,
    )]
    pub fold: Option<Box<Account<'info, ClearingFold>>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the auction's vault, which may already be closed; inspected in
    /// the handler.
    #[account(
        mut,
        address = anchor_spl::associated_token::get_associated_token_address_with_program_id(
            &auction.key(),
            &mint.key(),
            &token_program.key(),
        ) @ AuctionError::WrongVault,
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = mint,
        associated_token::authority = seller,
        associated_token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = auction.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: the tokens can only go to the bid owner's associated token
/// account, which the caller creates and pays for if needed.
#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = mint,
        constraint = auction.kind == AuctionKind::Token @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, has_one = auction @ AuctionError::WrongBidAccounts)]
    pub bid: Box<Account<'info, Bid>>,
    /// CHECK: the bid's owner; only used as the token account's authority.
    #[account(address = bid.bidder @ AuctionError::Unauthorized)]
    pub bidder: UncheckedAccount<'info>,
    /// CHECK: the auction's seller; receives the vault's rent when it closes.
    #[account(mut, address = auction.seller @ AuctionError::Unauthorized)]
    pub seller: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = auction,
        associated_token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = bidder,
        associated_token::token_program = token_program,
    )]
    pub bidder_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = auction.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
// ---------------------------------------------------------------------------
// Accounts: MPC computations
// ---------------------------------------------------------------------------

#[queue_computation_accounts("check_bids_v2", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CheckBatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    /// The page of the book that receives the batch record in the callback;
    /// checked in the handler.
    pub book: AccountLoader<'info, BidBook>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CHECK_BIDS))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

/// Custom accounts after `instructions_sysvar` must match the order of the
/// `CallbackAccount` list built in `check_batch`.
#[callback_accounts("check_bids_v2")]
#[derive(Accounts)]
pub struct CheckBidsV2Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CHECK_BIDS))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by the arcium program and matched
    /// against the auction's pending computation.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    /// The page named by `check_batch`; checked in the handler.
    #[account(mut)]
    pub book: AccountLoader<'info, BidBook>,
    /// CHECK: whoever queued the check; named by `check_batch`, paid its
    /// reward.
    #[account(mut)]
    pub cranker: UncheckedAccount<'info>,
}

#[queue_computation_accounts("clear_price_v2", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct FindClearing<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    /// The first page, which then holds every batch record; the cluster
    /// reads them in place.
    #[account(
        seeds = [BOOK_SEED, auction.key().as_ref()],
        bump = auction.book_bump,
    )]
    pub book: AccountLoader<'info, BidBook>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CLEAR_PRICE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("clear_price_v2")]
#[derive(Accounts)]
pub struct ClearPriceV2Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CLEAR_PRICE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by the arcium program and matched
    /// against the auction's pending computation.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    /// CHECK: whoever queued the clearing; named by `find_clearing`, paid
    /// its reward.
    #[account(mut)]
    pub cranker: UncheckedAccount<'info>,
}

#[queue_computation_accounts("award_bid_v2", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SettleBid<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, has_one = auction @ AuctionError::WrongBidAccounts)]
    pub bid: Box<Account<'info, Bid>>,
    /// The page of the book that holds the bid's batch record, which the
    /// cluster reads in place; checked in the handler.
    pub book: AccountLoader<'info, BidBook>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_AWARD_BID))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

/// Custom accounts after `instructions_sysvar` must match the order of the
/// `CallbackAccount` list built in `settle_bid`.
#[callback_accounts("award_bid_v2")]
#[derive(Accounts)]
pub struct AwardBidV2Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_AWARD_BID))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by the arcium program and matched
    /// against the bid's pending computation.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, has_one = auction @ AuctionError::WrongBidAccounts)]
    pub bid: Box<Account<'info, Bid>>,
    /// The bid's page, named by `settle_bid`; checked in the handler.
    #[account(mut)]
    pub book: AccountLoader<'info, BidBook>,
    /// CHECK: whoever queued the settlement; named by `settle_bid`, paid its
    /// reward.
    #[account(mut)]
    pub cranker: UncheckedAccount<'info>,
}

#[queue_computation_accounts("fold_batch_v2", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct FoldClearing<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    /// Holds the state the cluster reads in place.
    #[account(
        seeds = [FOLD_SEED, auction.key().as_ref()],
        bump = fold.bump,
        has_one = auction @ AuctionError::WrongBookPage,
    )]
    pub fold: Box<Account<'info, ClearingFold>>,
    /// The page this step reads (`ClearingFold::page`), whose batch records
    /// the cluster reads in place; checked in the handler.
    pub book: AccountLoader<'info, BidBook>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FOLD_BATCH))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

/// Custom accounts after `instructions_sysvar` must match the order of the
/// `CallbackAccount` list built in `fold_clearing`.
#[callback_accounts("fold_batch_v2")]
#[derive(Accounts)]
pub struct FoldBatchV2Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_FOLD_BATCH))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by the arcium program and matched
    /// against the auction's pending computation.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        mut,
        seeds = [FOLD_SEED, auction.key().as_ref()],
        bump = fold.bump,
        has_one = auction @ AuctionError::WrongBookPage,
    )]
    pub fold: Box<Account<'info, ClearingFold>>,
    /// CHECK: whoever queued the step; named by `fold_clearing`, paid its
    /// reward.
    #[account(mut)]
    pub cranker: UncheckedAccount<'info>,
}

#[queue_computation_accounts("draw_seed", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct DrawNftSeed<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DRAW_SEED))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("draw_seed")]
#[derive(Accounts)]
pub struct DrawSeedCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DRAW_SEED))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by the arcium program and matched
    /// against the auction's pending computation.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    /// CHECK: whoever queued the draw; named by `draw_nft_seed`, paid its
    /// reward.
    #[account(mut)]
    pub cranker: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------------
// Accounts: computation definitions (admin only, so nobody else can become
// the circuit upload authority)
// ---------------------------------------------------------------------------

#[init_computation_definition_accounts("check_bids_v2", payer)]
#[derive(Accounts)]
pub struct InitCheckBidsCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.admin == payer.key() @ AuctionError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by the arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by the arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("clear_price_v2", payer)]
#[derive(Accounts)]
pub struct InitClearPriceCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.admin == payer.key() @ AuctionError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by the arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by the arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("award_bid_v2", payer)]
#[derive(Accounts)]
pub struct InitAwardBidCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.admin == payer.key() @ AuctionError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by the arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by the arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("draw_seed", payer)]
#[derive(Accounts)]
pub struct InitDrawSeedCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.admin == payer.key() @ AuctionError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by the arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by the arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("fold_batch_v2", payer)]
#[derive(Accounts)]
pub struct InitFoldBatchCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = config.admin == payer.key() @ AuctionError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by the arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by the arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct AuctionCreated {
    pub auction: Pubkey,
    pub kind: AuctionKind,
    pub seed: u64,
    pub seller: Pubkey,
    /// The token, or the collection of a collection auction.
    pub mint: Pubkey,
    pub supply: u64,
    pub price_unit: u64,
    pub price_scale: u64,
    pub min_price: u32,
    pub min_deposit: u64,
    pub max_per_bid: u16,
    pub start_time: i64,
    pub end_time: i64,
    /// Listing fee paid.
    pub listing_fee: u64,
    /// What the seller put in the crank pool, and what each bid adds.
    pub crank_pool: u64,
    pub bid_crank_fee: u64,
    /// Fee that will be taken from the proceeds.
    pub sale_fee_bps: u16,
}

#[event]
pub struct FeesUpdated {
    pub listing_fee: u64,
    pub sale_fee_bps: u16,
    pub treasury: Pubkey,
}

#[event]
pub struct AuctionCancelled {
    pub auction: Pubkey,
}

#[event]
pub struct BidPlaced {
    pub auction: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub index: u32,
    pub deposit: u64,
    /// Paid into the crank pool, not refunded.
    pub crank_fee: u64,
}

#[event]
pub struct BidIncreased {
    pub auction: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    /// The whole deposit now.
    pub deposit: u64,
}

#[event]
pub struct CrankRewardsUpdated {
    pub rewards: CrankRewards,
}

#[event]
pub struct CrankPaid {
    pub auction: Pubkey,
    pub cranker: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BidEvicted {
    pub auction: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub index: u32,
    /// Deposit returned, not counting the account's rent.
    pub refund: u64,
}

#[event]
pub struct BatchChecked {
    pub auction: Pubkey,
    pub checked_count: u32,
    pub bid_count: u32,
}

#[event]
pub struct ComputationFailed {
    pub auction: Pubkey,
    pub bid: Option<Pubkey>,
}

#[event]
pub struct BookPageAdded {
    pub auction: Pubkey,
    pub page: u8,
    /// Bids the auction can now hold.
    pub max_bids: u32,
    /// Added to the crank pool for the paged clearing.
    pub crank_fee: u64,
}

/// A step of the paged clearing succeeded.
#[event]
pub struct ClearingFolded {
    pub auction: Pubkey,
    pub pass: u8,
    pub page: u8,
    pub steps: u16,
    pub total_steps: u16,
    /// The digits of the clearing price fixed so far.
    pub prefix: u32,
}

#[event]
pub struct AuctionCleared {
    pub auction: Pubkey,
    /// Price every winner pays, in price ticks.
    pub clearing_price: u32,
    pub filled: bool,
    pub weight_above: u128,
    pub weight_at: u128,
}

#[event]
pub struct BidSettled {
    pub auction: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub outcome: u8,
    /// Base units or NFTs won.
    pub won: u64,
    pub payment: u64,
    pub refund: u64,
}

#[event]
pub struct BidAtClearing {
    pub auction: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    /// NFTs asked for, which the bid's share at the clearing price depends
    /// on.
    pub quantity: u64,
}

#[event]
pub struct CollectionRevealed {
    pub auction: Pubkey,
    /// Where the revealed metadata is, as committed when the auction opened.
    pub item_uri: String,
}

#[event]
pub struct NftsShuffled {
    pub auction: Pubkey,
    /// Turns places into NFT numbers (see `shuffled_items`).
    pub seed: u128,
}

#[event]
pub struct NftsClaimed {
    pub auction: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    /// The first of the bid's places minted now; the others follow it.
    pub first_position: u32,
    /// The NFT numbers (from 0) minted, one per place; NFT `i` is named
    /// `"{item_name} #{i + 1}"`.
    pub items: Vec<u32>,
}

#[event]
pub struct BidRefunded {
    pub auction: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TokensClaimed {
    pub auction: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BidClosed {
    pub auction: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    /// Unused deposit returned, not counting the account's rent.
    pub refund: u64,
}

#[event]
pub struct ProceedsClaimed {
    pub auction: Pubkey,
    pub seller: Pubkey,
    /// Proceeds before the fee; the seller received `proceeds - fee`.
    pub proceeds: u64,
    pub fee: u64,
    /// Unsold tokens returned, or unsold NFTs (never minted).
    pub unsold_amount: u64,
}

#[event]
pub struct AuctionClosed {
    pub auction: Pubkey,
    pub seller: Pubkey,
    /// Tokens found in the vault and sent to the seller.
    pub swept_amount: u64,
}

#[event]
pub struct ListingUpdated {
    pub auction: Pubkey,
    pub featured: bool,
    pub hidden: bool,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum AuctionError {
    #[msg("Only the authorized account can do this")]
    Unauthorized,
    #[msg("The price unit must be a power of ten up to 10^16")]
    InvalidPriceUnit,
    #[msg("Supply must be between 1 and the maximum for this kind of auction")]
    InvalidSupply,
    #[msg("Most NFTs per bid must be between 1 and the supply")]
    InvalidMaxPerBid,
    #[msg("The minimum price must be above zero")]
    InvalidPrice,
    #[msg("Duration is outside the allowed range")]
    InvalidDuration,
    #[msg("The token can still be minted; its mint authority must be revoked")]
    MintAuthorityActive,
    #[msg("The token can be frozen; its freeze authority must be revoked")]
    FreezeAuthorityActive,
    #[msg("The token uses an extension this platform does not allow")]
    UnsupportedExtension,
    #[msg("The auction is not in the right state for this")]
    WrongStatus,
    #[msg("Bidding has closed")]
    BiddingClosed,
    #[msg("Bidding is still open")]
    BiddingOpen,
    #[msg("The auction is full; replace the bid with the smallest deposit")]
    TooManyBids,
    #[msg("Deposit is below the minimum for this auction")]
    DepositTooSmall,
    #[msg("The auction already has bids")]
    HasBids,
    #[msg("The auction has no bids")]
    NoBids,
    #[msg("Every bid is already checked")]
    NothingToCheck,
    #[msg("Bid accounts are missing, out of order or from another auction")]
    WrongBidAccounts,
    #[msg("Not every bid has been checked yet")]
    BidsNotChecked,
    #[msg("A computation for this account is still in flight")]
    ComputationInFlight,
    #[msg("The callback does not belong to the pending computation")]
    UnexpectedComputation,
    #[msg("The clearing result is inconsistent")]
    InvalidClearing,
    #[msg("The allocation result is inconsistent")]
    InvalidAllocation,
    #[msg("The bid is already settled")]
    BidAlreadySettled,
    #[msg("Allocations would exceed the supply")]
    Oversold,
    #[msg("The payment exceeds the bid's deposit")]
    Underfunded,
    #[msg("Not every bid has been settled yet")]
    NotSettled,
    #[msg("The safety net is open; this auction can no longer progress")]
    EmergencyActive,
    #[msg("The safety net is not open yet")]
    TooEarly,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("The bid must be encrypted under the nonce derived from its address")]
    InvalidNonce,
    #[msg("A ciphertext is not a valid field element")]
    InvalidCiphertext,
    #[msg("The bid's encryption key is not a usable x25519 key")]
    InvalidEncryptionKey,
    #[msg("Circuits must be fetched over https")]
    InvalidCircuitUrl,
    #[msg("This bid did not win anything")]
    NothingToClaim,
    #[msg("What this bid won was already delivered")]
    AlreadyClaimed,
    #[msg("Deliver what this bid won before closing it")]
    TokensUnclaimed,
    #[msg("The auction's terms differ from the ones this bid was made for")]
    TermsMismatch,
    #[msg("Only the bid with the smallest deposit can be replaced")]
    NotSmallestBid,
    #[msg("Some bid accounts of this auction are still open")]
    BidsOutstanding,
    #[msg("This is not the auction's vault")]
    WrongVault,
    #[msg("The computation definition is not the pinned, active circuit")]
    CircuitNotPinned,
    #[msg("Fees are above the platform's fixed caps")]
    FeeTooHigh,
    #[msg("Platform fees are higher than the ones accepted")]
    FeesChanged,
    #[msg("The treasury must be the fee wallet: a funded system account")]
    InvalidTreasury,
    #[msg("This does not apply to this kind of auction")]
    WrongAuctionKind,
    #[msg("Collection names, metadata links or royalty are invalid")]
    InvalidCollectionTerms,
    #[msg("NFT or collection accounts are missing, out of order or wrong")]
    WrongAssetAccounts,
    #[msg("Only a collection bid at the clearing price has a share to finalize")]
    NotAtClearing,
    #[msg("Not every bid at the clearing price has been revealed yet")]
    SharesNotReady,
    #[msg("This bid's share is ready; finalize it instead")]
    ShareReady,
    #[msg("The minimum deposit must be above zero")]
    InvalidMinDeposit,
    #[msg("The NFTs are already shuffled")]
    SeedAlreadyDrawn,
    #[msg("The NFTs are not shuffled yet; draw the seed first")]
    NftsNotShuffled,
    #[msg("No NFTs were sold")]
    NothingSold,
    #[msg("Item names or numbers of NFTs are invalid")]
    InvalidItems,
    #[msg("An item list holds at most 500 items")]
    TooManyItems,
    #[msg("This item list is sealed into an auction")]
    ItemListSealed,
    #[msg("The item list is missing or does not match this auction")]
    ItemListMismatch,
    #[msg("The seller has not revealed this collection yet")]
    NotRevealed,
    #[msg("This collection is already revealed, or was never hidden")]
    AlreadyRevealed,
    #[msg("The time to reveal this collection is over")]
    RevealClosed,
    #[msg("Bidding can start at most 30 days ahead")]
    InvalidStartTime,
    #[msg("Bidding has not started yet")]
    BiddingNotStarted,
    #[msg("Only the bidder can close the note of a bid that is still open")]
    BidStillOpen,
    #[msg("A page of the bid book is missing, out of order or not this auction's")]
    WrongBookPage,
    #[msg("An auction's bid book has at most four pages, added in order")]
    TooManyPages,
    #[msg("The bids fill more than one page; find the clearing price with fold_clearing")]
    UsePagedClearing,
    #[msg("The bids fit on one page; find the clearing price with find_clearing")]
    UseSingleClearing,
    #[msg("This auction already has an auto-liquidity plan")]
    LiquidityAlreadyPlanned,
    #[msg("The pool's share of the proceeds must be between 20% and 100%")]
    InvalidLiquidityShare,
    #[msg("The pool's minimum SOL must be above zero")]
    InvalidLiquidityFloor,
    #[msg("The pool fee must be 0.25%, 1% or 2%")]
    InvalidPoolFee,
    #[msg("This auction has no pending auto-liquidity plan")]
    LiquidityNotPlanned,
    #[msg("The auto-liquidity plan must be carried out or released first")]
    LiquidityPending,
    #[msg("The sale missed the pool's minimum; refund the bids with refund_failed_bid")]
    LiquidityFloorMissed,
    #[msg("The reserve is still needed for the pool")]
    LiquidityStillNeeded,
    #[msg("The pool accounts do not match")]
    WrongPoolAccounts,
}

// ---------------------------------------------------------------------------
// Tests for the byte layout MPC relies on and the settlement maths
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::{
        constants::{ED25519_BASEPOINT_POINT, EIGHT_TORSION},
        montgomery::MontgomeryPoint,
        scalar::Scalar,
        traits::Identity,
        EdwardsPoint,
    };

    /// `fold_arguments` must list exactly what `ArgBuilder` would, in the
    /// order of `fold_batch_v2`'s parameters.
    #[test]
    fn fold_arguments_match_the_arg_builder() {
        let mut book: BidBook = bytemuck::Zeroable::zeroed();
        for (i, nonce) in book.batch_nonces.iter_mut().enumerate() {
            *nonce = (77u128 * (i as u128 + 3)).to_le_bytes();
        }
        let fold = ClearingFold {
            state: [[5; 32]; FOLD_STATE_CIPHERTEXTS],
            state_nonce: 0xfeed_beef,
            auction: Pubkey::default(),
            pass: 3,
            page: 1,
            steps: 26,
            prefix: 0xabc0_0000,
            bump: 255,
        };
        let (fold_key, book_key) = (Pubkey::new_from_array([4; 32]), Pubkey::new_from_array([9; 32]));
        let mut expected = ArgBuilder::new()
            .plaintext_u128(0xfeed_beef)
            .account(fold_key, FOLD_STATE_OFFSET, FOLD_STATE_LEN);
        for batch in 0..PAGE_BATCHES {
            expected = expected
                .plaintext_u128(u128::from_le_bytes(book.batch_nonces[batch]))
                .account(book_key, BATCH_RECORDS_OFFSET + BATCH_RECORD_LEN * batch as u32, BATCH_RECORD_LEN);
        }
        let step = FoldStep {
            fresh: false,
            decide: true,
            last_pass: false,
            shift: 16,
        };
        let expected = expected
            .plaintext_u8(64)
            .plaintext_bool(false)
            .plaintext_bool(true)
            .plaintext_bool(false)
            .plaintext_u64(0xabc0_0000)
            .plaintext_u8(16)
            .plaintext_u64(1 << 16)
            .plaintext_bool(true)
            .plaintext_u64(1_000)
            .plaintext_u64(5_000_000)
            .build();
        let auction = Auction {
            supply: 5_000_000,
            price_unit: 1_000,
            ..blank_auction()
        };
        let actual = fold_arguments(&fold, fold_key, &book.batch_nonces, book_key, 64, step, &auction);
        assert_eq!(borsh::to_vec(&actual).unwrap(), borsh::to_vec(&expected).unwrap());
        assert_eq!(actual.args.capacity(), actual.args.len());
        assert_eq!(actual.values_128_bit.capacity(), actual.values_128_bit.len());
        assert_eq!(actual.plaintext_numbers.capacity(), actual.plaintext_numbers.len());
        // The state sits right after the discriminator.
        let bytes = borsh::to_vec(&fold).unwrap();
        assert_eq!(&bytes[..FOLD_STATE_LEN as usize], &[5u8; FOLD_STATE_LEN as usize][..]);
        assert_eq!(bytes.len(), ClearingFold::INIT_SPACE);
    }

    /// Runs the fold schedule the way the callbacks advance it.
    fn fold_schedule(pages: u8) -> Vec<(u8, u8, FoldStep)> {
        let mut fold = ClearingFold {
            state: [[0; 32]; FOLD_STATE_CIPHERTEXTS],
            state_nonce: 0,
            auction: Pubkey::default(),
            pass: 0,
            page: 0,
            steps: 0,
            prefix: 0,
            bump: 0,
        };
        let mut seen = Vec::new();
        while fold.pass < FOLD_PASSES {
            let step = fold_step(&fold, pages);
            seen.push((fold.pass, fold.page, step));
            fold.steps += 1;
            if step.decide {
                if step.last_pass {
                    fold.pass = FOLD_PASSES;
                } else {
                    fold.pass += 1;
                    fold.page = next_fold_page(fold.pass, fold.page);
                }
            } else {
                fold.page = next_fold_page(fold.pass, fold.page);
            }
        }
        seen
    }

    #[test]
    fn the_fold_reads_every_page_in_every_pass() {
        for pages in 2..=MAX_PAGES {
            let steps = fold_schedule(pages);
            assert_eq!(steps.len(), fold_total_steps(pages) as usize);
            assert!(steps[0].2.fresh && steps[1..].iter().all(|s| !s.2.fresh));
            for pass in 0..FOLD_PASSES {
                // The pages of this pass: its own steps plus, after the first
                // pass, the page that ended the previous one.
                let mut pages_read: Vec<u8> =
                    steps.iter().filter(|s| s.0 == pass).map(|s| s.1).collect();
                if pass > 0 {
                    let previous = steps.iter().filter(|s| s.0 == pass - 1).last().unwrap();
                    assert!(previous.2.decide);
                    pages_read.insert(0, previous.1);
                }
                pages_read.sort();
                assert_eq!(pages_read, (0..pages).collect::<Vec<_>>(), "pass {pass}");
                // Exactly one step ends the pass, fixing the four bits at its shift.
                let ends: Vec<_> = steps.iter().filter(|s| s.0 == pass && s.2.decide).collect();
                assert_eq!(ends.len(), 1);
                assert_eq!(ends[0].2.shift, 28 - 4 * pass);
                assert_eq!(ends[0].2.last_pass, pass + 1 == FOLD_PASSES);
            }
        }
        assert_eq!(fold_total_steps(2), 9);
        assert_eq!(fold_total_steps(4), 25);
    }

    #[test]
    fn bids_map_to_pages() {
        assert_eq!(page_slot(0), (0, 0));
        assert_eq!(page_slot(255), (0, 255));
        assert_eq!(page_slot(256), (1, 0));
        assert_eq!(page_slot(MAX_BIDS - 1), (3, 255));
        assert_eq!(page_active_batches(1, 0), 1);
        assert_eq!(page_active_batches(256, 0), 64);
        assert_eq!(page_active_batches(256, 1), 0);
        assert_eq!(page_active_batches(258, 1), 1);
        assert_eq!(page_active_batches(1_000, 3), 58);
        let mut auction = blank_auction();
        assert_eq!(bid_capacity(&auction), 256);
        assert_eq!(pages_in_use(&auction), 1);
        auction.extra_pages = 3;
        auction.bid_count = 257;
        assert_eq!(bid_capacity(&auction), MAX_BIDS);
        assert_eq!(pages_in_use(&auction), 2);
    }

    /// `clearing_arguments` must list exactly what `ArgBuilder` would, in the
    /// order of the circuit's parameters.
    #[test]
    fn clearing_arguments_match_the_arg_builder() {
        let mut book: BidBook = bytemuck::Zeroable::zeroed();
        for (i, nonce) in book.batch_nonces.iter_mut().enumerate() {
            *nonce = (0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10u128 * (i as u128 + 1)).to_le_bytes();
        }
        let key = Pubkey::new_from_array([9; 32]);
        let mut expected = ArgBuilder::new();
        for batch in 0..PAGE_BATCHES {
            expected = expected
                .plaintext_u128(u128::from_le_bytes(book.batch_nonces[batch]))
                .account(key, BATCH_RECORDS_OFFSET + BATCH_RECORD_LEN * batch as u32, BATCH_RECORD_LEN);
        }
        // No deposits: token budgets come from the encrypted records.
        let expected = expected
            .plaintext_u8(37)
            .plaintext_bool(true)
            .plaintext_u64(1_000_000)
            .plaintext_u64(u64::MAX - 5)
            .build();
        let actual = clearing_arguments(&book.batch_nonces, key, 37, true, 1_000_000, u64::MAX - 5);
        assert_eq!(borsh::to_vec(&actual).unwrap(), borsh::to_vec(&expected).unwrap());
        // Every vector was allocated at its final size.
        assert_eq!(actual.args.capacity(), actual.args.len());
        assert_eq!(actual.values_128_bit.capacity(), actual.values_128_bit.len());
        assert_eq!(actual.accounts.capacity(), actual.accounts.len());
    }

    /// `bid_nonce` of the address `[7; 32]`, computed independently.
    const BID_NONCE_FOR_SEVENS: u128 = 284_758_319_836_013_835_415_935_995_398_357_918_837;

    fn blank_auction() -> Auction {
        let fees = FeeConfig {
            listing_fee: 0,
            sale_fee_bps: 0,
            treasury: Pubkey::default(),
            bump: 0,
        };
        new_auction(
            AuctionKind::Token,
            0,
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            0,
            0,
            [0, 0],
            &fees,
            CrankRewards::default(),
        )
    }

    #[test]
    fn this_release_has_its_own_discriminators() {
        assert_eq!(Auction::DISCRIMINATOR, AUCTION_DISCRIMINATOR);
        assert_eq!(BidBook::DISCRIMINATOR, BOOK_DISCRIMINATOR);
        assert_eq!(Bid::DISCRIMINATOR, BID_DISCRIMINATOR);
        assert_eq!(BidNote::DISCRIMINATOR, BID_NOTE_DISCRIMINATOR);
        // The first release used Anchor's default, sha256("account:<Name>").
        for (name, disc) in [
            ("Auction", AUCTION_DISCRIMINATOR),
            ("BidBook", BOOK_DISCRIMINATOR),
            ("Bid", BID_DISCRIMINATOR),
        ] {
            let default = hashv(&[format!("account:{name}").as_bytes()]).to_bytes();
            assert_eq!(disc.len(), 8);
            assert_ne!(disc, &default[..8], "{name}");
        }
    }

    #[test]
    fn the_longest_auction_fits_its_space() {
        let mut auction = blank_auction();
        auction.item_name = "n".repeat(MAX_ITEM_NAME_LEN);
        auction.item_uri = "u".repeat(MAX_URI_LEN);
        let mut bytes = Vec::new();
        auction.try_serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), 8 + Auction::INIT_SPACE);
        assert_eq!(&bytes[..8], AUCTION_DISCRIMINATOR);
    }

    /// An auction written by the release before item lists and hidden
    /// collections (everything up to `seed_drawn`) reads with both off: the
    /// two new flags come from the unused end of its account.
    #[test]
    fn auctions_from_before_item_lists_read_with_both_off() {
        let mut auction = blank_auction();
        auction.kind = AuctionKind::Collection;
        auction.item_name = "Veiling Cat".into();
        auction.item_uri = format!("https://arweave.net/{}/", "a".repeat(43));
        auction.seed_drawn = true;
        let mut bytes = Vec::new();
        auction.try_serialize(&mut bytes).unwrap();
        // Drop the two new flags, then pad to the old account size.
        bytes.truncate(bytes.len() - 2);
        bytes.resize(8 + Auction::INIT_SPACE - 2, 0);
        let read = Auction::try_deserialize(&mut &bytes[..]).unwrap();
        assert!(read.seed_drawn && !read.named_items && !read.unrevealed);
        assert_eq!(read.item_uri, auction.item_uri);
    }

    #[test]
    fn item_list_header_is_where_entries_start() {
        assert_eq!(ItemList::DISCRIMINATOR, ITEM_LIST_DISCRIMINATOR);
        assert_eq!(ITEM_LIST_HEADER_LEN, 8 + 32 + 32 + 4 + 4 + 1 + 1);
        let list = ItemList {
            auction: Pubkey::new_unique(),
            seller: Pubkey::new_unique(),
            count: 3,
            total: 6,
            sealed: true,
            bump: 254,
        };
        let mut bytes = Vec::new();
        list.try_serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), ITEM_LIST_HEADER_LEN);
    }

    /// Item list entries as `add_items` writes them.
    fn item_entries(items: &[(&str, u32)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut end = 0u32;
        for (name, supply) in items {
            end += supply;
            let mut entry = vec![0u8; ITEM_ENTRY_LEN];
            entry[..4].copy_from_slice(&end.to_le_bytes());
            entry[4] = name.len() as u8;
            entry[5..5 + name.len()].copy_from_slice(name.as_bytes());
            out.extend(entry);
        }
        out
    }

    #[test]
    fn nfts_named_per_item_follow_the_item_list() {
        let entries = item_entries(&[("Gün Batımı", 3), ("Lale", 1), ("Çini", 2)]);
        let name = |item| item_nft_name(&entries, 3, item).unwrap();
        assert_eq!(name(0), "Gün Batımı #1");
        assert_eq!(name(2), "Gün Batımı #3");
        // An item with one NFT keeps its name as it is.
        assert_eq!(name(3), "Lale");
        assert_eq!(name(4), "Çini #1");
        assert_eq!(name(5), "Çini #2");
        assert!(item_nft_name(&entries, 3, 6).is_err());
        // A list shorter than its count is refused rather than misread.
        assert!(item_nft_name(&entries[..ITEM_ENTRY_LEN], 3, 0).is_err());

        // The longest name with the highest edition still fits Core's names.
        let longest = "n".repeat(MAX_ITEM_NAME_LEN);
        let entries = item_entries(&[(&longest, MAX_COLLECTION_SIZE as u32)]);
        let last = item_nft_name(&entries, 1, MAX_COLLECTION_SIZE as u32 - 1).unwrap();
        assert!(last.len() <= 32 && last.ends_with("#10000"));

        // The search lands on every item of a full list of single NFTs.
        let names: Vec<String> = (0..MAX_ITEMS).map(|k| format!("Tile {k}")).collect();
        let list: Vec<(&str, u32)> = names.iter().map(|n| (n.as_str(), 1)).collect();
        let entries = item_entries(&list);
        for k in 0..MAX_ITEMS {
            assert_eq!(item_nft_name(&entries, MAX_ITEMS, k).unwrap(), names[k as usize]);
        }
        // And on uneven items, at both edges of each.
        let entries = item_entries(&[("A", 1), ("B", 10), ("C", 2), ("D", 7)]);
        for (item, expected) in [(0, "A"), (1, "B #1"), (10, "B #10"), (11, "C #1"), (12, "C #2"), (13, "D #1"), (19, "D #7")] {
            assert_eq!(item_nft_name(&entries, 4, item).unwrap(), expected);
        }
    }

    #[test]
    fn bid_ciphertexts_sit_right_after_the_discriminator() {
        let bid = Bid {
            price_ciphertext: [7u8; 32],
            quantity_ciphertext: [9u8; 32],
            client_pubkey: [0u8; 32],
            nonce: 0,
            auction: Pubkey::default(),
            bidder: Pubkey::default(),
            index: 0,
            deposit: 0,
            status: BidStatus::Sealed,
            pending_computation: Pubkey::default(),
            pending_since: 0,
            pending_slot: 0,
            pending_slot_counter: 0,
            outcome: 0,
            won: 0,
            payment: 0,
            delivered: false,
            nfts_claimed: 0,
            bump: 0,
            first_position: 0,
        };
        let mut bytes = Vec::new();
        bid.try_serialize(&mut bytes).unwrap();
        let start = BID_CIPHERTEXT_OFFSET as usize;
        assert_eq!(&bytes[start..start + 32], &[7u8; 32]);
        assert_eq!(&bytes[start + 32..start + 64], &[9u8; 32]);
        assert_eq!(bytes.len(), 8 + Bid::INIT_SPACE);
    }

    #[test]
    fn batch_records_sit_right_after_the_book_discriminator() {
        // Zero-copy: account bytes are the discriminator followed by the
        // struct's in-memory layout, which must have no padding.
        assert_eq!(std::mem::offset_of!(BidBook, batch_records), 0);
        assert_eq!(
            std::mem::size_of::<BidBook>(),
            64 * PAGE_BATCHES + 16 * PAGE_BATCHES + 8 * PAGE_BIDS_USIZE + 32 + 4 * PAGE_BIDS_USIZE
        );
        // A page is small enough to create from a program (10 KiB at most).
        assert!(8 + std::mem::size_of::<BidBook>() <= 10_240);
        // The app reads deposits and clearing sizes at these offsets.
        assert_eq!(std::mem::offset_of!(BidBook, deposits), 80 * PAGE_BATCHES);
        assert_eq!(
            std::mem::offset_of!(BidBook, clearing_quantities),
            80 * PAGE_BATCHES + 8 * PAGE_BIDS_USIZE + 32
        );
        assert!(std::mem::align_of::<BidBook>() <= 8);
        // A batch's two ciphertexts sit side by side, as the circuits read
        // them in place.
        let mut book: BidBook = bytemuck::Zeroable::zeroed();
        book.batch_records[0] = [[1u8; 32], [3u8; 32]];
        book.batch_records[PAGE_BATCHES - 1] = [[2u8; 32], [4u8; 32]];
        let bytes = bytemuck::bytes_of(&book);
        let first = BATCH_RECORDS_OFFSET as usize - 8;
        let last = first + (PAGE_BATCHES - 1) * BATCH_RECORD_LEN as usize;
        assert_eq!(&bytes[first..first + 64], [[1u8; 32], [3u8; 32]].concat());
        assert_eq!(&bytes[last..last + 64], [[2u8; 32], [4u8; 32]].concat());
    }

    // -- token auctions -----------------------------------------------------

    /// A token auction selling `supply` base units at prices per `unit`.
    fn token_auction(supply: u64, unit: u64, min_price: u32) -> Auction {
        Auction {
            supply,
            price_unit: unit,
            min_price,
            min_deposit: 1,
            status: AuctionStatus::Open,
            ..blank_auction()
        }
    }

    /// The auction after a clearing result, as the callback stores it.
    fn cleared(mut auction: Auction, price: u32, above: u128, at: u128) -> Auction {
        let filled = clearing_is_consistent(&auction, price, above, at).unwrap();
        auction.clearing_price = if filled { price } else { auction.min_price };
        auction.filled = filled;
        auction.weight_above = above;
        auction.weight_at = if filled { at } else { 0 };
        auction.status = AuctionStatus::Settling;
        auction
    }

    #[test]
    fn token_winners_buy_with_their_budgets_at_the_clearing_price() {
        // 1_000 base units, prices per 10 base units. Budgets 500 at 10, 300
        // at 8 and 400 at 5 clear at 8 (800 = 100 * 8 lamports of budget).
        let a = cleared(token_auction(1_000, 10, 1), 8, 500, 300);
        assert!(a.filled);
        // Above: all its budget buys, 500 * 10 / 8 = 625, for all of it.
        assert_eq!(token_award(&a, OUTCOME_ABOVE, 500).unwrap(), (625, 500));
        // At: what is left, 1_000 - 625 = 375, for 300.
        assert_eq!(token_award(&a, OUTCOME_AT, 300).unwrap(), (375, 300));
        // Below: nothing.
        assert_eq!(token_award(&a, OUTCOME_NONE, 400).unwrap(), (0, 0));
    }

    #[test]
    fn token_bids_above_share_the_supply_when_they_can_buy_it_all() {
        // One budget of 500 at a high price clears at 5: it buys everything.
        let a = cleared(token_auction(1_000, 10, 1), 5, 500, 0);
        assert_eq!(token_award(&a, OUTCOME_ABOVE, 500).unwrap(), (1_000, 500));
        // Two budgets above that more than buy the supply at 7 share it.
        let a = cleared(token_auction(1_000, 10, 1), 7, 750, 0);
        assert_eq!(token_award(&a, OUTCOME_ABOVE, 500).unwrap(), (666, 467));
        assert_eq!(token_award(&a, OUTCOME_ABOVE, 250).unwrap(), (333, 234));
        // A bid at that price is then shut out.
        let a = cleared(token_auction(1_000, 10, 1), 7, 750, 200);
        assert_eq!(token_award(&a, OUTCOME_AT, 200).unwrap(), (0, 0));
    }

    #[test]
    fn token_bids_at_the_clearing_price_share_by_budget() {
        // Two bids of 500 at exactly 10 buy 1_000 base units at 10 per 10.
        let a = cleared(token_auction(1_000, 10, 1), 10, 0, 1_000);
        assert_eq!(token_award(&a, OUTCOME_AT, 500).unwrap(), (500, 500));
        // 600 above and 900 at 10: 600 buys 600, 400 are left for 900 of
        // budget, shared 2:1, never more than a budget affords.
        let a = cleared(token_auction(1_000, 10, 1), 10, 600, 900);
        assert_eq!(token_award(&a, OUTCOME_ABOVE, 600).unwrap(), (600, 600));
        assert_eq!(token_award(&a, OUTCOME_AT, 600).unwrap(), (266, 266));
        assert_eq!(token_award(&a, OUTCOME_AT, 300).unwrap(), (133, 133));
    }

    #[test]
    fn token_auctions_that_do_not_fill_sell_at_the_minimum_price() {
        // 50 lamports cannot buy 1_000 base units at 10 per 10.
        let a = cleared(token_auction(1_000, 10, 10), 0, 50, 0);
        assert!(!a.filled);
        assert_eq!(a.clearing_price, 10);
        assert_eq!(token_award(&a, OUTCOME_ABOVE, 50).unwrap(), (50, 50));
        assert_eq!(token_award(&a, OUTCOME_NONE, 50).unwrap(), (0, 0));
        // Only bids above can win without a fill.
        assert!(token_award(&a, OUTCOME_AT, 50).is_err());
    }

    #[test]
    fn token_payments_round_up_but_never_exceed_the_budget() {
        // 7 lamports per 3 base units: a budget of 10 buys all 4 base units
        // for sale (9.33 lamports), paying 10.
        let a = cleared(token_auction(4, 3, 1), 7, 10, 0);
        let (won, paid) = token_award(&a, OUTCOME_ABOVE, 10).unwrap();
        assert_eq!((won, paid), (4, 10));
        assert!(paid as u128 * 3 >= won as u128 * 7);
        // 9 base units at 7 per 3 cost 21 lamports exactly.
        let a = cleared(token_auction(9, 3, 1), 7, 0, 21);
        assert_eq!(token_award(&a, OUTCOME_AT, 21).unwrap(), (9, 21));
        // A share smaller than the budget affords pays only for itself.
        let a = cleared(token_auction(1_000, 3, 1), 7, 0, 2_400);
        assert_eq!(token_award(&a, OUTCOME_AT, 21).unwrap(), (8, 19));
        // Extremes stay inside u128.
        let a = Auction {
            filled: true,
            clearing_price: u32::MAX,
            weight_above: u64::MAX as u128 * MAX_BIDS as u128,
            ..token_auction(u64::MAX, MAX_PRICE_UNIT, 1)
        };
        assert!(token_award(&a, OUTCOME_ABOVE, u64::MAX).is_ok());
    }

    #[test]
    fn token_clearing_results_are_checked() {
        let a = token_auction(1_000, 10, 1);
        // Covers at 8, not at 9.
        assert!(clearing_is_consistent(&a, 8, 500, 300).unwrap());
        // Demand at the price must cover the supply...
        assert!(clearing_is_consistent(&a, 8, 500, 299).is_err());
        // ...and the demand above it must not cover it a price higher.
        assert!(clearing_is_consistent(&a, 8, 900, 0).is_err());
        // Without a fill, all valid demand falls short at the minimum price.
        let b = token_auction(1_000, 10, 10);
        assert!(!clearing_is_consistent(&b, 0, 99 * 10 / 10, 0).unwrap());
        assert!(clearing_is_consistent(&b, 9, 1_000, 0).is_err());
    }

    // -- collection auctions ------------------------------------------------

    fn collection_auction(supply: u64, max_per_bid: u16) -> Auction {
        Auction {
            kind: AuctionKind::Collection,
            supply,
            price_scale: NFT_PRICE_SCALE,
            min_price: 100,
            max_per_bid,
            ..blank_auction()
        }
    }

    #[test]
    fn collection_clearing_results_are_checked() {
        let a = collection_auction(5, 3);
        assert!(clearing_is_consistent(&a, 200, 4, 3).unwrap());
        assert!(clearing_is_consistent(&a, 200, 5, 3).is_err()); // above covers it
        assert!(clearing_is_consistent(&a, 200, 2, 2).is_err()); // at does not reach it
        assert!(!clearing_is_consistent(&a, 0, 4, 0).unwrap()); // never covered
        assert!(clearing_is_consistent(&a, 0, 5, 0).is_err());
    }

    #[test]
    fn full_fills_and_losses_follow_the_revealed_outcome() {
        let a = collection_auction(100, 30);
        assert_eq!(collection_fill(&a, OUTCOME_ABOVE, 30).unwrap(), 30);
        assert_eq!(collection_fill(&a, OUTCOME_NONE, 0).unwrap(), 0);
        assert!(collection_fill(&a, OUTCOME_NONE, 5).is_err());
        assert!(collection_fill(&a, OUTCOME_ABOVE, 0).is_err());
        assert!(collection_fill(&a, OUTCOME_ABOVE, 31).is_err());
        // Bids at the clearing price go through `finalize_share` instead.
        assert!(collection_fill(&a, OUTCOME_AT, 5).is_err());
        assert!(collection_fill(&a, 3, 5).is_err());
        let priced = Auction { clearing_price: 1_500, ..a };
        assert_eq!(nft_payment(&priced, 3).unwrap(), 3 * 1_500 * NFT_PRICE_SCALE);
    }

    /// Sizes by bid index across every page, as `finalize_share` gathers
    /// them.
    fn clearing_book(sizes: &[(usize, u32)]) -> Vec<u32> {
        let mut quantities = vec![0u32; MAX_BIDS as usize];
        for &(index, size) in sizes {
            quantities[index] = size;
        }
        quantities
    }

    /// (bid index, share) of every bid at the clearing price.
    fn all_shares(sizes: &[u32], remaining: u64, total: u64) -> Vec<(usize, u64)> {
        sizes
            .iter()
            .enumerate()
            .filter(|(_, &size)| size > 0)
            .map(|(i, _)| (i, clearing_share(sizes, i as u32, remaining, total).unwrap()))
            .collect()
    }

    #[test]
    fn clearing_shares_sell_every_nft_and_favour_earlier_bids() {
        // Three NFTs and four bids of one at the clearing price: the three
        // earliest win one each. Rounding down alone would sell none.
        let sizes = clearing_book(&[(2, 1), (5, 1), (9, 1), (11, 1)]);
        assert_eq!(all_shares(&sizes, 3, 4), vec![(2, 1), (5, 1), (9, 1), (11, 0)]);
        // Seven NFTs left for three bids of five: 2.33 each.
        let sizes = clearing_book(&[(0, 5), (3, 5), (7, 5)]);
        assert_eq!(all_shares(&sizes, 7, 15), vec![(0, 3), (3, 2), (7, 2)]);
        // Twenty left for 30 + 20 + 10: 10, 6.67 and 3.33; the earliest bid
        // (index 1) gets the NFT lost to rounding.
        let sizes = clearing_book(&[(3, 30), (1, 20), (8, 10)]);
        assert_eq!(all_shares(&sizes, 20, 60), vec![(1, 7), (3, 10), (8, 3)]);
        // Enough for everyone: every bid gets exactly its size.
        let sizes = clearing_book(&[(1, 4), (4, 6)]);
        assert_eq!(all_shares(&sizes, 10, 10), vec![(1, 4), (4, 6)]);
        // The largest sizes stay inside u64.
        let big = MAX_COLLECTION_SIZE as u32;
        let sizes = clearing_book(&[(0, big), (1_023, big)]);
        let shares = all_shares(&sizes, MAX_COLLECTION_SIZE, 2 * MAX_COLLECTION_SIZE);
        assert_eq!(shares, vec![(0, MAX_COLLECTION_SIZE / 2), (1_023, MAX_COLLECTION_SIZE / 2)]);
        // Bids on later pages come later: one NFT left for bids on pages 0
        // and 2 goes to the one on page 0.
        let sizes = clearing_book(&[(600, 1), (17, 1)]);
        assert_eq!(all_shares(&sizes, 1, 2), vec![(17, 1), (600, 0)]);
    }

    #[test]
    fn clearing_shares_add_up_for_any_split() {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for _ in 0..500 {
            let mut sizes = vec![0u32; MAX_BIDS as usize];
            let mut total = 0u64;
            for _ in 0..(next() % 40 + 1) {
                let index = (next() % MAX_BIDS as u64) as usize;
                if sizes[index] == 0 {
                    sizes[index] = (next() % 1_000 + 1) as u32;
                    total += sizes[index] as u64;
                }
            }
            let remaining = next() % total + 1;
            let mut sum = 0;
            for (index, &size) in sizes.iter().enumerate() {
                if size == 0 {
                    continue;
                }
                let share = clearing_share(&sizes, index as u32, remaining, total).unwrap();
                let floor = size as u64 * remaining / total;
                assert!(share == floor || share == floor + 1);
                assert!(share <= size as u64);
                sum += share;
            }
            assert_eq!(sum, remaining);
        }
    }

    #[test]
    fn clearing_shares_wait_for_every_bid_at_the_price() {
        let sizes = clearing_book(&[(0, 5), (3, 5)]);
        // A third bid of five at the price is still sealed.
        assert!(clearing_share(&sizes, 0, 7, 15).is_err());
        // A bid that is not at the price has no share.
        assert!(clearing_share(&sizes, 1, 5, 10).is_err());
        assert!(clearing_share(&sizes, 300, 5, 10).is_err());
        // Inconsistent clearing results.
        assert!(clearing_share(&sizes, 0, 0, 10).is_err());
        assert!(clearing_share(&sizes, 0, 11, 10).is_err());
    }

    #[test]
    fn the_last_bid_at_the_clearing_price_reserves_what_is_left() {
        // 100 NFTs, 80 wanted above the clearing price (50 of them settled so
        // far), 60 wanted at it.
        let mut a = Auction {
            status: AuctionStatus::Settling,
            filled: true,
            weight_above: 80,
            weight_at: 60,
            sold: 50,
            ..collection_auction(100, 40)
        };
        record_clearing_quantity(&mut a, 25).unwrap();
        assert_eq!((a.at_revealed, a.sold), (25, 50));
        assert!(!shares_are_final(&a));
        record_clearing_quantity(&mut a, 35).unwrap();
        assert_eq!((a.at_revealed, a.sold), (60, 70));
        assert!(shares_are_final(&a));
        a.status = AuctionStatus::Finished;
        assert!(shares_are_final(&a));
        // Nothing more can show up at the price.
        assert!(record_clearing_quantity(&mut a, 1).is_err());
        // An auction that did not fill has no clearing price to share.
        let mut b = Auction {
            status: AuctionStatus::Settling,
            weight_above: 30,
            ..collection_auction(100, 40)
        };
        assert!(record_clearing_quantity(&mut b, 1).is_err());
        assert!(!shares_are_final(&b));
        // Nor does a token auction.
        let c = Auction { kind: AuctionKind::Token, ..a };
        assert!(!shares_are_final(&c));
    }

    // -- terms --------------------------------------------------------------

    #[test]
    fn token_terms_are_checked() {
        let good = TokenSaleTerms {
            supply: 1_000,
            price_unit: 1_000_000,
            min_price: 25_000,
            min_deposit: 10_000_000,
            duration_secs: 600,
            start_time: 0,
        };
        assert_eq!(good.check(100).unwrap(), (100, 700));
        for unit in [1, 10, MAX_PRICE_UNIT] {
            assert!(TokenSaleTerms { price_unit: unit, ..good }.check(0).is_ok());
        }
        let bad = [
            TokenSaleTerms { supply: 0, ..good },
            TokenSaleTerms { price_unit: 0, ..good },
            TokenSaleTerms { price_unit: 20, ..good },
            TokenSaleTerms { price_unit: 999, ..good },
            TokenSaleTerms { price_unit: MAX_PRICE_UNIT * 10, ..good },
            TokenSaleTerms { min_price: 0, ..good },
            TokenSaleTerms { min_deposit: 0, ..good },
            TokenSaleTerms { duration_secs: MIN_DURATION_SECS - 1, ..good },
            TokenSaleTerms { duration_secs: MAX_DURATION_SECS + 1, ..good },
        ];
        for terms in bad.iter() {
            assert!(terms.check(0).is_err(), "{terms:?}");
        }
    }

    #[test]
    fn collection_sale_terms_are_checked() {
        let good = CollectionSaleTerms {
            supply: 100,
            min_price: 1,
            max_per_bid: 5,
            duration_secs: 600,
            start_time: 0,
        };
        assert!(good.check(0).is_ok());
        assert!(CollectionSaleTerms { max_per_bid: 100, ..good }.check(0).is_ok());
        let bad = [
            CollectionSaleTerms { supply: 0, ..good },
            CollectionSaleTerms { supply: MAX_COLLECTION_SIZE + 1, ..good },
            CollectionSaleTerms { min_price: 0, ..good },
            CollectionSaleTerms { max_per_bid: 0, ..good },
            CollectionSaleTerms { max_per_bid: 101, ..good },
            CollectionSaleTerms { duration_secs: 0, ..good },
        ];
        for terms in bad.iter() {
            assert!(terms.check(0).is_err(), "{terms:?}");
        }
    }

    #[test]
    fn crank_fees_cover_every_step() {
        let rewards = CrankRewards {
            check_batch: 6_000_001,
            clearing: 25_000_000,
            settlement: 4_000_000,
            seed_draw: 3_000_000,
        };
        // A bid's quarter of a check is rounded up.
        assert_eq!(bid_crank_fee(&rewards), 1_500_001 + 4_000_000);
        let mut auction = blank_auction();
        auction.crank_rewards = rewards;
        assert_eq!(seller_crank_fee(&auction), 25_000_000 + 6_000_001);
        auction.kind = AuctionKind::Collection;
        assert_eq!(seller_crank_fee(&auction), 25_000_000 + 6_000_001 + 3_000_000);
        // With n bids on the pages they need, the pool covers ceil(n / 4)
        // checks, n settlements, the clearing (one step, or the paged steps)
        // and the draw.
        for n in 1..=MAX_BIDS as u64 {
            let pages = n.div_ceil(PAGE_BIDS as u64) as u8;
            let page_fees: u64 = (1..pages).map(|page| page_crank_fee(&rewards, page)).sum();
            let pool = seller_crank_fee(&auction) + page_fees + n * bid_crank_fee(&rewards);
            let clearing = if pages == 1 {
                rewards.clearing
            } else {
                fold_total_steps(pages) as u64 * fold_reward(&rewards)
            };
            let needed = n.div_ceil(BATCH_SIZE as u64) * rewards.check_batch
                + n * rewards.settlement
                + clearing
                + rewards.seed_draw;
            assert!(pool >= needed, "{n} bids");
        }
        // Two pages take nine steps and every further page eight.
        assert_eq!(page_crank_fee(&rewards, 1), 9 * fold_reward(&rewards));
        assert_eq!(page_crank_fee(&rewards, 2), 8 * fold_reward(&rewards));
        assert_eq!(page_crank_fee(&rewards, 3), 8 * fold_reward(&rewards));
        assert_eq!(bid_crank_fee(&CrankRewards::default()), 0);
    }

    #[test]
    fn bidding_can_be_scheduled_up_to_the_limit() {
        let now = 1_000_000;
        // Right away: 0, a past time or now itself.
        for start in [0, now - 50, now] {
            assert_eq!(bidding_window(start, 600, now).unwrap(), (now, now + 600));
        }
        assert_eq!(bidding_window(now + 3_600, 600, now).unwrap(), (now + 3_600, now + 4_200));
        let latest = now + MAX_START_DELAY_SECS;
        assert_eq!(
            bidding_window(latest, MAX_DURATION_SECS, now).unwrap(),
            (latest, latest + MAX_DURATION_SECS)
        );
        assert!(bidding_window(latest + 1, 600, now).is_err());
        assert!(bidding_window(i64::MAX, 600, now).is_err());
        assert!(bidding_window(now + 60, MIN_DURATION_SECS - 1, now).is_err());
        let scheduled = CollectionSaleTerms {
            supply: 10,
            min_price: 1,
            max_per_bid: 1,
            duration_secs: 600,
            start_time: now + 90,
        };
        assert_eq!(scheduled.check(now).unwrap(), (now + 90, now + 690));
    }

    #[test]
    fn expected_terms_must_match_exactly() {
        let auction = Auction {
            mint: Pubkey::new_from_array([5u8; 32]),
            supply: 1_000,
            price_unit: 100,
            price_scale: 1,
            min_price: 2_500,
            min_deposit: 10_000,
            max_per_bid: 0,
            end_time: 1_234,
            ..blank_auction()
        };
        let terms = ExpectedTerms {
            mint: auction.mint,
            supply: 1_000,
            price_unit: 100,
            price_scale: 1,
            min_price: 2_500,
            min_deposit: 10_000,
            max_per_bid: 0,
            end_time: 1_234,
        };
        assert!(terms.matches(&auction));
        let changed = [
            ExpectedTerms { mint: Pubkey::default(), ..terms },
            ExpectedTerms { supply: 999, ..terms },
            ExpectedTerms { price_unit: 10, ..terms },
            ExpectedTerms { price_scale: 1_000, ..terms },
            ExpectedTerms { min_price: 2_501, ..terms },
            ExpectedTerms { min_deposit: 9_999, ..terms },
            ExpectedTerms { max_per_bid: 1, ..terms },
            ExpectedTerms { end_time: 1_235, ..terms },
        ];
        for t in changed.iter() {
            assert!(!t.matches(&auction));
        }
    }

    // -- fees and collections -----------------------------------------------

    #[test]
    fn sale_fee_rounds_down_and_never_exceeds_the_proceeds() {
        assert_eq!(sale_fee(1_000_000_000, 100), 10_000_000); // 1% of 1 SOL
        assert_eq!(sale_fee(199, 100), 1);
        assert_eq!(sale_fee(99, 100), 0);
        assert_eq!(sale_fee(12_345, 0), 0);
        assert_eq!(sale_fee(u64::MAX, MAX_SALE_FEE_BPS), u64::MAX / 20);
        assert_eq!(sale_fee(1_000, u16::MAX), 1_000);
    }

    fn collection_terms() -> CollectionTerms {
        CollectionTerms {
            name: "Veiling Cats".into(),
            uri: "https://example.com/collection.json".into(),
            item_name: "Veiling Cat".into(),
            item_uri: "ipfs://bafybeigdyrzt/".into(),
            uri_per_item: true,
            royalty_bps: 500,
            hidden: false,
        }
    }

    #[test]
    fn collection_terms_are_checked() {
        let good = collection_terms();
        assert!(good.check().is_ok());
        let too_long_uri = format!("https://{}", "a".repeat(MAX_URI_LEN));
        let bad = [
            CollectionTerms { name: "".into(), ..good.clone() },
            CollectionTerms { name: "   ".into(), ..good.clone() },
            CollectionTerms { name: "x".repeat(MAX_COLLECTION_NAME_LEN + 1), ..good.clone() },
            CollectionTerms { item_name: "y".repeat(MAX_ITEM_NAME_LEN + 1), ..good.clone() },
            CollectionTerms { item_name: "Cat\n".into(), ..good.clone() },
            CollectionTerms { item_name: "Cat\u{202e}god".into(), ..good.clone() },
            CollectionTerms { name: "Cats\u{200b}".into(), ..good.clone() },
            CollectionTerms { uri: "http://example.com/c.json".into(), ..good.clone() },
            CollectionTerms { uri: "javascript:alert(1)".into(), ..good.clone() },
            CollectionTerms { uri: "https://".into(), ..good.clone() },
            CollectionTerms { item_uri: "https://a b/".into(), ..good.clone() },
            CollectionTerms { item_uri: too_long_uri, ..good.clone() },
            CollectionTerms { royalty_bps: MAX_ROYALTY_BPS + 1, ..good.clone() },
        ];
        for terms in bad.iter() {
            assert!(terms.check().is_err(), "{terms:?}");
        }
        // Limits are inclusive and count bytes, so non-ASCII names work.
        let longest = CollectionTerms {
            name: "x".repeat(MAX_COLLECTION_NAME_LEN),
            item_name: "y".repeat(MAX_ITEM_NAME_LEN),
            uri: format!("ar://{}", "a".repeat(MAX_URI_LEN - 5)),
            royalty_bps: MAX_ROYALTY_BPS,
            ..good.clone()
        };
        assert!(longest.check().is_ok());
        let turkish = CollectionTerms { name: "Gizli Kediler ğüşıöç".into(), ..good };
        assert!(turkish.check().is_ok());
    }

    #[test]
    fn nft_names_and_metadata_follow_their_index() {
        assert_eq!(nft_name("Veiling Cat", 0), "Veiling Cat #1");
        assert_eq!(nft_name("Veiling Cat", 9_999), "Veiling Cat #10000");
        assert_eq!(nft_uri("https://x.io/meta/", 0, true), "https://x.io/meta/0.json");
        assert_eq!(nft_uri("https://x.io/meta/", 41, true), "https://x.io/meta/41.json");
        assert_eq!(nft_uri("https://x.io/one.json", 41, false), "https://x.io/one.json");
        let mut digits = String::new();
        push_decimal(&mut digits, u32::MAX);
        assert_eq!(digits, "4294967295");
        let longest = nft_name(&"n".repeat(MAX_ITEM_NAME_LEN), (MAX_COLLECTION_SIZE - 1) as u32);
        assert!(longest.len() <= 32);
    }


    #[test]
    fn core_instruction_data_is_borsh_encoded() {
        // CreateV1 { data_state: AccountState, name, uri, plugins: None }
        let expected = [&[0u8, 0][..], &4u32.to_le_bytes(), b"A #1", &1u32.to_le_bytes(), b"u", &[0]];
        assert_eq!(core_create_asset_data("A #1", "u"), expected.concat());
        // CreateCollectionV1 { name, uri, plugins: None }
        let expected = [&[1u8][..], &1u32.to_le_bytes(), b"C", &9u32.to_le_bytes(), b"https://c", &[0]];
        assert_eq!(
            core_create_collection_data("C", "https://c", 0, &Pubkey::default()),
            expected.concat()
        );
        // plugins: Some([Royalties { 500, [creator: 100%], RuleSet::None }
        // with no explicit authority])
        let creator = Pubkey::new_from_array([7u8; 32]);
        let expected = [
            &[1u8][..],
            &1u32.to_le_bytes(),
            b"C",
            &9u32.to_le_bytes(),
            b"https://c",
            &[1],
            &1u32.to_le_bytes(),
            &[0],
            &500u16.to_le_bytes(),
            &1u32.to_le_bytes(),
            creator.as_ref(),
            &[100, 0, 0],
        ];
        assert_eq!(
            core_create_collection_data("C", "https://c", 500, &creator),
            expected.concat()
        );
        // UpdateCollectionV1 { new_name: None, new_uri: None }
        assert_eq!(core_update_collection_data(), vec![16, 0, 0]);
    }


    #[test]
    fn bid_nonce_is_bound_to_the_bid_address() {
        // Cross-checked against an independent sha256 implementation; the
        // browser and the tests derive the same value.
        let bid = Pubkey::new_from_array([7u8; 32]);
        assert_eq!(bid_nonce(&bid), BID_NONCE_FOR_SEVENS);
        let other = Pubkey::new_from_array([8u8; 32]);
        assert_ne!(bid_nonce(&bid), bid_nonce(&other));
    }

    #[test]
    fn only_canonical_field_elements_pass() {
        let mut below = FIELD_MODULUS_LE;
        below[0] -= 1; // p - 1
        assert!(is_canonical_field_element(&[0u8; 32]));
        assert!(is_canonical_field_element(&below));
        assert!(!is_canonical_field_element(&FIELD_MODULUS_LE)); // p
        assert!(!is_canonical_field_element(&[0xff; 32])); // 2^255 - 1
        let mut top_bit = [0u8; 32];
        top_bit[31] = 0x80; // 2^255
        assert!(!is_canonical_field_element(&top_bit));
    }

    // -- x25519 key checks --------------------------------------------------

    fn random_bytes(label: &[u8], i: u32) -> [u8; 32] {
        hashv(&[label, &i.to_le_bytes()]).to_bytes()
    }

    fn fe_bytes(fe: &field::Fe) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, limb) in fe.iter().enumerate() {
            out[8 * i..8 * i + 8].copy_from_slice(&limb.to_le_bytes());
        }
        out
    }

    /// a^(p-2), the inverse of a non-zero a, by square-and-multiply.
    fn fe_invert(a: &field::Fe) -> field::Fe {
        // p - 2 = 2^255 - 21, little-endian.
        let mut exponent = FIELD_MODULUS_LE;
        exponent[0] -= 2;
        let mut result: field::Fe = [1, 0, 0, 0];
        for byte in exponent.iter().rev() {
            for bit in (0..8).rev() {
                result = field::mul(&result, &result);
                if (byte >> bit) & 1 == 1 {
                    result = field::mul(&result, a);
                }
            }
        }
        result
    }

    /// The Edwards y-coordinate `(u - 1) / (u + 1)` a client sends with `u`.
    fn edwards_y_hint(u: &[u8; 32]) -> [u8; 32] {
        let u = field::from_bytes(u);
        let y = field::mul(&field::sub_small(&u, 1), &fe_invert(&field::add_small(&u, 1)));
        fe_bytes(&y)
    }

    fn honest_key(i: u32) -> [u8; 32] {
        MontgomeryPoint::mul_base_clamped(random_bytes(b"secret", i)).to_bytes()
    }

    #[test]
    fn field_arithmetic_matches_the_birational_map() {
        // For random curve points, Edwards y and Montgomery u computed by
        // curve25519-dalek must satisfy y * (u + 1) = u - 1.
        for i in 0..256 {
            let k = Scalar::from_bytes_mod_order(random_bytes(b"point", i));
            let point = ED25519_BASEPOINT_POINT * k;
            let u = field::from_bytes(&point.to_montgomery().to_bytes());
            let mut y = point.compress().to_bytes();
            y[31] &= 0x7f;
            let y = field::from_bytes(&y);
            assert_eq!(field::mul(&y, &field::add_small(&u, 1)), field::sub_small(&u, 1));
        }
        // Edge values: (p - 1)^2 = 1, 2 * (p + 1) / 2 = 1, and wrap-around
        // in both small helpers.
        let mut minus_one = FIELD_MODULUS_LE;
        minus_one[0] -= 1;
        let minus_one = field::from_bytes(&minus_one);
        assert_eq!(field::mul(&minus_one, &minus_one), [1, 0, 0, 0]);
        assert_eq!(field::mul(&minus_one, &[1, 0, 0, 0]), minus_one);
        let mut half = FIELD_MODULUS_LE;
        half[0] += 1; // p + 1, which is even; halve it
        let mut carry = 0u8;
        for byte in half.iter_mut().rev() {
            let next = *byte & 1;
            *byte = (*byte >> 1) | (carry << 7);
            carry = next;
        }
        assert_eq!(field::mul(&field::from_bytes(&half), &[2, 0, 0, 0]), [1, 0, 0, 0]);
        assert_eq!(field::sub_small(&[0, 0, 0, 0], 1), minus_one);
        assert_eq!(field::add_small(&minus_one, 1), [0, 0, 0, 0]);
        assert_eq!(fe_invert(&[2, 0, 0, 0]), field::from_bytes(&half));
    }

    #[test]
    fn subgroup_constants_are_right() {
        let l_minus_one = Scalar::ZERO - Scalar::ONE;
        assert_eq!(l_minus_one.to_bytes(), SUBGROUP_ORDER_MINUS_ONE);
        assert_eq!(EdwardsPoint::identity().compress().to_bytes(), EDWARDS_IDENTITY);
    }

    #[test]
    fn honest_keys_pass_only_with_their_own_edwards_y() {
        for i in 0..64 {
            let u = honest_key(i);
            let y = edwards_y_hint(&u);
            assert!(is_usable_x25519_key(&u, &y), "honest key {i} refused");
            // The hint matches what curve25519-dalek computes.
            let mut dalek_y = MontgomeryPoint(u).to_edwards(0).unwrap().compress().to_bytes();
            dalek_y[31] &= 0x7f;
            assert_eq!(y, dalek_y);
            // Any other y is refused.
            let mut wrong = y;
            wrong[0] ^= 1;
            assert!(!is_usable_x25519_key(&u, &wrong));
            assert!(!is_usable_x25519_key(&u, &edwards_y_hint(&honest_key(i + 1000))));
            // So is the same y in non-canonical form (y + p), when it fits.
            let y_plus_p = fe_bytes(&{
                let mut sum = field::from_bytes(&y);
                let p = field::from_bytes(&FIELD_MODULUS_LE);
                let mut carry = 0u128;
                for k in 0..4 {
                    let s = sum[k] as u128 + p[k] as u128 + carry;
                    sum[k] = s as u64;
                    carry = s >> 64;
                }
                sum
            });
            assert!(!is_usable_x25519_key(&u, &y_plus_p));
        }
    }

    #[test]
    fn refused_keys_stay_refused() {
        for key in REFUSED_KEYS.iter() {
            // p - 1 has no y hint (u + 1 = 0); any value must be refused.
            let y = if *key == REFUSED_KEYS[4] { [0u8; 32] } else { edwards_y_hint(key) };
            assert!(!is_usable_x25519_key(key, &y));
        }
        // RFC 7748 section 6.1: Alice's public key is fine.
        let alice: [u8; 32] = [
            0x85, 0x20, 0xf0, 0x09, 0x89, 0x30, 0xa7, 0x54, 0x74, 0x8b, 0x7d, 0xdc, 0xb4, 0x3e,
            0xf7, 0x5a, 0x0d, 0xbf, 0x3a, 0x0d, 0x26, 0x38, 0x1a, 0xf4, 0xeb, 0xa4, 0xa9, 0x8e,
            0xaa, 0x9b, 0x4e, 0x6a,
        ];
        assert!(is_usable_x25519_key(&alice, &edwards_y_hint(&alice)));
        let mut non_canonical = alice;
        non_canonical[31] |= 0x80;
        assert!(!is_usable_x25519_key(&non_canonical, &edwards_y_hint(&alice)));
    }

    #[test]
    fn twist_and_small_subgroup_keys_are_refused() {
        // Small u-coordinates: those not on the curve are on the twist.
        let mut twist = 0;
        for v in 2u8..=60 {
            let mut u = [0u8; 32];
            u[0] = v;
            if MontgomeryPoint(u).to_edwards(0).is_none() {
                assert!(!is_usable_x25519_key(&u, &edwards_y_hint(&u)), "twist u = {v}");
                twist += 1;
            }
        }
        assert!(twist > 10);
        // On the curve but outside the prime-order subgroup: an honest point
        // plus a torsion point.
        for i in 0..16u32 {
            let k = Scalar::from_bytes_mod_order(random_bytes(b"torsion", i));
            let honest = ED25519_BASEPOINT_POINT * k;
            for torsion in EIGHT_TORSION.iter().skip(1) {
                let point = honest + torsion;
                let u = point.to_montgomery().to_bytes();
                let y = edwards_y_hint(&u);
                assert!(!is_usable_x25519_key(&u, &y), "torsion key {i}");
            }
            let u = honest.to_montgomery().to_bytes();
            assert!(is_usable_x25519_key(&u, &edwards_y_hint(&u)));
        }
    }

    // -- eviction and terms -------------------------------------------------

    #[test]
    fn eviction_needs_a_ten_percent_larger_deposit() {
        assert_eq!(eviction_threshold(100).unwrap(), 110);
        assert_eq!(eviction_threshold(15).unwrap(), 17); // 1.5 rounds up
        assert_eq!(eviction_threshold(1).unwrap(), 2);
        assert_eq!(eviction_threshold(1_000_000_000).unwrap(), 1_100_000_000);
        assert!(eviction_threshold(u64::MAX).is_err());
    }


    // -- circuit pinning ----------------------------------------------------

    fn comp_def(source: CircuitSource, deactivation_slot: Option<u64>) -> ComputationDefinitionAccount {
        use arcium_client::idl::arcium::types::{ComputationDefinitionMeta, ComputationSignature};
        ComputationDefinitionAccount {
            deactivation_slot,
            cu_amount: 0,
            definition: ComputationDefinitionMeta {
                circuit_len: 0,
                signature: ComputationSignature {
                    parameters: vec![],
                    outputs: vec![],
                },
            },
            circuit_source: source,
            bump: 0,
            padding: [0u8; 24],
        }
    }

    #[test]
    fn only_the_pinned_active_circuit_may_run() {
        use arcium_client::idl::arcium::types::OnChainCircuitSource;
        let hash = [3u8; 32];
        let off_chain = |hash: [u8; 32]| {
            CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://example.com/c.arcis".to_string(),
                hash,
            })
        };
        assert!(require_pinned_circuit(&comp_def(off_chain(hash), None), hash).is_ok());
        assert!(require_pinned_circuit(&comp_def(off_chain([4u8; 32]), None), hash).is_err());
        assert!(require_pinned_circuit(&comp_def(off_chain(hash), Some(1)), hash).is_err());
        let on_chain = CircuitSource::OnChain(OnChainCircuitSource {
            is_completed: true,
            upload_auth: Pubkey::default(),
        });
        assert!(require_pinned_circuit(&comp_def(on_chain, None), hash).is_err());
    }

    #[test]
    fn computation_identity_reads_the_signed_slot_and_counter() {
        use arcium_client::idl::arcium::types::{ArgumentList, ComputationStatus, ExecutionFee};
        let serialize = |mxe_program_id: Pubkey| {
            let account = ComputationAccount {
                payer: Pubkey::new_from_array([1u8; 32]),
                mxe_program_id,
                computation_definition_offset: 42,
                execution_fee: ExecutionFee {
                    base_fee: 1,
                    priority_fee: 2,
                    callback_cu_limit: 3,
                    padding: 0,
                },
                slot: 123_456_789,
                slot_counter: 4_321,
                status: ComputationStatus::Queued,
                arguments: ArgumentList {
                    args: vec![],
                    byte_arrays: vec![],
                    plaintext_numbers: vec![],
                    values_128_bit: vec![],
                    accounts: vec![],
                },
                custom_callback_instructions: Vec::new(),
                callback_transactions_required: 1,
                callback_transactions_submitted_bm: 0,
                bump: 255,
            };
            let mut data = Vec::new();
            account.try_serialize(&mut data).unwrap();
            data
        };
        let key = Pubkey::new_from_array([9u8; 32]);
        let owner = ARCIUM_PROGRAM_ID;

        let mut data = serialize(crate::ID);
        let mut lamports = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        assert_eq!(computation_identity(&info).unwrap(), (123_456_789, 4_321));
        assert!(check_callback_computation(&info, &key, 123_456_789, 4_321).is_ok());
        assert!(check_callback_computation(&info, &key, 123_456_789, 4_322).is_err());
        assert!(check_callback_computation(&info, &Pubkey::default(), 123_456_789, 4_321).is_err());

        // A computation queued by another program is refused.
        let mut foreign = serialize(Pubkey::new_from_array([3u8; 32]));
        let mut lamports = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut foreign, &owner, false);
        assert!(computation_identity(&info).is_err());

        // So is an account not owned by Arcium.
        let mut data = serialize(crate::ID);
        let mut lamports = 0u64;
        let wrong_owner = Pubkey::new_from_array([4u8; 32]);
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &wrong_owner, false);
        assert!(computation_identity(&info).is_err());
    }

    // -- shuffling a collection's NFTs ---------------------------------------

    /// Every place gets a different NFT, whatever the supply and seed.
    #[test]
    fn the_shuffle_is_a_permutation() {
        let mut seed = 0x0123_4567_89ab_cdef_fedc_ba98_7654_3210u128;
        for supply in (1..=300u32).chain([511, 512, 513, 1_000, 4_097, 10_000]) {
            seed = seed.wrapping_mul(0x2545_f491_4f6c_dd1d).wrapping_add(supply as u128);
            let places: Vec<u32> = (0..supply).collect();
            let mut items = shuffled_items(&places, supply, seed).unwrap();
            items.sort_unstable();
            assert_eq!(items, places, "supply {supply}");
        }
        // Places can be worked out one at a time or together.
        let together = shuffled_items(&[3, 9, 4], 10, 77).unwrap();
        for (k, &place) in [3u32, 9, 4].iter().enumerate() {
            assert_eq!(shuffled_items(&[place], 10, 77).unwrap(), vec![together[k]]);
        }
        assert!(shuffled_items(&[10], 10, 77).is_err());
        assert!(shuffled_items(&[0], 0, 77).is_err());
    }

    /// The app and the crank compute the same numbers (`app/src/lib/shuffle.ts`
    /// checks these too).
    #[test]
    fn the_shuffle_matches_the_published_vectors() {
        let seed = 0x9e37_79b9_7f4a_7c15_f39c_c060_5ced_c834u128;
        let cases: [(u32, u32, u32); 6] = [
            (0, 1, 0),
            (0, 10, 7),
            (9, 10, 5),
            (0, 10_000, 7_090),
            (4_242, 10_000, 4_746),
            (9_999, 10_000, 1_327),
        ];
        for (place, supply, expected) in cases {
            assert_eq!(shuffled_items(&[place], supply, seed).unwrap(), vec![expected], "{place} of {supply}");
        }
    }

    /// Over many seeds, a place is about as likely to become any NFT.
    #[test]
    fn the_shuffle_spreads_places_evenly() {
        let supply = 10u32;
        let draws = 20_000u32;
        let mut counts = [0u32; 10];
        let mut seed = 1u128;
        for _ in 0..draws {
            seed = seed.wrapping_mul(0x2360_ed05_1fc6_5da4_4385_df64_9fcc_f645).wrapping_add(0x5851_f42d_4c95_7f2d);
            counts[shuffled_items(&[0], supply, seed).unwrap()[0] as usize] += 1;
        }
        let expected = (draws / supply) as f64;
        let chi2: f64 = counts.iter().map(|&c| (c as f64 - expected).powi(2) / expected).sum();
        // 9 degrees of freedom: above 27.9 happens by chance one time in a thousand.
        assert!(chi2 < 27.9, "chi-squared {chi2}, counts {counts:?}");
    }
}
