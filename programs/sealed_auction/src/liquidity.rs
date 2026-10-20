//! Auto-liquidity: after a token sale, part of the SOL raised and the matching
//! tokens open a Meteora DAMM v2 pool at exactly the clearing price. The pool
//! position is locked forever and its trading fees are split between the
//! seller and the platform.
//!
//! The seller opts in before any bid (`plan_liquidity`) with:
//! - `lp_bps`: share of the net proceeds (after the sale fee) that goes into
//!   the pool, from `MIN_LP_BPS` to 100%;
//! - `floor`: the least SOL the pool gets. The share is raised up to all the
//!   net proceeds to reach it; a sale whose net proceeds fall short of it
//!   fails at the clearing, and every bid is refunded (`refund_failed_bid`);
//! - `trade_fee_bps`: the pool's trading fee once the anti-sniper fee is over.
//!
//! The seller also escrows a reserve equal to the tokens for sale. The pool
//! takes as many of them as its SOL buys at the clearing price (never more
//! than were sold); the rest goes back to the seller.
//!
//! The pool and its position belong to a data-less address of this program
//! (`[LP_AUTHORITY_SEED, auction]`), which holds the reserve, pays the pool's
//! rent and owns the position NFT. No instruction ever withdraws liquidity.
//!
//! If the pool cannot be opened because someone created DAMM v2's pool for
//! this token and SOL first, the sale simply pays out without one.

use super::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_spl::token::{self as spl_token_cpi, Token};
use anchor_spl::token_interface::spl_token_2022::state::Account as SplTokenAccount;

pub const CP_AMM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

pub const LIQUIDITY_SEED: &[u8] = b"liquidity";
pub const LP_AUTHORITY_SEED: &[u8] = b"lp_authority";
pub const LIQUIDITY_DISCRIMINATOR: &[u8] = b"VLiqd_01";

/// `Auction::liquidity` states. Auctions opened before this module read 0.
pub const LIQUIDITY_NONE: u8 = 0;
/// Planned, waiting for the sale to settle.
pub const LIQUIDITY_PLANNED: u8 = 1;
/// The sale's net proceeds missed the floor: every bid is refunded.
pub const LIQUIDITY_FAILED: u8 = 2;
/// The pool is open and its position locked.
pub const LIQUIDITY_POOLED: u8 = 3;
/// No pool: the reserve went back to the seller.
pub const LIQUIDITY_RELEASED: u8 = 4;

/// Smallest share of the net proceeds a planned pool takes, in bps.
pub const MIN_LP_BPS: u16 = 2_000;
/// Trading fees a pool can settle at, in bps: 0.25%, 1% or 2%.
pub const POOL_FEE_TIERS: [u16; 3] = [25, 100, 200];
/// The anti-sniper fee: 50% when trading opens, falling linearly to the pool's
/// fee over 10 one-minute steps.
pub const ANTI_SNIPER_FEE_BPS: u16 = 5_000;
pub const ANTI_SNIPER_STEPS: u16 = 10;
pub const ANTI_SNIPER_STEP_SECS: u64 = 60;
/// The seller's share of the pool's trading fees; the platform gets the rest.
/// DAMM v2 keeps 20% of every trading fee as its protocol fee first.
pub const SELLER_POOL_FEE_BPS: u64 = 8_000;
/// Lamports the seller sends the pool authority with the plan: the pool's
/// rent (about 0.017 SOL) with room to spare. What the pool does not use
/// comes back when it opens.
pub const LP_RENT_DEPOSIT: u64 = 25_000_000;

/// DAMM v2 instruction discriminators.
const IX_INIT_CUSTOMIZABLE_POOL: [u8; 8] = [20, 161, 241, 24, 189, 221, 180, 2];
const IX_PERMANENT_LOCK: [u8; 8] = [165, 176, 125, 6, 231, 171, 186, 213];
const IX_CLAIM_POSITION_FEE: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];

/// Full price range of DAMM v2: the pool trades as x * y = k.
pub const MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;
const FEE_DENOMINATOR: u64 = 1_000_000_000;
const FEE_SCHEDULER_LINEAR: u8 = 0;
const ACTIVATION_BY_TIMESTAMP: u8 = 1;
/// Fees are collected in token B, SOL here.
const COLLECT_FEE_ONLY_B: u8 = 1;
/// Offset of `unlocked_liquidity` in a DAMM v2 `Position`.
const POSITION_UNLOCKED_LIQUIDITY: usize = 152;

/// A seller's auto-liquidity terms and, once opened, the pool. Kept after the
/// auction closes: it says where the pool's fees go.
#[account(discriminator = LIQUIDITY_DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct LiquidityPlan {
    pub auction: Pubkey,
    pub seller: Pubkey,
    /// Receives the platform's share of the pool's fees.
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub lp_bps: u16,
    pub floor: u64,
    pub trade_fee_bps: u16,
    /// Tokens escrowed for the pool.
    pub reserve: u64,
    /// What went into the pool.
    pub pool_sol: u64,
    pub pool_tokens: u64,
    pub pool: Pubkey,
    pub position: Pubkey,
    pub position_nft_mint: Pubkey,
    /// Pool fees paid out so far, in lamports.
    pub fees_to_seller: u64,
    pub fees_to_platform: u64,
    pub bump: u8,
    pub authority_bump: u8,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// The net proceeds (after the sale fee) a token sale cleared at the
/// auction's price will roughly raise; used at the clearing to decide whether
/// the floor can be met. A filled sale sells its whole supply at the clearing
/// price; an unfilled one spends every valid budget at the minimum price.
/// Rounding in the awards can make the real figure a few lamports lower; the
/// pool then takes all of it.
pub fn expected_net_proceeds(auction: &Auction) -> u64 {
    let gross = expected_gross_proceeds(auction);
    gross - sale_fee(gross, auction.sale_fee_bps)
}

/// What the winners of a token sale cleared at the auction's price will
/// roughly pay in all, before the sale fee (see `expected_net_proceeds`):
/// what the minimum raise (`Auction::min_raise`) is measured against.
pub fn expected_gross_proceeds(auction: &Auction) -> u64 {
    let gross = if auction.filled {
        auction.supply as u128 * auction.clearing_price as u128 / auction.price_unit.max(1) as u128
    } else {
        auction.weight_above
    };
    u64::try_from(gross).unwrap_or(u64::MAX)
}

/// Lamports the pool gets out of `net` proceeds: `lp_bps` of them, raised to
/// `floor`, and never more than `net`.
pub fn pool_sol(net: u64, lp_bps: u16, floor: u64) -> u64 {
    let share = (net as u128 * lp_bps as u128 / BPS_DENOMINATOR as u128) as u64;
    share.max(floor).min(net)
}

/// Base units `sol` lamports buy at `price` lamports per `unit` base units.
pub fn pool_tokens(sol: u64, price: u32, unit: u64) -> u64 {
    if price == 0 {
        return 0;
    }
    u64::try_from(sol as u128 * unit as u128 / price as u128).unwrap_or(u64::MAX)
}

/// sqrt(price) in Q64.64 for `price` lamports per `unit` base units, as
/// DAMM v2 takes it (token B, SOL, per base unit of token A).
pub fn sqrt_price_of(price: u32, unit: u64) -> u128 {
    // sqrt(price / unit) * 2^64 = sqrt(price * 2^128 / unit)
    U256::from_u128(price as u128).shl128().div_u128(unit.max(1) as u128).isqrt()
}

/// The full-range liquidity at `sqrt_price` that uses all of one side, `sol`
/// lamports or `tokens` base units, and no more than the other. None when
/// the price is outside DAMM v2's range or either side is empty.
pub fn pool_shape(sqrt_price: u128, sol: u64, tokens: u64) -> Option<(u128, u128)> {
    if sol == 0 || tokens == 0 || sqrt_price <= MIN_SQRT_PRICE || sqrt_price >= MAX_SQRT_PRICE {
        return None;
    }
    // SOL side: L = sol * 2^128 / (sqrt_price - min). Token side: L <= tokens * sqrt_price.
    let from_sol = U256::from_u128(sol as u128)
        .shl128()
        .div_u128(sqrt_price - MIN_SQRT_PRICE)
        .to_u128()?;
    let from_tokens = (tokens as u128).checked_mul(sqrt_price)?;
    Some((sqrt_price, from_sol.min(from_tokens)))
}

/// A DAMM v2 fee numerator (over 10^9) for `bps`.
fn fee_numerator(bps: u16) -> u64 {
    bps as u64 * FEE_DENOMINATOR / BPS_DENOMINATOR
}

/// Borsh `InitializeCustomizablePoolParameters` for DAMM v2.
pub fn init_pool_data(trade_fee_bps: u16, sqrt_price: u128, liquidity: u128) -> Vec<u8> {
    let base = fee_numerator(trade_fee_bps);
    let cliff = fee_numerator(ANTI_SNIPER_FEE_BPS);
    let reduction = (cliff - base) / ANTI_SNIPER_STEPS as u64;
    let mut data = IX_INIT_CUSTOMIZABLE_POOL.to_vec();
    // BaseFeeParameters: a linear fee time scheduler (27 bytes).
    data.extend_from_slice(&cliff.to_le_bytes());
    data.extend_from_slice(&ANTI_SNIPER_STEPS.to_le_bytes());
    data.extend_from_slice(&ANTI_SNIPER_STEP_SECS.to_le_bytes());
    data.extend_from_slice(&reduction.to_le_bytes());
    data.push(FEE_SCHEDULER_LINEAR);
    data.extend_from_slice(&0u16.to_le_bytes()); // compounding_fee_bps
    data.push(0); // padding
    data.push(0); // dynamic_fee: None
    data.extend_from_slice(&MIN_SQRT_PRICE.to_le_bytes());
    data.extend_from_slice(&MAX_SQRT_PRICE.to_le_bytes());
    data.push(0); // has_alpha_vault
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&sqrt_price.to_le_bytes());
    data.push(ACTIVATION_BY_TIMESTAMP);
    data.push(COLLECT_FEE_ONLY_B);
    data.push(0); // activation_point: None, trading opens now
    data
}

/// DAMM v2 addresses for a token paired with SOL.
pub fn damm_pool_address(mint: &Pubkey) -> Pubkey {
    let (hi, lo) = if mint.to_bytes() > WSOL_MINT.to_bytes() { (mint, &WSOL_MINT) } else { (&WSOL_MINT, mint) };
    Pubkey::find_program_address(&[b"cpool", hi.as_ref(), lo.as_ref()], &CP_AMM_ID).0
}

pub fn damm_vault_address(mint: &Pubkey, pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"token_vault", mint.as_ref(), pool.as_ref()], &CP_AMM_ID).0
}

pub fn damm_position_addresses(nft_mint: &Pubkey) -> (Pubkey, Pubkey) {
    (
        Pubkey::find_program_address(&[b"position", nft_mint.as_ref()], &CP_AMM_ID).0,
        Pubkey::find_program_address(&[b"position_nft_account", nft_mint.as_ref()], &CP_AMM_ID).0,
    )
}

pub fn damm_pool_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"pool_authority"], &CP_AMM_ID).0
}

pub fn damm_event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &CP_AMM_ID).0
}

/// The authority's SOL account.
fn check_lp_wsol(lp_wsol: &Pubkey, lp_authority: &Pubkey) -> Result<()> {
    require_keys_eq!(
        *lp_wsol,
        anchor_spl::associated_token::get_associated_token_address(lp_authority, &WSOL_MINT),
        AuctionError::WrongPoolAccounts
    );
    Ok(())
}

/// The DAMM v2 accounts `bootstrap_liquidity` passes on.
#[allow(clippy::too_many_arguments)]
fn check_pool_accounts(
    mint: &Pubkey,
    nft_mint: &Pubkey,
    pool: &Pubkey,
    position: &Pubkey,
    nft_account: &Pubkey,
    vault_a: &Pubkey,
    vault_b: &Pubkey,
    pool_authority: &Pubkey,
    event_authority: &Pubkey,
) -> Result<()> {
    let (expected_position, expected_nft_account) = damm_position_addresses(nft_mint);
    let expected_pool = damm_pool_address(mint);
    let ok = *pool == expected_pool
        && *position == expected_position
        && *nft_account == expected_nft_account
        && *vault_a == damm_vault_address(mint, &expected_pool)
        && *vault_b == damm_vault_address(&WSOL_MINT, &expected_pool)
        && *pool_authority == damm_pool_authority()
        && *event_authority == damm_event_authority();
    require!(ok, AuctionError::WrongPoolAccounts);
    Ok(())
}

/// A minimal unsigned 256-bit integer for the pool math.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct U256 {
    hi: u128,
    lo: u128,
}

impl U256 {
    pub fn from_u128(v: u128) -> Self {
        Self { hi: 0, lo: v }
    }
    fn shl128(self) -> Self {
        Self { hi: self.lo, lo: 0 }
    }
    fn to_u128(self) -> Option<u128> {
        (self.hi == 0).then_some(self.lo)
    }
    fn bit(&self, i: u32) -> bool {
        if i >= 128 {
            (self.hi >> (i - 128)) & 1 == 1
        } else {
            (self.lo >> i) & 1 == 1
        }
    }
    fn shl1(self) -> Self {
        Self { hi: (self.hi << 1) | (self.lo >> 127), lo: self.lo << 1 }
    }
    fn sub(self, o: Self) -> Self {
        let (lo, borrow) = self.lo.overflowing_sub(o.lo);
        Self { hi: self.hi - o.hi - borrow as u128, lo }
    }
    /// Long division by a non-zero u128.
    fn div_u128(self, d: u128) -> Self {
        let d = U256::from_u128(d);
        let mut q = U256::from_u128(0);
        let mut r = U256::from_u128(0);
        for i in (0..256).rev() {
            r = r.shl1();
            if self.bit(i) {
                r.lo |= 1;
            }
            q = q.shl1();
            if r >= d {
                r = r.sub(d);
                q.lo |= 1;
            }
        }
        q
    }
    /// Integer square root (fits in 128 bits).
    pub fn isqrt(self) -> u128 {
        let mut root: u128 = 0;
        for i in (0..128).rev() {
            let candidate = root | (1u128 << i);
            if mul_u128(candidate, candidate) <= self {
                root = candidate;
            }
        }
        root
    }
}

pub fn mul_u128(a: u128, b: u128) -> U256 {
    const LOW: u128 = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & LOW);
    let (b1, b0) = (b >> 64, b & LOW);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & LOW) + (p10 & LOW);
    U256 { hi: p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64), lo: (p00 & LOW) | (mid << 64) }
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

pub fn plan(ctx: Context<PlanLiquidity>, lp_bps: u16, floor: u64, trade_fee_bps: u16) -> Result<()> {
    let auction = &ctx.accounts.auction;
    require!(auction.status == AuctionStatus::Open, AuctionError::WrongStatus);
    require!(auction.bid_count == 0, AuctionError::HasBids);
    require!(auction.liquidity == LIQUIDITY_NONE, AuctionError::LiquidityAlreadyPlanned);
    require!(
        (MIN_LP_BPS..=BPS_DENOMINATOR as u16).contains(&lp_bps),
        AuctionError::InvalidLiquidityShare
    );
    require!(floor > 0, AuctionError::InvalidLiquidityFloor);
    require!(POOL_FEE_TIERS.contains(&trade_fee_bps), AuctionError::InvalidPoolFee);

    let reserve = auction.supply;
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.seller_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.reserve.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        reserve,
        ctx.accounts.mint.decimals,
    )?;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.seller.to_account_info(),
                to: ctx.accounts.lp_authority.to_account_info(),
            },
        ),
        LP_RENT_DEPOSIT,
    )?;

    let auction = &mut ctx.accounts.auction;
    auction.liquidity = LIQUIDITY_PLANNED;
    auction.liquidity_floor = floor;
    ctx.accounts.plan.set_inner(LiquidityPlan {
        auction: auction.key(),
        seller: auction.seller,
        treasury: auction.treasury,
        mint: auction.mint,
        token_program: auction.token_program,
        lp_bps,
        floor,
        trade_fee_bps,
        reserve,
        pool_sol: 0,
        pool_tokens: 0,
        pool: Pubkey::default(),
        position: Pubkey::default(),
        position_nft_mint: Pubkey::default(),
        fees_to_seller: 0,
        fees_to_platform: 0,
        bump: ctx.bumps.plan,
        authority_bump: ctx.bumps.lp_authority,
    });
    emit!(LiquidityPlanned {
        auction: auction.key(),
        lp_bps,
        floor,
        trade_fee_bps,
        reserve,
    });
    Ok(())
}

/// Sends the reserve's tokens to the seller, closes the authority's token
/// accounts and returns every lamport the authority holds. Used when no pool
/// will open.
fn release_everything<'info>(
    auction: &Pubkey,
    authority_bump: u8,
    lp_authority: &AccountInfo<'info>,
    reserve: &InterfaceAccount<'info, TokenAccount>,
    lp_wsol: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    seller_token_account: &AccountInfo<'info>,
    seller: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    wsol_token_program: &AccountInfo<'info>,
) -> Result<u64> {
    let seeds: &[&[u8]] = &[LP_AUTHORITY_SEED, auction.as_ref(), &[authority_bump]];
    let signer = &[seeds];
    let tokens = reserve.amount;
    if tokens > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program.key(),
                TransferChecked {
                    from: reserve.to_account_info(),
                    mint: mint.to_account_info(),
                    to: seller_token_account.clone(),
                    authority: lp_authority.clone(),
                },
                signer,
            ),
            tokens,
            mint.decimals,
        )?;
    }
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: reserve.to_account_info(),
            destination: seller.clone(),
            authority: lp_authority.clone(),
        },
        signer,
    ))?;
    if lp_wsol.lamports() > 0 {
        spl_token_cpi::close_account(CpiContext::new_with_signer(
            wsol_token_program.key(),
            spl_token_cpi::CloseAccount {
                account: lp_wsol.clone(),
                destination: seller.clone(),
                authority: lp_authority.clone(),
            },
            signer,
        ))?;
    }
    let lamports = lp_authority.lamports();
    if lamports > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                System::id(),
                system_program::Transfer { from: lp_authority.clone(), to: seller.clone() },
                signer,
            ),
            lamports,
        )?;
    }
    Ok(tokens)
}

pub fn bootstrap<'info>(ctx: Context<'info, BootstrapLiquidity<'info>>) -> Result<()> {
    {
        let a = &ctx.accounts;
        check_lp_wsol(&a.lp_wsol.key(), &a.lp_authority.key())?;
        check_pool_accounts(
            &a.mint.key(),
            &a.position_nft_mint.key(),
            &a.pool.key(),
            &a.position.key(),
            &a.position_nft_account.key(),
            &a.token_a_vault.key(),
            &a.token_b_vault.key(),
            &a.pool_authority.key(),
            &a.event_authority.key(),
        )?;
    }
    let auction = &ctx.accounts.auction;
    require!(auction.liquidity == LIQUIDITY_PLANNED, AuctionError::LiquidityNotPlanned);
    require!(
        auction.status == AuctionStatus::Settling && auction.resolved_count == auction.bid_count,
        AuctionError::NotSettled
    );
    let auction_key = auction.key();
    let plan = &ctx.accounts.plan;

    // The sale fee is taken first; the pool's SOL comes out of the rest.
    let proceeds = auction.proceeds;
    let fee = receivable_fee(
        &ctx.accounts.treasury.to_account_info(),
        sale_fee(proceeds, auction.sale_fee_bps),
    )?;
    let net = proceeds - fee;
    let sol = pool_sol(net, plan.lp_bps, plan.floor);
    let tokens = pool_tokens(sol, auction.clearing_price, auction.price_unit)
        .min(auction.sold)
        .min(ctx.accounts.reserve.amount);
    // The pool opens at exactly the clearing price; whichever side is short
    // after rounding sets the liquidity, and the rest comes back.
    let shape = pool_shape(sqrt_price_of(auction.clearing_price, auction.price_unit), sol, tokens);
    // Someone opened DAMM v2's pool for this token and SOL first: no pool.
    let taken = ctx.accounts.pool.lamports() > 0 && *ctx.accounts.pool.owner == CP_AMM_ID;

    let a = &ctx.accounts;
    let auction_info = a.auction.to_account_info();
    if taken || shape.is_none() {
        let returned = release_everything(
            &auction_key,
            plan.authority_bump,
            &a.lp_authority,
            &a.reserve,
            &a.lp_wsol,
            &a.mint,
            &a.seller_token_account.to_account_info(),
            &a.seller,
            &a.token_program,
            &a.wsol_token_program,
        )?;
        move_lamports(&auction_info, &a.treasury, fee)?;
        move_lamports(&auction_info, &a.seller, net)?;
        let auction = &mut ctx.accounts.auction;
        auction.proceeds = 0;
        auction.liquidity = LIQUIDITY_RELEASED;
        emit!(LiquiditySkipped {
            auction: auction_key,
            pool_taken: taken,
            tokens_returned: returned,
        });
        return Ok(());
    }
    let (sqrt_price, liquidity) = shape.unwrap();

    let seeds: &[&[u8]] = &[LP_AUTHORITY_SEED, auction_key.as_ref(), &[plan.authority_bump]];
    let signer = &[seeds];

    // Wrap the pool's SOL. The proceeds sit in the auction account, which
    // only this program can debit: they move to the authority directly, then
    // on to its SOL account with a system transfer that also lists the
    // auction, so the runtime sees every side of the move in one call.
    move_lamports(&auction_info, &a.lp_authority, sol)?;
    let mut transfer = anchor_lang::solana_program::system_instruction::transfer(
        &a.lp_authority.key(),
        &a.lp_wsol.key(),
        sol,
    );
    transfer.accounts.push(AccountMeta::new(a.auction.key(), false));
    invoke_signed(
        &transfer,
        &[
            a.lp_authority.to_account_info(),
            a.lp_wsol.to_account_info(),
            auction_info.clone(),
            a.system_program.to_account_info(),
        ],
        signer,
    )?;
    spl_token_cpi::sync_native(CpiContext::new(
        a.wsol_token_program.key(),
        spl_token_cpi::SyncNative { account: a.lp_wsol.to_account_info() },
    ))?;

    let init = Instruction {
        program_id: CP_AMM_ID,
        accounts: vec![
            AccountMeta::new_readonly(a.lp_authority.key(), false), // creator
            AccountMeta::new(a.position_nft_mint.key(), true),
            AccountMeta::new(a.position_nft_account.key(), false),
            AccountMeta::new(a.lp_authority.key(), true), // payer
            AccountMeta::new_readonly(a.pool_authority.key(), false),
            AccountMeta::new(a.pool.key(), false),
            AccountMeta::new(a.position.key(), false),
            AccountMeta::new_readonly(a.mint.key(), false), // token A
            AccountMeta::new_readonly(a.wsol_mint.key(), false), // token B
            AccountMeta::new(a.token_a_vault.key(), false),
            AccountMeta::new(a.token_b_vault.key(), false),
            AccountMeta::new(a.reserve.key(), false),
            AccountMeta::new(a.lp_wsol.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
            AccountMeta::new_readonly(a.wsol_token_program.key(), false),
            AccountMeta::new_readonly(a.token_2022_program.key(), false),
            AccountMeta::new_readonly(a.system_program.key(), false),
            AccountMeta::new_readonly(a.event_authority.key(), false),
            AccountMeta::new_readonly(CP_AMM_ID, false),
        ],
        data: init_pool_data(plan.trade_fee_bps, sqrt_price, liquidity),
    };
    invoke_signed(
        &init,
        &[
            a.lp_authority.to_account_info(),
            a.position_nft_mint.to_account_info(),
            a.position_nft_account.to_account_info(),
            a.pool_authority.to_account_info(),
            a.pool.to_account_info(),
            a.position.to_account_info(),
            a.mint.to_account_info(),
            a.wsol_mint.to_account_info(),
            a.token_a_vault.to_account_info(),
            a.token_b_vault.to_account_info(),
            a.reserve.to_account_info(),
            a.lp_wsol.to_account_info(),
            a.token_program.to_account_info(),
            a.wsol_token_program.to_account_info(),
            a.token_2022_program.to_account_info(),
            a.system_program.to_account_info(),
            a.event_authority.to_account_info(),
            a.cp_amm_program.to_account_info(),
        ],
        signer,
    )?;

    // Lock the whole position for good.
    let unlocked = {
        let data = a.position.try_borrow_data()?;
        let bytes = data
            .get(POSITION_UNLOCKED_LIQUIDITY..POSITION_UNLOCKED_LIQUIDITY + 16)
            .ok_or(AuctionError::WrongPoolAccounts)?;
        u128::from_le_bytes(bytes.try_into().unwrap())
    };
    require!(unlocked == liquidity, AuctionError::WrongPoolAccounts);
    let mut data = IX_PERMANENT_LOCK.to_vec();
    data.extend_from_slice(&unlocked.to_le_bytes());
    invoke_signed(
        &Instruction {
            program_id: CP_AMM_ID,
            accounts: vec![
                AccountMeta::new(a.pool.key(), false),
                AccountMeta::new(a.position.key(), false),
                AccountMeta::new_readonly(a.position_nft_account.key(), false),
                AccountMeta::new_readonly(a.lp_authority.key(), true),
                AccountMeta::new_readonly(a.event_authority.key(), false),
                AccountMeta::new_readonly(CP_AMM_ID, false),
            ],
            data,
        },
        &[
            a.pool.to_account_info(),
            a.position.to_account_info(),
            a.position_nft_account.to_account_info(),
            a.lp_authority.to_account_info(),
            a.event_authority.to_account_info(),
            a.cp_amm_program.to_account_info(),
        ],
        signer,
    )?;

    // What the pool really took, from the vaults it just filled.
    let vault_amount = |info: &AccountInfo| -> Result<u64> {
        let data = info.try_borrow_data()?;
        Ok(StateWithExtensions::<SplTokenAccount>::unpack(&data)?.base.amount)
    };
    let pool_tokens_in = vault_amount(&a.token_a_vault)?;
    let pool_sol_in = vault_amount(&a.token_b_vault)?;

    // The rest of the reserve goes back to the seller.
    let mut reserve = a.reserve.clone();
    reserve.reload()?;
    let returned = reserve.amount;
    if returned > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.reserve.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.seller_token_account.to_account_info(),
                    authority: a.lp_authority.to_account_info(),
                },
                signer,
            ),
            returned,
            a.mint.decimals,
        )?;
    }
    // SOL the pool did not take (rounding) and rent it did not use go back
    // to the seller: unwrap the SOL account into the authority, recreate it
    // empty for fee claims, and send the authority's spare lamports on. It
    // keeps just enough to stay rent-exempt.
    spl_token_cpi::close_account(CpiContext::new_with_signer(
        a.wsol_token_program.key(),
        spl_token_cpi::CloseAccount {
            account: a.lp_wsol.to_account_info(),
            destination: a.lp_authority.to_account_info(),
            authority: a.lp_authority.to_account_info(),
        },
        signer,
    ))?;
    anchor_spl::associated_token::create(CpiContext::new_with_signer(
        a.associated_token_program.key(),
        anchor_spl::associated_token::Create {
            payer: a.lp_authority.to_account_info(),
            associated_token: a.lp_wsol.to_account_info(),
            authority: a.lp_authority.to_account_info(),
            mint: a.wsol_mint.to_account_info(),
            system_program: a.system_program.to_account_info(),
            token_program: a.wsol_token_program.to_account_info(),
        },
        signer,
    ))?;
    let spare = a.lp_authority.lamports().saturating_sub(Rent::get()?.minimum_balance(0));
    if spare > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                System::id(),
                system_program::Transfer { from: a.lp_authority.to_account_info(), to: a.seller.to_account_info() },
                signer,
            ),
            spare,
        )?;
    }

    // The seller and the platform are paid what the pool did not take.
    move_lamports(&auction_info, &a.treasury, fee)?;
    move_lamports(&auction_info, &a.seller, net - sol)?;

    let pool = a.pool.key();
    let position = a.position.key();
    let nft_mint = a.position_nft_mint.key();
    let plan = &mut ctx.accounts.plan;
    plan.pool_sol = pool_sol_in;
    plan.pool_tokens = pool_tokens_in;
    plan.pool = pool;
    plan.position = position;
    plan.position_nft_mint = nft_mint;
    let auction = &mut ctx.accounts.auction;
    auction.proceeds = 0;
    auction.liquidity = LIQUIDITY_POOLED;
    emit!(LiquidityAdded {
        auction: auction_key,
        pool,
        pool_sol: pool_sol_in,
        pool_tokens: pool_tokens_in,
        tokens_returned: returned,
        seller_paid: net - sol,
        fee,
    });
    Ok(())
}

pub fn claim_fees(ctx: Context<ClaimPoolFees>) -> Result<()> {
    let a = &ctx.accounts;
    let plan = &a.plan;
    require!(
        a.position_nft_account.key() == damm_position_addresses(&plan.position_nft_mint).1
            && a.pool_authority.key() == damm_pool_authority()
            && a.event_authority.key() == damm_event_authority(),
        AuctionError::WrongPoolAccounts
    );
    let seeds: &[&[u8]] = &[LP_AUTHORITY_SEED, plan.auction.as_ref(), &[plan.authority_bump]];
    let signer = &[seeds];
    let before = a.lp_wsol.amount;

    invoke_signed(
        &Instruction {
            program_id: CP_AMM_ID,
            accounts: vec![
                AccountMeta::new_readonly(a.pool_authority.key(), false),
                AccountMeta::new_readonly(a.pool.key(), false),
                AccountMeta::new(a.position.key(), false),
                AccountMeta::new(a.reserve.key(), false),
                AccountMeta::new(a.lp_wsol.key(), false),
                AccountMeta::new(a.token_a_vault.key(), false),
                AccountMeta::new(a.token_b_vault.key(), false),
                AccountMeta::new_readonly(a.mint.key(), false),
                AccountMeta::new_readonly(a.wsol_mint.key(), false),
                AccountMeta::new_readonly(a.position_nft_account.key(), false),
                AccountMeta::new_readonly(a.lp_authority.key(), true),
                AccountMeta::new_readonly(a.token_program.key(), false),
                AccountMeta::new_readonly(a.wsol_token_program.key(), false),
                AccountMeta::new_readonly(a.event_authority.key(), false),
                AccountMeta::new_readonly(CP_AMM_ID, false),
            ],
            data: IX_CLAIM_POSITION_FEE.to_vec(),
        },
        &[
            a.pool_authority.to_account_info(),
            a.pool.to_account_info(),
            a.position.to_account_info(),
            a.reserve.to_account_info(),
            a.lp_wsol.to_account_info(),
            a.token_a_vault.to_account_info(),
            a.token_b_vault.to_account_info(),
            a.mint.to_account_info(),
            a.wsol_mint.to_account_info(),
            a.position_nft_account.to_account_info(),
            a.lp_authority.to_account_info(),
            a.token_program.to_account_info(),
            a.wsol_token_program.to_account_info(),
            a.event_authority.to_account_info(),
            a.cp_amm_program.to_account_info(),
        ],
        signer,
    )?;

    let mut wsol = a.lp_wsol.clone();
    wsol.reload()?;
    let claimed = wsol.amount.saturating_sub(before);
    if claimed == 0 {
        return Ok(());
    }
    // Unwrap: closing the SOL account hands its lamports to the authority,
    // which pays the shares and recreates the account.
    spl_token_cpi::close_account(CpiContext::new_with_signer(
        a.wsol_token_program.key(),
        spl_token_cpi::CloseAccount {
            account: a.lp_wsol.to_account_info(),
            destination: a.lp_authority.to_account_info(),
            authority: a.lp_authority.to_account_info(),
        },
        signer,
    ))?;
    let platform = receivable_fee(
        &a.treasury.to_account_info(),
        claimed - (claimed as u128 * SELLER_POOL_FEE_BPS as u128 / BPS_DENOMINATOR as u128) as u64,
    )?;
    let seller = claimed - platform;
    for (to, amount) in [(a.seller.to_account_info(), seller), (a.treasury.to_account_info(), platform)] {
        if amount > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    System::id(),
                    system_program::Transfer { from: a.lp_authority.to_account_info(), to },
                    signer,
                ),
                amount,
            )?;
        }
    }
    anchor_spl::associated_token::create(CpiContext::new_with_signer(
        a.associated_token_program.key(),
        anchor_spl::associated_token::Create {
            payer: a.lp_authority.to_account_info(),
            associated_token: a.lp_wsol.to_account_info(),
            authority: a.lp_authority.to_account_info(),
            mint: a.wsol_mint.to_account_info(),
            system_program: a.system_program.to_account_info(),
            token_program: a.wsol_token_program.to_account_info(),
        },
        signer,
    ))?;

    let plan = &mut ctx.accounts.plan;
    plan.fees_to_seller = plan.fees_to_seller.saturating_add(seller);
    plan.fees_to_platform = plan.fees_to_platform.saturating_add(platform);
    emit!(PoolFeesClaimed {
        auction: plan.auction,
        pool: plan.pool,
        seller,
        platform,
    });
    Ok(())
}

pub fn release(ctx: Context<ReleaseLiquidity>) -> Result<()> {
    check_lp_wsol(&ctx.accounts.lp_wsol.key(), &ctx.accounts.lp_authority.key())?;
    let auction = &ctx.accounts.auction;
    let now = Clock::get()?.unix_timestamp;
    let allowed = match auction.liquidity {
        LIQUIDITY_FAILED => true,
        LIQUIDITY_PLANNED => {
            auction.status == AuctionStatus::Cancelled
                || (auction.bid_count == 0 && now >= auction.end_time)
                || !before_emergency(auction, now)?
        }
        _ => false,
    };
    require!(allowed, AuctionError::LiquidityStillNeeded);
    let a = &ctx.accounts;
    let returned = release_everything(
        &auction.key(),
        a.plan.authority_bump,
        &a.lp_authority,
        &a.reserve,
        &a.lp_wsol,
        &a.mint,
        &a.seller_token_account.to_account_info(),
        &a.seller.to_account_info(),
        &a.token_program.to_account_info(),
        &a.wsol_token_program,
    )?;
    let auction = &mut ctx.accounts.auction;
    auction.liquidity = LIQUIDITY_RELEASED;
    emit!(LiquiditySkipped {
        auction: auction.key(),
        pool_taken: false,
        tokens_returned: returned,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct PlanLiquidity<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
        has_one = mint,
        constraint = auction.kind == AuctionKind::Token @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        init,
        payer = seller,
        space = 8 + LiquidityPlan::INIT_SPACE,
        seeds = [LIQUIDITY_SEED, auction.key().as_ref()],
        bump,
    )]
    pub plan: Box<Account<'info, LiquidityPlan>>,
    /// CHECK: data-less address of this program that holds the reserve and
    /// will own the pool position.
    #[account(mut, seeds = [LP_AUTHORITY_SEED, auction.key().as_ref()], bump)]
    pub lp_authority: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = seller,
        token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// `init_if_needed` because anyone can create an associated token account.
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = mint,
        associated_token::authority = lp_authority,
        associated_token::token_program = token_program,
    )]
    pub reserve: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = wsol_mint,
        associated_token::authority = lp_authority,
        associated_token::token_program = wsol_token_program,
    )]
    pub lp_wsol: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = auction.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub wsol_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BootstrapLiquidity<'info> {
    /// Anyone can open the pool once the sale is settled.
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
        has_one = treasury @ AuctionError::InvalidTreasury,
        has_one = mint,
        constraint = auction.kind == AuctionKind::Token @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [LIQUIDITY_SEED, auction.key().as_ref()], bump = plan.bump)]
    pub plan: Box<Account<'info, LiquidityPlan>>,
    /// CHECK: the plan's authority (seeds checked).
    #[account(mut, seeds = [LP_AUTHORITY_SEED, auction.key().as_ref()], bump = plan.authority_bump)]
    pub lp_authority: UncheckedAccount<'info>,
    /// CHECK: the auction's seller; receives the SOL the pool does not take.
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: the auction's treasury; receives the sale fee.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the SOL mint (address checked).
    #[account(address = WSOL_MINT)]
    pub wsol_mint: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = lp_authority,
        associated_token::token_program = token_program,
    )]
    pub reserve: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the authority's SOL account (address checked in the handler).
    #[account(mut)]
    pub lp_wsol: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = seller,
        token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: a new keypair; DAMM v2 makes it the position NFT.
    #[account(mut, signer)]
    pub position_nft_mint: UncheckedAccount<'info>,
    // The DAMM v2 accounts below are checked in the handler
    // (`check_pool_accounts`), which keeps this struct's validation within
    // the stack limit.
    /// CHECK: created by DAMM v2.
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's pool for this token and SOL.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: created by DAMM v2.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: created by DAMM v2.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: created by DAMM v2.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's pool authority.
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's event authority.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = CP_AMM_ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    /// CHECK: the auction's token program (address checked).
    #[account(address = auction.token_program)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token, for SOL (address checked).
    #[account(address = anchor_spl::token::ID)]
    pub wsol_token_program: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = spl_token_2022::ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimPoolFees<'info> {
    /// Anyone can claim; the fees only ever go to the seller and the
    /// platform.
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [LIQUIDITY_SEED, plan.auction.as_ref()],
        bump = plan.bump,
        has_one = seller @ AuctionError::Unauthorized,
        has_one = treasury @ AuctionError::InvalidTreasury,
        has_one = mint,
        has_one = pool @ AuctionError::WrongPoolAccounts,
        has_one = position @ AuctionError::WrongPoolAccounts,
    )]
    pub plan: Box<Account<'info, LiquidityPlan>>,
    /// CHECK: the plan's authority (seeds checked).
    #[account(mut, seeds = [LP_AUTHORITY_SEED, plan.auction.as_ref()], bump = plan.authority_bump)]
    pub lp_authority: UncheckedAccount<'info>,
    /// CHECK: receives the seller's share.
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: receives the platform's share.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: checked by DAMM v2 against the pool.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = WSOL_MINT)]
    pub wsol_mint: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = lp_authority,
        associated_token::token_program = token_program,
    )]
    pub reserve: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = lp_authority,
        associated_token::token_program = wsol_token_program,
    )]
    pub lp_wsol: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the plan's pool.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the plan's position.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: checked in the handler.
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: checked by DAMM v2 against the pool.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: checked by DAMM v2 against the pool.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: checked in the handler.
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: checked in the handler.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = CP_AMM_ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    #[account(address = plan.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub wsol_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseLiquidity<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
        has_one = mint,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(seeds = [LIQUIDITY_SEED, auction.key().as_ref()], bump = plan.bump)]
    pub plan: Box<Account<'info, LiquidityPlan>>,
    /// CHECK: the plan's authority (seeds checked).
    #[account(mut, seeds = [LP_AUTHORITY_SEED, auction.key().as_ref()], bump = plan.authority_bump)]
    pub lp_authority: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = lp_authority,
        associated_token::token_program = token_program,
    )]
    pub reserve: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the authority's SOL account (address checked in the
    /// handler); closed if open.
    #[account(mut)]
    pub lp_wsol: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = mint,
        associated_token::authority = seller,
        associated_token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the auction's token program (address checked).
    #[account(address = auction.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: SPL Token, for SOL (address checked).
    #[account(address = anchor_spl::token::ID)]
    pub wsol_token_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct LiquidityPlanned {
    pub auction: Pubkey,
    pub lp_bps: u16,
    pub floor: u64,
    pub trade_fee_bps: u16,
    pub reserve: u64,
}

#[event]
pub struct LiquidityFloorMissed {
    pub auction: Pubkey,
    pub expected_net: u64,
    pub floor: u64,
}

#[event]
pub struct LiquidityAdded {
    pub auction: Pubkey,
    pub pool: Pubkey,
    pub pool_sol: u64,
    pub pool_tokens: u64,
    pub tokens_returned: u64,
    pub seller_paid: u64,
    pub fee: u64,
}

#[event]
pub struct LiquiditySkipped {
    pub auction: Pubkey,
    /// Whether DAMM v2's pool for the pair already existed.
    pub pool_taken: bool,
    pub tokens_returned: u64,
}

#[event]
pub struct PoolFeesClaimed {
    pub auction: Pubkey,
    pub pool: Pubkey,
    pub seller: u64,
    pub platform: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_price_matches_and_fits_the_amounts() {
        // (price, unit, sol, tokens): the pool's SOL and what it buys.
        for (price, unit, sol, tokens) in [
            (10_000u32, 1_000_000_000u64, 300_000_000u64, 30_000_000_000_000u64),
            (3_000, 1, 89_100, 29),
            (5_000, 1, 5_000_000_000, 1_000_000),
            (1, 1_000_000_000_000_000, 1_000_000, 1_000_000_000_000_000_000),
            (u32::MAX, 1, u64::MAX / 4, 7),
        ] {
            let s = sqrt_price_of(price, unit);
            let (_, l) = pool_shape(s, sol, tokens).unwrap();
            let got = (s as f64 / 2f64.powi(64)).powi(2);
            let want = price as f64 / unit as f64;
            assert!((got / want - 1.0).abs() < 1e-9, "{got} {want}");
            let b = l as f64 * (s - MIN_SQRT_PRICE) as f64 / 2f64.powi(128);
            let a = l as f64 * (MAX_SQRT_PRICE - s) as f64 / (s as f64 * MAX_SQRT_PRICE as f64);
            assert!(b <= sol as f64 * (1.0 + 1e-12));
            assert!(a <= tokens as f64 * (1.0 + 1e-12));
            assert!(b >= sol as f64 * 0.999 || a >= tokens as f64 * 0.999);
        }
        assert!(pool_shape(1 << 64, 0, 1).is_none());
        assert!(pool_shape(1 << 64, 1, 0).is_none());
        assert!(pool_shape(MIN_SQRT_PRICE, 1, 1).is_none());
    }

    #[test]
    fn isqrt_is_exact() {
        for v in [0u128, 1, 2, 4, 99, u64::MAX as u128, u128::MAX] {
            let r = U256::from_u128(v).isqrt();
            assert!(mul_u128(r, r) <= U256::from_u128(v));
            assert!(mul_u128(r + 1, r + 1) > U256::from_u128(v));
        }
    }

    #[test]
    fn the_pool_share_is_raised_to_the_floor_and_capped_by_the_proceeds() {
        assert_eq!(pool_sol(1_000, 3_000, 100), 300);
        assert_eq!(pool_sol(1_000, 3_000, 500), 500);
        assert_eq!(pool_sol(1_000, 3_000, 5_000), 1_000);
        assert_eq!(pool_sol(1_000, 10_000, 1), 1_000);
        // 0.3 SOL at 10_000 lamports per 10^9 base units buys 30_000 tokens.
        assert_eq!(pool_tokens(300_000_000, 10_000, 1_000_000_000), 30_000_000_000_000);
        assert_eq!(pool_tokens(1, 0, 1), 0);
    }

    #[test]
    fn the_floor_check_uses_the_net_proceeds_the_clearing_implies() {
        let fees = FeeConfig { listing_fee: 0, sale_fee_bps: 100, treasury: Pubkey::default(), bump: 0 };
        let mut auction = new_auction(
            AuctionKind::Token,
            1,
            Pubkey::default(),
            Pubkey::default(),
            Pubkey::default(),
            0,
            1,
            [0, 0],
            &fees,
            CrankRewards::default(),
        );
        auction.supply = 100_000_000_000_000; // 100,000 tokens of 9 decimals
        auction.price_unit = 1_000_000_000;
        auction.min_price = 5_000;
        // Filled at 10_000 lamports per token: 1 SOL gross, 0.99 SOL net.
        auction.filled = true;
        auction.clearing_price = 10_000;
        auction.weight_above = 2_000_000_000;
        assert_eq!(expected_net_proceeds(&auction), 990_000_000);
        // Unfilled: every valid budget is spent at the minimum price.
        auction.filled = false;
        auction.clearing_price = 5_000;
        auction.weight_above = 400_000_000;
        assert_eq!(expected_net_proceeds(&auction), 396_000_000);
    }

    #[test]
    fn fee_schedule_starts_at_half_and_ends_at_the_tier() {
        let data = init_pool_data(100, 1 << 64, 1);
        let cliff = u64::from_le_bytes(data[8..16].try_into().unwrap());
        let steps = u16::from_le_bytes(data[16..18].try_into().unwrap());
        let reduction = u64::from_le_bytes(data[26..34].try_into().unwrap());
        assert_eq!(cliff, 500_000_000);
        assert_eq!(cliff - reduction * steps as u64, 10_000_000);
        // 8 + 27 + 3 + 1 + 16 * 2 + 1 + 16 * 2 + 3 bytes.
        assert_eq!(data.len(), 107);
    }
}
