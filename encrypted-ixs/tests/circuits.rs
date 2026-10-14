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
