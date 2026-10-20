//! Mock-MPC tests for the auction circuits. They evaluate the compiled IR in
//! `build/` with arcis' test harness, so build the circuits crate first.

use arcis::{testing::*, *};

const MAX_BATCHES: usize = 64;
const MAX_BIDS: usize = 4 * MAX_BATCHES;

/// Laid out like the circuit's `[CheckedBid { price: u32, quantity: u64 }; 4]`.
type Record = Pack<[(u32, u64); 4]>;
/// `(price, weight_above, weight_at)`.
type Clearing = (u32, u128, u128);

const NFT_SCALE: u64 = 1_000; // lamports per price tick of an NFT price
const MAX_PER_BID: u64 = 10;

fn bidder() -> Shared {
    Shared::new(ArcisX25519Pubkey::from_base58(b"test"))
}

/// An encrypted bid, laid out like the circuit's `BidInput { price: u32, quantity: u64 }`.
fn bid(price: u32, quantity: u64) -> Enc<Shared, (u32, u64)> {
    bidder().from_arcis((price, quantity))
}

fn record_enc(entries: [(u32, u64); 4]) -> Enc<Mxe, Record> {
    Mxe::get().from_arcis(Pack::new(entries))
}

fn decrypt_record(record: &Enc<Mxe, Record>) -> [(u32, u64); 4] {
    record.to_arcis().unpack()
}

/// `check_bids_v2` for a token auction: each bid's quantity is its budget.
fn check_tokens(
    bids: [(Enc<Shared, (u32, u64)>, u64); 4],
    active: u8,
    min_price: u32,
    min_budget: u64,
) -> [(u32, u64); 4] {
    let ix = get_instruction("check_bids_v2");
    let [b0, b1, b2, b3] = bids;
    let record: Enc<Mxe, Record> = ix.eval((
        (b0.0, b0.1, b1.0, b1.1, b2.0, b2.1),
        (b3.0, b3.1, active, true),
        (min_price, 1u64, 0u64, min_budget),
    ));
    decrypt_record(&record)
}

/// `check_bids_v2` for a collection auction.
fn check_nfts(bids: [(Enc<Shared, (u32, u64)>, u64); 4], active: u8, min_price: u32) -> [(u32, u64); 4] {
    let ix = get_instruction("check_bids_v2");
    let [b0, b1, b2, b3] = bids;
    let record: Enc<Mxe, Record> = ix.eval((
        (b0.0, b0.1, b1.0, b1.1, b2.0, b2.1),
        (b3.0, b3.1, active, false),
        (min_price, NFT_SCALE, MAX_PER_BID, 0u64),
    ));
    decrypt_record(&record)
}

/// What an NFT bid has to deposit.
fn nft_cost(price: u32, quantity: u64) -> u64 {
    price as u64 * NFT_SCALE * quantity
}

/// Runs `clear_price_v2` on checked bids (in bid order). The unused records
/// are junk, as the program passes the book's empty slots.
fn clear(ix: &ArcisInstructionWithInfo, bids: &[(u32, u64)], is_token: bool, price_unit: u64, supply: u64) -> Clearing {
    assert!(bids.len() <= MAX_BIDS);
    let active = bids.len().div_ceil(4);
    let records: [Enc<Mxe, Record>; MAX_BATCHES] = std::array::from_fn(|b| {
        if b < active {
            record_enc(std::array::from_fn(|k| bids.get(4 * b + k).copied().unwrap_or((0, 0))))
        } else {
            record_enc([(777, u64::MAX); 4])
        }
    });
    ix.eval((records, active as u8, is_token, price_unit, supply))
}

/// The clearing price by brute force: the highest price below 2^32 whose
/// demand covers the supply, with the weight above and at it. A bid's weight
/// is its quantity: a budget for tokens, NFTs for a collection.
fn reference(bids: &[(u32, u64)], is_token: bool, price_unit: u64, supply: u64) -> Clearing {
    let weight = |i: usize| -> u128 { bids[i].1 as u128 };
    let demand = |c: u64| -> u128 {
        (0..bids.len()).filter(|&i| bids[i].0 as u64 >= c && bids[i].0 > 0).map(weight).sum()
    };
    let covered = |c: u64| -> bool {
        if is_token {
            demand(c) * price_unit as u128 >= supply as u128 * c as u128
        } else {
            demand(c) >= supply as u128
        }
    };
    // Demand only changes at bid prices, so the answer is a bid price or the
    // largest price below the next bid price where the budget runs out.
    let mut candidates: Vec<u64> = bids.iter().map(|b| b.0 as u64).collect();
    candidates.push(0);
    let mut best = 0u64;
    for &p in &candidates {
        if p > 0 && covered(p) {
            best = best.max(p);
        }
    }
    if is_token {
        // Between bid prices demand is flat while the cost grows, so the
        // highest covered price can also sit just below a bid price.
        let mut lo = best;
        let mut hi = u32::MAX as u64;
        while lo < hi {
            let mid = lo + (hi - lo + 1) / 2;
            if covered(mid) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        best = lo;
    }
    let above: u128 = (0..bids.len()).filter(|&i| bids[i].0 as u64 > best).map(weight).sum();
    let at: u128 = (0..bids.len()).filter(|&i| bids[i].0 as u64 == best).map(weight).sum();
    (best as u32, above, at)
}

fn award(record: [(u32, u64); 4], slot: u8, price: u32, filled: bool) -> (u8, u64) {
    get_instruction("award_bid_v2").eval((record_enc(record), slot, price, filled))
}

fn award_all(record: [(u32, u64); 4], price: u32, filled: bool) -> ([u8; 4], [u64; 4]) {
    get_instruction("award_batch").eval((record_enc(record), price, filled))
}

// ---------------------------------------------------------------------------
// check_bids
// ---------------------------------------------------------------------------

#[test]
fn token_bids_count_from_the_minimum_price_with_a_covered_budget() {
    let record = check_tokens(
        [(bid(500, 10_000), 10_000), (bid(99, 5_000), 5_000), (bid(100, 900), 1_000), (bid(4_000_000_000, 7), 7)],
        4,
        100,
        5,
    );
    // Below the minimum price is no bid; a budget the deposit covers counts.
    assert_eq!(record, [(500, 10_000), (0, 0), (100, 900), (4_000_000_000, 7)]);
}

#[test]
fn token_budgets_stay_within_the_deposit_and_above_the_minimum() {
    let record = check_tokens(
        [(bid(500, 10_001), 10_000), (bid(500, 4), u64::MAX), (bid(500, 0), u64::MAX), (bid(500, u64::MAX), u64::MAX)],
        4,
        100,
        5,
    );
    // Over the deposit, under the minimum, or empty: no bid. The whole u64
    // range is a valid budget when the deposit covers it.
    assert_eq!(record, [(0, 0), (0, 0), (0, 0), (500, u64::MAX)]);
    // A deposit far above the budget hides it, and only the budget counts.
    let record = check_tokens([(bid(300, 25), 1_000_000), (bid(0, 1), 1), (bid(0, 1), 1), (bid(0, 1), 1)], 1, 1, 1);
    assert_eq!(record, [(300, 25), (0, 0), (0, 0), (0, 0)]);
}

#[test]
fn padding_slots_are_recorded_empty() {
    let record = check_tokens(
        [(bid(500, 10), 10_000), (bid(600, 10), 10_000), (bid(700, 10), 10_000), (bid(800, 10), 10_000)],
        2,
        100,
        1,
    );
    assert_eq!(record, [(500, 10), (600, 10), (0, 0), (0, 0)]);
}

#[test]
fn nft_bids_need_a_size_and_a_deposit_that_covers_them() {
    let record = check_nfts(
        [
            (bid(500, 2), nft_cost(500, 2)),
            (bid(500, 2), nft_cost(500, 2) - 1),
            (bid(500, 0), u64::MAX),
            (bid(500, MAX_PER_BID + 1), u64::MAX),
        ],
        4,
        100,
    );
    assert_eq!(record, [(500, 2), (0, 0), (0, 0), (0, 0)]);
    let record = check_nfts(
        [(bid(99, 1), u64::MAX), (bid(100, MAX_PER_BID), nft_cost(100, MAX_PER_BID)), (bid(0, 1), u64::MAX), (bid(1, 1), 0)],
        4,
        100,
    );
    assert_eq!(record, [(0, 0), (100, MAX_PER_BID), (0, 0), (0, 0)]);
}

// ---------------------------------------------------------------------------
// clear_price
// ---------------------------------------------------------------------------

#[test]
fn nft_clearing_is_the_lowest_winning_price() {
    let ix = get_instruction("clear_price_v2");
    // Demand: 2 at 500, 4 at 300, 7 at 200.
    let bids = [(500, 2), (300, 2), (200, 3)];
    assert_eq!(clear(&ix, &bids, false, 1, 5), (200, 4, 3));
    assert_eq!(clear(&ix, &bids, false, 1, 4), (300, 2, 2));
    assert_eq!(clear(&ix, &bids, false, 1, 2), (500, 0, 2));
    assert_eq!(clear(&ix, &bids, false, 1, 1), (500, 0, 2));
    // Never covered: no price qualifies and all valid demand is above 0.
    assert_eq!(clear(&ix, &bids, false, 1, 8), (0, 7, 0));
}

#[test]
fn tied_nft_bids_share_the_clearing_price() {
    let ix = get_instruction("clear_price_v2");
    let bids = [(100, 1); 4];
    assert_eq!(clear(&ix, &bids, false, 1, 3), (100, 0, 4));
}

#[test]
fn token_clearing_meets_the_budgets() {
    let ix = get_instruction("clear_price_v2");
    // price_unit 10 and supply 1_000: demand covers the supply at price c when
    // the budgets at or above c reach 100 * c.
    let bids = [(10, 500), (8, 300), (5, 400)];
    // At 8 the budgets at or above are 800 = 100 * 8; at 9 only 500.
    assert_eq!(clear(&ix, &bids, true, 10, 1_000), (8, 500, 300));
    // A single budget clears where it buys the whole supply: 500 >= 100 * 5.
    assert_eq!(clear(&ix, &[(20, 500)], true, 10, 1_000), (5, 500, 0));
    // Two equal bids at 10 buy everything at exactly their price.
    assert_eq!(clear(&ix, &[(10, 500), (10, 500)], true, 10, 1_000), (10, 0, 1_000));
}

#[test]
fn invalid_and_inactive_bids_never_count() {
    let ix = get_instruction("clear_price_v2");
    // Price 0 marks an invalid bid; its weight must not count anywhere.
    let bids = [(0, 9), (300, 2), (0, 0), (200, 3)];
    assert_eq!(clear(&ix, &bids, false, 1, 5), (200, 2, 3));
    let token = clear(&ix, &[(0, u64::MAX), (10, 500)], true, 10, 1_000);
    assert_eq!(token, (5, 500, 0));
}

#[test]
fn clearing_matches_brute_force() {
    let ix = get_instruction("clear_price_v2");
    let mut rng = thread_rng();
    for round in 0..6 {
        let n = [5usize, 17, 40, 64, 130, MAX_BIDS][round];
        let bids: Vec<(u32, u64)> = (0..n)
            .map(|_| {
                let valid = rng.gen_range(0..10) > 0;
                let price = if valid { rng.gen_range(1..200u32) * 1_000 + rng.gen_range(0..3u32) } else { 0 };
                (price, rng.gen_range(0..=MAX_PER_BID))
            })
            .map(|(p, q)| if q == 0 { (0, 0) } else { (p, if p == 0 { 0 } else { q }) })
            .collect();
        let supply = rng.gen_range(1..(n as u64 * 6));
        assert_eq!(
            clear(&ix, &bids, false, 1, supply),
            reference(&bids, false, 1, supply),
            "collection round {round}"
        );
        // Budgets up to the whole u64 range.
        let token_bids: Vec<(u32, u64)> = bids
            .iter()
            .map(|b| {
                let top = u64::MAX >> rng.gen_range(0..40);
                (b.0, if b.0 == 0 { 0 } else { rng.gen_range(1..=top) })
            })
            .collect();
        let supply = rng.gen_range(1..1_000_000_000_000u64);
        let unit = 10u64.pow(rng.gen_range(0..17));
        assert_eq!(
            clear(&ix, &token_bids, true, unit, supply),
            reference(&token_bids, true, unit, supply),
            "token round {round}"
        );
    }
}

// ---------------------------------------------------------------------------
// fold_batch (paged clearing)
// ---------------------------------------------------------------------------

/// Laid out like the circuit's `FoldState`: 17 totals of `Wide { lo: u64, hi: u16 }`.
type FoldState = Pack<[(u64, u16); 17]>;
/// `(digit, weight_above, weight_at)`, as the circuit's `FoldResult`.
type FoldResult = (u8, u128, u128);
const FOLD_PASSES: u32 = 8;

/// The records of one page holding `bids`; the empty slots past them are
/// junk, as the program passes the book's empty slots.
fn page_records(bids: &[(u32, u64)]) -> ([Enc<Mxe, Record>; MAX_BATCHES], u8) {
    assert!(bids.len() <= MAX_BIDS);
    let active = bids.len().div_ceil(4);
    let records = std::array::from_fn(|b| {
        if b < active {
            record_enc(std::array::from_fn(|k| bids.get(4 * b + k).copied().unwrap_or((0, 0))))
        } else {
            record_enc([(777, u64::MAX); 4])
        }
    });
    (records, active as u8)
}

/// Runs the paged clearing the way the program drives it: 8 passes, the
/// first over the pages forwards, the next backwards and so on, so the page
/// that ends a pass starts the next one in the same step. The encrypted state
/// goes from step to step and each pass's revealed digit joins the public
/// prefix. Returns the clearing and the number of steps.
fn fold_clear_steps(
    ix: &ArcisInstructionWithInfo,
    pages: &[Vec<(u32, u64)>],
    is_token: bool,
    price_unit: u64,
    supply: u64,
) -> (Clearing, usize) {
    assert!(pages.len() >= 2);
    let pages: Vec<_> = pages.iter().map(|bids| page_records(bids)).collect();
    let last_page = pages.len() - 1;
    // The first step ignores the state it is given; give it junk.
    let mut state: Enc<Mxe, FoldState> = Mxe::get().from_arcis(Pack::new([(55_555u64, 77u16); 17]));
    let (mut pass, mut page, mut prefix, mut steps) = (0u32, 0usize, 0u64, 0usize);
    loop {
        let shift = 28 - 4 * pass;
        let decide = page == if pass % 2 == 0 { last_page } else { 0 };
        let last_pass = pass + 1 == FOLD_PASSES;
        let (records, active) = &pages[page];
        let (next, result): (Enc<Mxe, FoldState>, FoldResult) = ix.eval((
            (state, records, *active, steps == 0, decide, last_pass),
            (prefix, shift as u8, 1u64 << shift, is_token, price_unit, supply),
        ));
        steps += 1;
        state = next;
        if !decide {
            // Nothing is revealed before the end of a pass.
            assert_eq!(result, (0, 0, 0));
            page = if pass % 2 == 0 { page + 1 } else { page - 1 };
            continue;
        }
        assert!(result.0 < 16, "digit {result:?}");
        prefix += (result.0 as u64) << shift;
        if last_pass {
            return ((u32::try_from(prefix).unwrap(), result.1, result.2), steps);
        }
        assert_eq!((result.1, result.2), (0, 0));
        pass += 1;
        page = if pass % 2 == 0 { page + 1 } else { page - 1 };
    }
}

fn fold_clear(
    ix: &ArcisInstructionWithInfo,
    pages: &[Vec<(u32, u64)>],
    is_token: bool,
    price_unit: u64,
    supply: u64,
) -> Clearing {
    let (clearing, steps) = fold_clear_steps(ix, pages, is_token, price_unit, supply);
    assert_eq!(steps, 8 * (pages.len() - 1) + 1);
    clearing
}

/// Splits bids into pages of the given sizes.
fn paged(bids: &[(u32, u64)], sizes: &[usize]) -> Vec<Vec<(u32, u64)>> {
    let mut rest = bids;
    let pages = sizes
        .iter()
        .map(|&n| {
            let (page, tail) = rest.split_at(n);
            rest = tail;
            page.to_vec()
        })
        .collect();
    assert!(rest.is_empty());
    pages
}

#[test]
fn folding_pages_finds_the_nft_clearing() {
    let ix = get_instruction("fold_batch_v2");
    // Demand: 2 at 500, 4 at 300, 7 at 200, spread over three pages.
    let pages = vec![vec![(300, 2)], vec![(500, 2), (0, 9)], vec![(200, 3)]];
    assert_eq!(fold_clear(&ix, &pages, false, 1, 5), (200, 4, 3));
    assert_eq!(fold_clear(&ix, &pages, false, 1, 4), (300, 2, 2));
    assert_eq!(fold_clear(&ix, &pages, false, 1, 1), (500, 0, 2));
    // Never covered: all valid demand is above price 0. (What sits "at" 0
    // is the weight of price-0 entries; checked records never have any, and
    // the program ignores the weight at the price without a fill.)
    assert_eq!(fold_clear(&ix, &pages, false, 1, 8), (0, 7, 9));
}

#[test]
fn folding_pages_finds_the_token_clearing() {
    let ix = get_instruction("fold_batch_v2");
    let pages = vec![vec![(10, 500)], vec![(8, 300), (5, 400)]];
    assert_eq!(fold_clear(&ix, &pages, true, 10, 1_000), (8, 500, 300));
    // The price can fall between bid prices: one budget buying everything.
    assert_eq!(fold_clear(&ix, &[vec![], vec![(20, 500)]], true, 10, 1_000), (5, 500, 0));
}

#[test]
fn folding_reaches_the_top_of_the_price_range() {
    let ix = get_instruction("fold_batch_v2");
    // Prices at the very top and right at digit boundaries.
    let top = vec![vec![(u32::MAX, 1)], vec![(u32::MAX - 1, 1), (1 << 28, 1)]];
    assert_eq!(fold_clear(&ix, &top, false, 1, 1), (u32::MAX, 0, 1));
    assert_eq!(fold_clear(&ix, &top, false, 1, 2), (u32::MAX - 1, 1, 1));
    assert_eq!(fold_clear(&ix, &top, false, 1, 3), (1 << 28, 2, 1));
    let edges = vec![vec![((1 << 28) - 1, 1), (15 << 28, 1)], vec![(15, 1), (16, 1)], vec![(17, 2)]];
    assert_eq!(fold_clear(&ix, &edges, false, 1, 2), ((1 << 28) - 1, 1, 1));
    assert_eq!(fold_clear(&ix, &edges, false, 1, 3), (17, 2, 2));
    assert_eq!(fold_clear(&ix, &edges, false, 1, 5), (16, 4, 1));
    assert_eq!(fold_clear(&ix, &edges, false, 1, 6), (15, 5, 1));
}

#[test]
fn folding_matches_one_page_clearing_and_brute_force() {
    let fold = get_instruction("fold_batch_v2");
    let clear_ix = get_instruction("clear_price_v2");
    let mut rng = thread_rng();
    for round in 0..4 {
        let sizes: &[usize] = [&[3usize, 9][..], &[40, 1, 22], &[64, 64, 64, 64], &[200, 56]][round];
        let n: usize = sizes.iter().sum();
        let bids: Vec<(u32, u64)> = (0..n)
            .map(|_| {
                let valid = rng.gen_range(0..10) > 0;
                // Prices from all over the range, with ties.
                let price = if !valid {
                    0
                } else if rng.gen_bool(0.3) {
                    rng.gen_range(1..=u32::MAX)
                } else {
                    rng.gen_range(1..60u32) * 997
                };
                (price, if price == 0 { 0 } else { rng.gen_range(1..=MAX_PER_BID) })
            })
            .collect();
        let pages = paged(&bids, sizes);
        let supply = rng.gen_range(1..(n as u64 * 6));
        let expected = reference(&bids, false, 1, supply);
        assert_eq!(fold_clear(&fold, &pages, false, 1, supply), expected, "collection round {round}");
        if n <= MAX_BIDS {
            assert_eq!(clear(&clear_ix, &bids, false, 1, supply), expected, "one page, round {round}");
        }
        let token_bids: Vec<(u32, u64)> = bids
            .iter()
            .map(|b| {
                let top = u64::MAX >> rng.gen_range(0..40);
                (b.0, if b.0 == 0 { 0 } else { rng.gen_range(1..=top) })
            })
            .collect();
        let supply = rng.gen_range(1..1_000_000_000_000u64);
        let unit = 10u64.pow(rng.gen_range(0..17));
        assert_eq!(
            fold_clear(&fold, &paged(&token_bids, sizes), true, unit, supply),
            reference(&token_bids, true, unit, supply),
            "token round {round}"
        );
    }
}

// ---------------------------------------------------------------------------
// award_bid
// ---------------------------------------------------------------------------

#[test]
fn token_awards_reveal_only_winning_budgets() {
    let record = [(500, 7_000_000), (300, 2_000_000), (200, 9_000_000), (0, 0)];
    assert_eq!(award(record, 0, 300, true), (1, 7_000_000));
    assert_eq!(award(record, 1, 300, true), (2, 2_000_000));
    assert_eq!(award(record, 2, 300, true), (0, 0)); // a losing budget stays hidden
    assert_eq!(award(record, 3, 300, true), (0, 0));
}

#[test]
fn awards_follow_the_clearing_price() {
    let record = [(500, 2), (300, 2), (200, 3), (0, 0)];
    assert_eq!(award(record, 0, 300, true), (1, 2)); // above
    assert_eq!(award(record, 1, 300, true), (2, 2)); // at
    assert_eq!(award(record, 2, 300, true), (0, 0)); // below
    assert_eq!(award(record, 3, 300, true), (0, 0)); // invalid
    // Not filled: every valid bid wins in full.
    assert_eq!(award(record, 2, 0, false), (1, 3));
    assert_eq!(award(record, 3, 0, false), (0, 0));
}

/// Checks one encrypted bid in slot 0 and awards it from the record of that
/// same check, as the program does.
fn check_then_award(tricky: Enc<Shared, (i128, u64)>, price: u32) -> ((u32, u64), (u8, u64)) {
    let ix = get_instruction("check_bids_v2");
    let record: Enc<Mxe, Record> = ix.eval((
        (tricky, u64::MAX, bid(0, 0), 0u64, bid(0, 0), 0u64),
        (bid(0, 0), 0u64, 1u8, false),
        (1u32, NFT_SCALE, MAX_PER_BID, 0u64),
    ));
    let checked = decrypt_record(&record)[0];
    let awarded: (u8, u64) = get_instruction("award_bid_v2").eval((record, 0u8, price, true));
    (checked, awarded)
}

/// A malformed price decodes differently from one evaluation to the next, so
/// the award must come from the record the check wrote: whatever the check
/// made of the bid, the award agrees with it.
#[test]
fn awards_agree_with_the_check_for_ambiguous_prices() {
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..30 {
        let tricky = bidder().from_arcis((-(1i128 << 40), 2u64));
        let (checked, awarded) = check_then_award(tricky, 1_000);
        let expected = if checked.0 == 0 {
            (0, 0)
        } else if checked.0 > 1_000 {
            (1, checked.1)
        } else if checked.0 == 1_000 {
            (2, checked.1)
        } else {
            (0, 0)
        };
        assert_eq!(awarded, expected, "checked {checked:?}");
        seen.insert(checked);
    }
    assert!(!seen.is_empty());
}

#[test]
fn seeds_are_drawn_at_random() {
    let ix = get_instruction("draw_seed");
    let seeds: Vec<u128> = (0..8).map(|_| ix.eval::<u128>(())).collect();
    // 128 random bits each: eight draws never repeat, and the high half is used.
    for (i, a) in seeds.iter().enumerate() {
        for b in &seeds[i + 1..] {
            assert_ne!(a, b);
        }
    }
    assert!(seeds.iter().any(|seed| seed >> 64 != 0));
}

#[test]
fn a_batch_is_decided_exactly_as_its_bids_one_by_one() {
    let records = [
        [(500, 7_000_000), (300, 2_000_000), (200, 1_000_000), (0, 0)],
        [(300, 2), (300, 5), (299, 1), (0, 0)],
        [(1, 1), (u32::MAX, u64::MAX), (300, 0), (301, 9)],
        [(0, 0); 4],
    ];
    for record in records {
        for (price, filled) in [(300, true), (300, false), (1, true), (u32::MAX, true)] {
            let (outcomes, quantities) = award_all(record, price, filled);
            for slot in 0..4u8 {
                assert_eq!(
                    (outcomes[slot as usize], quantities[slot as usize]),
                    award(record, slot, price, filled),
                    "record {record:?}, price {price}, filled {filled}, slot {slot}"
                );
            }
        }
    }
}
