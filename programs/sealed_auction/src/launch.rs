//! Fair launches: a token that only exists if its sale succeeds.
//!
//! The creator opens a sale for a token that does not exist yet
//! (`create_launch`): its name, symbol and metadata link wait in a
//! `LaunchToken`, and the token's address is fixed
//! (`[LAUNCH_MINT_SEED, auction]`). Half of `LAUNCH_SUPPLY` is sold by sealed
//! bid like any token sale, at a minimum price set so that selling it all
//! raises the creator's target: the launch graduates only if it sells out.
//! The pool is planned in the same step, with every lamport raised (less the
//! sale fee) going into it.
//!
//! If the sale succeeds, anyone can graduate it (`graduate_launch`): the
//! token is made then, from the `LaunchToken`, in Token-2022 with its
//! metadata fixed for good; exactly the tokens sold and the tokens the pool
//! needs at the clearing price are minted, and the mint closes for good.
//! `bootstrap_liquidity` then opens the pool, and only then can winners
//! collect their tokens, so nobody holds any before the pool exists.
//!
//! If it fails (it missed its target, ended without bids, stalled until the
//! safety net, or was withdrawn before any bid), no token is ever made:
//! every bid is refunded and the creator closes the sale (`close_launch`),
//! taking back every deposit and rent but the listing fee and the crank
//! rewards paid.

use super::*;
use anchor_spl::associated_token::{self as ata_cpi, get_associated_token_address_with_program_id};

pub const LAUNCH_SEED: &[u8] = b"launch";
pub const LAUNCH_TOKEN_DISCRIMINATOR: &[u8] = b"VLaunch1";

/// What a launch's token will be called, until it is made.
#[account(discriminator = LAUNCH_TOKEN_DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct LaunchToken {
    pub auction: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    #[max_len(200)]
    pub uri: String,
    pub bump: u8,
}

const _: () = assert!(MAX_LAUNCH_NAME_LEN == 32 && MAX_LAUNCH_SYMBOL_LEN == 10 && MAX_URI_LEN == 200);

/// A launch token's name, symbol and metadata link.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub struct LaunchTokenTerms {
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

impl LaunchTokenTerms {
    fn check(&self) -> Result<()> {
        require!(
            !self.name.trim().is_empty() && self.name.len() <= MAX_LAUNCH_NAME_LEN,
            AuctionError::InvalidLaunch
        );
        require!(
            !self.symbol.trim().is_empty() && self.symbol.len() <= MAX_LAUNCH_SYMBOL_LEN,
            AuctionError::InvalidLaunch
        );
        require!(is_metadata_uri(&self.uri), AuctionError::InvalidLaunch);
        Ok(())
    }
}

/// A launch's graduation target: what its whole sale half raises at the
/// minimum price, in lamports.
pub fn launch_target(terms: &TokenSaleTerms) -> u64 {
    let gross = terms.supply as u128 * terms.min_price as u128 / terms.price_unit.max(1) as u128;
    u64::try_from(gross).unwrap_or(u64::MAX)
}

/// Bytes a launch token's metadata takes in its mint: the extension's type
/// and length, both authorities' keys, the three strings with their lengths
/// and an empty list of extra fields.
pub fn launch_metadata_len(name: &str, symbol: &str, uri: &str) -> usize {
    4 + 32 + 32 + (4 + name.len()) + (4 + symbol.len()) + (4 + uri.len()) + 4
}

/// Tokens a graduating launch's pool takes: what its SOL buys at the
/// clearing price, as `bootstrap_liquidity` will compute it, never more
/// than were sold.
pub fn launch_pool_tokens(auction: &Auction, plan: &LiquidityPlan) -> u64 {
    let net = auction.proceeds - sale_fee(auction.proceeds, auction.sale_fee_bps);
    let sol = pool_sol(net, plan.lp_bps, plan.floor);
    pool_tokens(sol, auction.clearing_price, auction.price_unit).min(auction.sold)
}

pub fn create(
    ctx: Context<CreateLaunch>,
    seed: u64,
    terms: TokenSaleTerms,
    fees: FeeTerms,
    token: LaunchTokenTerms,
    trade_fee_bps: u16,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (start_time, end_time) = terms.check(now)?;
    token.check()?;
    require!(
        terms.supply == LAUNCH_SALE_SUPPLY
            && terms.min_deposit == LAUNCH_MIN_BID
            && LAUNCH_DURATIONS.contains(&terms.duration_secs),
        AuctionError::InvalidLaunch
    );
    let target = launch_target(&terms);
    require!(target >= LAUNCH_MIN_RAISE, AuctionError::InvalidLaunch);
    require!(POOL_FEE_TIERS.contains(&trade_fee_bps), AuctionError::InvalidPoolFee);

    let listing_fee = charge_listing_fee(
        &ctx.accounts.fee_config,
        &fees,
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
    )?;

    let auction_key = ctx.accounts.auction.key();
    let mint = ctx.accounts.mint.key();
    let mut auction = new_auction(
        AuctionKind::Launch,
        seed,
        ctx.accounts.seller.key(),
        mint,
        spl_token_2022::ID,
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
    auction.min_raise = target;
    // The pool is planned now: every lamport raised, less the sale fee.
    auction.liquidity = LIQUIDITY_PLANNED;
    auction.liquidity_floor = 1;
    let treasury = auction.treasury;
    let seller = auction.seller;
    ctx.accounts.auction.set_inner(auction);
    let mut book = ctx.accounts.book.load_init()?;
    book.auction = auction_key;
    drop(book);

    ctx.accounts.launch_token.set_inner(LaunchToken {
        auction: auction_key,
        name: token.name.clone(),
        symbol: token.symbol.clone(),
        uri: token.uri.clone(),
        bump: ctx.bumps.launch_token,
    });
    ctx.accounts.plan.set_inner(LiquidityPlan {
        auction: auction_key,
        seller,
        treasury,
        mint,
        token_program: spl_token_2022::ID,
        lp_bps: BPS_DENOMINATOR as u16,
        floor: 1,
        trade_fee_bps,
        reserve: 0,
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
    // Pays for the token, its accounts and the pool if it graduates; comes
    // back whole if it does not, and what is left over if it does.
    system_program::transfer(
        CpiContext::new(
            System::id(),
            system_program::Transfer {
                from: ctx.accounts.seller.to_account_info(),
                to: ctx.accounts.lp_authority.to_account_info(),
            },
        ),
        LAUNCH_LP_DEPOSIT,
    )?;

    fund_crank_pool(
        &mut ctx.accounts.auction,
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.system_program,
    )?;
    emit_auction_created(&ctx.accounts.auction, listing_fee);
    emit!(SaleRulesSet {
        auction: auction_key,
        min_raise: target,
        wallet_cap: 0,
        allowlist: false,
    });
    emit!(LiquidityPlanned {
        auction: auction_key,
        lp_bps: BPS_DENOMINATOR as u16,
        floor: 1,
        trade_fee_bps,
        reserve: 0,
    });
    emit!(LaunchOpened {
        auction: auction_key,
        mint,
        name: token.name,
        symbol: token.symbol,
        uri: token.uri,
        target,
    });
    Ok(())
}

pub fn graduate(ctx: Context<GraduateLaunch>) -> Result<()> {
    let auction = &ctx.accounts.auction;
    require!(
        !auction.raise_missed && auction.liquidity == LIQUIDITY_PLANNED,
        AuctionError::LaunchFailed
    );
    require!(
        auction.status == AuctionStatus::Settling && auction.resolved_count == auction.bid_count,
        AuctionError::NotSettled
    );
    require!(auction.sold > 0, AuctionError::LaunchFailed);
    let sold = auction.sold;
    let pooled = launch_pool_tokens(auction, &ctx.accounts.plan);
    require!(pooled > 0, AuctionError::LaunchFailed);

    let auction_key = ctx.accounts.auction.key();
    let mint_key = ctx.accounts.mint.key();
    {
    let a = &ctx.accounts;
    let seller_key = a.auction.seller;
    let seed_bytes = a.auction.seed.to_le_bytes();
    let auction_seeds: &[&[u8]] = &[AUCTION_SEED, seller_key.as_ref(), &seed_bytes, &[a.auction.bump]];
    let lp_seeds: &[&[u8]] = &[LP_AUTHORITY_SEED, auction_key.as_ref(), &[a.plan.authority_bump]];
    let mint_seeds: &[&[u8]] = &[LAUNCH_MINT_SEED, auction_key.as_ref(), &[ctx.bumps.mint]];
    let lp_authority = a.lp_authority.to_account_info();
    let mint = a.mint.to_account_info();
    let token_program = a.token_program.to_account_info();
    let auction_info = a.auction.to_account_info();
    let token = &a.launch_token;

    // The token, paid from the creator's deposit.
    let mint_len = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[
        ExtensionType::MetadataPointer,
    ])?;
    let lamports = Rent::get()?.minimum_balance(mint_len + launch_metadata_len(&token.name, &token.symbol, &token.uri));
    require!(mint.lamports() == 0, AuctionError::WrongAssetAccounts);
    system_program::create_account(
        CpiContext::new_with_signer(
            System::id(),
            system_program::CreateAccount {
                from: lp_authority.clone(),
                to: mint.clone(),
            },
            &[lp_seeds, mint_seeds],
        ),
        lamports,
        mint_len as u64,
        &spl_token_2022::ID,
    )?;
    token_interface::metadata_pointer_initialize(
        CpiContext::new(
            spl_token_2022::ID,
            MetadataPointerInitialize {
                token_program_id: token_program.clone(),
                mint: mint.clone(),
            },
        ),
        None,
        Some(mint.key()),
    )?;
    token_interface::initialize_mint2(
        CpiContext::new(spl_token_2022::ID, InitializeMint2 { mint: mint.clone() }),
        LAUNCH_DECIMALS,
        &auction_key,
        None,
    )?;
    token_interface::token_metadata_initialize(
        CpiContext::new_with_signer(
            spl_token_2022::ID,
            TokenMetadataInitialize {
                program_id: token_program.clone(),
                metadata: mint.clone(),
                update_authority: auction_info.clone(),
                mint_authority: auction_info.clone(),
                mint: mint.clone(),
            },
            &[auction_seeds],
        ),
        token.name.clone(),
        token.symbol.clone(),
        token.uri.clone(),
    )?;
    // Nobody can ever change its name, symbol or link.
    token_interface::token_metadata_update_authority(
        CpiContext::new_with_signer(
            spl_token_2022::ID,
            TokenMetadataUpdateAuthority {
                program_id: token_program.clone(),
                metadata: mint.clone(),
                current_authority: auction_info.clone(),
                new_authority: auction_info.clone(),
            },
            &[auction_seeds],
        ),
        spl_pod::optional_keys::OptionalNonZeroPubkey::default(),
    )?;

    // Its accounts: the auction's vault, the pool's reserve and the
    // creator's (the shared instructions expect one; it holds nothing),
    // and the pool's SOL account, which wraps the SOL that goes in.
    let wsol_program = a.wsol_token_program.to_account_info();
    for (account, owner, account_mint, program) in [
        (a.vault.to_account_info(), auction_info.clone(), mint.clone(), token_program.clone()),
        (a.reserve.to_account_info(), lp_authority.clone(), mint.clone(), token_program.clone()),
        (a.seller_token_account.to_account_info(), a.seller.to_account_info(), mint.clone(), token_program.clone()),
        (a.lp_wsol.to_account_info(), lp_authority.clone(), a.wsol_mint.to_account_info(), wsol_program),
    ] {
        ata_cpi::create(CpiContext::new_with_signer(
            AssociatedToken::id(),
            ata_cpi::Create {
                payer: lp_authority.clone(),
                associated_token: account,
                authority: owner,
                mint: account_mint,
                system_program: a.system_program.to_account_info(),
                token_program: program,
            },
            &[lp_seeds],
        ))?;
    }

    // Exactly what was sold and what the pool takes; then the mint closes.
    for (to, amount) in [(a.vault.to_account_info(), sold), (a.reserve.to_account_info(), pooled)] {
        token_interface::mint_to(
            CpiContext::new_with_signer(
                spl_token_2022::ID,
                MintTo {
                    mint: mint.clone(),
                    to,
                    authority: auction_info.clone(),
                },
                &[auction_seeds],
            ),
            amount,
        )?;
    }
    token_interface::set_authority(
        CpiContext::new_with_signer(
            spl_token_2022::ID,
            SetAuthority {
                current_authority: auction_info,
                account_or_mint: mint.clone(),
            },
            &[auction_seeds],
        ),
        spl_token_2022::instruction::AuthorityType::MintTokens,
        None,
    )?;
    }

    ctx.accounts.plan.reserve = pooled;
    emit!(LaunchGraduated {
        auction: auction_key,
        mint: mint_key,
        sold,
        pool_tokens: pooled,
    });
    Ok(())
}

pub fn close<'info>(ctx: Context<'info, CloseLaunch<'info>>) -> Result<()> {
    let auction = &ctx.accounts.auction;
    let now = Clock::get()?.unix_timestamp;
    require!(
        auction.live_bids == 0 && auction.sold == 0,
        AuctionError::BidsOutstanding
    );
    let withdrawn = auction.status == AuctionStatus::Open && auction.bid_count == 0;
    require!(
        withdrawn || auction.status == AuctionStatus::Cancelled || now >= auction.end_time,
        AuctionError::BiddingOpen
    );
    require!(
        auction.extra_pages == 0 || (ctx.accounts.fold.is_some() && ctx.accounts.book_index.is_some()),
        AuctionError::WrongBookPage
    );
    // The deposit for the token and pool goes back whole.
    let auction_key = auction.key();
    let lp_seeds: &[&[u8]] = &[
        LP_AUTHORITY_SEED,
        auction_key.as_ref(),
        &[ctx.accounts.plan.authority_bump],
    ];
    let lp_authority = ctx.accounts.lp_authority.to_account_info();
    let deposit = lp_authority.lamports();
    if deposit > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                System::id(),
                system_program::Transfer {
                    from: lp_authority,
                    to: ctx.accounts.seller.to_account_info(),
                },
                &[lp_seeds],
            ),
            deposit,
        )?;
    }
    // Pages close after the CPI above (a lamport move before a CPI must
    // balance inside it).
    close_extra_pages(
        &ctx.accounts.auction,
        ctx.remaining_accounts,
        ctx.accounts.fold.is_some() && ctx.accounts.book_index.is_some(),
        &ctx.accounts.seller.to_account_info(),
    )?;
    // `close = seller` returns the auction's lamports (rent, crank fund),
    // the book's, the plan's and the launch token's.
    emit!(LaunchClosed { auction: auction_key });
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct CreateLaunch<'info> {
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
    #[account(
        init,
        payer = seller,
        space = 8 + LaunchToken::INIT_SPACE,
        seeds = [LAUNCH_SEED, auction.key().as_ref()],
        bump,
    )]
    pub launch_token: Box<Account<'info, LaunchToken>>,
    #[account(
        init,
        payer = seller,
        space = 8 + LiquidityPlan::INIT_SPACE,
        seeds = [LIQUIDITY_SEED, auction.key().as_ref()],
        bump,
    )]
    pub plan: Box<Account<'info, LiquidityPlan>>,
    /// CHECK: data-less address of this program; holds the deposit.
    #[account(mut, seeds = [LP_AUTHORITY_SEED, auction.key().as_ref()], bump)]
    pub lp_authority: UncheckedAccount<'info>,
    /// CHECK: where the token will be made if the launch graduates; it does
    /// not exist yet.
    #[account(seeds = [LAUNCH_MINT_SEED, auction.key().as_ref()], bump)]
    pub mint: UncheckedAccount<'info>,
    #[account(seeds = [FEES_SEED], bump = fee_config.bump)]
    pub fee_config: Box<Account<'info, FeeConfig>>,
    /// CHECK: the treasury named in the fee config; receives the listing fee.
    #[account(mut, address = fee_config.treasury @ AuctionError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [CRANK_SEED], bump = crank_config.bump)]
    pub crank_config: Box<Account<'info, CrankConfig>>,
}

#[derive(Accounts)]
pub struct GraduateLaunch<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
        has_one = mint,
        constraint = auction.kind == AuctionKind::Launch @ AuctionError::WrongAuctionKind,
    )]
    pub auction: Box<Account<'info, Auction>>,
    /// Closes here: the token now carries its name, symbol and link.
    #[account(
        mut,
        close = seller,
        seeds = [LAUNCH_SEED, auction.key().as_ref()],
        bump = launch_token.bump,
    )]
    pub launch_token: Box<Account<'info, LaunchToken>>,
    #[account(
        mut,
        seeds = [LIQUIDITY_SEED, auction.key().as_ref()],
        bump = plan.bump,
    )]
    pub plan: Box<Account<'info, LiquidityPlan>>,
    /// CHECK: the plan's data-less authority; pays for the token's accounts.
    #[account(mut, seeds = [LP_AUTHORITY_SEED, auction.key().as_ref()], bump = plan.authority_bump)]
    pub lp_authority: UncheckedAccount<'info>,
    /// CHECK: the auction's seller (has_one); gets the launch token's rent.
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: created here, at this program-derived address.
    #[account(mut, seeds = [LAUNCH_MINT_SEED, auction.key().as_ref()], bump)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the auction's vault, created here.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&auction.key(), &mint.key(), &spl_token_2022::ID)
            @ AuctionError::WrongVault,
    )]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the pool's reserve, created here.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&lp_authority.key(), &mint.key(), &spl_token_2022::ID)
            @ AuctionError::WrongPoolAccounts,
    )]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: the creator's account for the token, created here.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&seller.key(), &mint.key(), &spl_token_2022::ID)
            @ AuctionError::WrongAssetAccounts,
    )]
    pub seller_token_account: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL (address checked).
    #[account(address = WSOL_MINT)]
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: the pool's SOL account, created here.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(&lp_authority.key(), &WSOL_MINT, &anchor_spl::token::ID)
            @ AuctionError::WrongPoolAccounts,
    )]
    pub lp_wsol: UncheckedAccount<'info>,
    /// CHECK: Token-2022 (address checked).
    #[account(address = spl_token_2022::ID)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token, for wrapped SOL (address checked).
    #[account(address = anchor_spl::token::ID)]
    pub wsol_token_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseLaunch<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        close = seller,
        seeds = [AUCTION_SEED, auction.seller.as_ref(), &auction.seed.to_le_bytes()],
        bump = auction.bump,
        has_one = seller @ AuctionError::Unauthorized,
        constraint = auction.kind == AuctionKind::Launch @ AuctionError::WrongAuctionKind,
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
    /// Only for an auction with more than one page: its book's index.
    #[account(
        mut,
        close = seller,
        seeds = [INDEX_SEED, auction.key().as_ref()],
        bump = book_index.bump,
    )]
    pub book_index: Option<Box<Account<'info, BookIndex>>>,
    /// Still here: the launch never graduated, so its token was never made.
    #[account(
        mut,
        close = seller,
        seeds = [LAUNCH_SEED, auction.key().as_ref()],
        bump = launch_token.bump,
    )]
    pub launch_token: Box<Account<'info, LaunchToken>>,
    #[account(
        mut,
        close = seller,
        seeds = [LIQUIDITY_SEED, auction.key().as_ref()],
        bump = plan.bump,
    )]
    pub plan: Box<Account<'info, LiquidityPlan>>,
    /// CHECK: the plan's data-less authority; its deposit goes back.
    #[account(mut, seeds = [LP_AUTHORITY_SEED, auction.key().as_ref()], bump = plan.authority_bump)]
    pub lp_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct LaunchOpened {
    pub auction: Pubkey,
    /// Where the token will be made if the launch graduates.
    pub mint: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    /// What selling it all raises, in lamports: the graduation target.
    pub target: u64,
}

#[event]
pub struct LaunchGraduated {
    pub auction: Pubkey,
    pub mint: Pubkey,
    pub sold: u64,
    pub pool_tokens: u64,
}

#[event]
pub struct LaunchClosed {
    pub auction: Pubkey,
}
