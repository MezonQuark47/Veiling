//! Mock-MPC tests for the auction circuits. They evaluate the compiled IR in
//! `build/` with arcis' test harness, so build the circuits crate first.

use arcis::{testing::*, *};

const MAX_BATCHES: usize = 64;
const MAX_BIDS: usize = 4 * MAX_BATCHES;

/// Laid out like the circuit's `[CheckedBid { price: u32, quantity: u16 }; 4]`.
type Record = Pack<[(u32, u16); 4]>;
/// `(price, weight_above, weight_at)`.
type Clearing = (u32, u128, u128);

const NFT_SCALE: u64 = 1_000; // lamports per price tick of an NFT price
const MAX_PER_BID: u16 = 10;

fn bidder() -> Shared {
    Shared::new(ArcisX25519Pubkey::from_base58(b"test"))
}

/// An encrypted bid, laid out like the circuit's `BidInput { price: u32, quantity: u16 }`.
fn bid(price: u32, quantity: u16) -> Enc<Shared, (u32, u16)> {
    bidder().from_arcis((price, quantity))
}

fn record_enc(entries: [(u32, u16); 4]) -> Enc<Mxe, Record> {
    Mxe::get().from_arcis(Pack::new(entries))
}

fn decrypt_record(record: &Enc<Mxe, Record>) -> [(u32, u16); 4] {
    record.to_arcis().unpack()
}

/// `check_bids` for a token auction (budgets are the deposits).
fn check_tokens(bids: [(Enc<Shared, (u32, u16)>, u64); 4], active: u8, min_price: u32) -> [(u32, u16); 4] {
    let ix = get_instruction("check_bids");
    let [b0, b1, b2, b3] = bids;
    let record: Enc<Mxe, Record> = ix.eval((
        (b0.0, b0.1, b1.0, b1.1, b2.0, b2.1),
        (b3.0, b3.1, active, true, min_price, 1u64, 0u16),
    ));
    decrypt_record(&record)
}

/// `check_bids` for a collection auction.
fn check_nfts(bids: [(Enc<Shared, (u32, u16)>, u64); 4], active: u8, min_price: u32) -> [(u32, u16); 4] {
    let ix = get_instruction("check_bids");
    let [b0, b1, b2, b3] = bids;
    let record: Enc<Mxe, Record> = ix.eval((
        (b0.0, b0.1, b1.0, b1.1, b2.0, b2.1),
        (b3.0, b3.1, active, false, min_price, NFT_SCALE, MAX_PER_BID),
    ));
    decrypt_record(&record)
}

/// What an NFT bid has to deposit.
fn nft_cost(price: u32, quantity: u16) -> u64 {
    price as u64 * NFT_SCALE * quantity as u64
}

/// Runs `clear_price` on checked bids (in bid order) and their deposits. The
/// unused records are junk, as the program passes the book's empty slots.
fn clear(
    ix: &ArcisInstructionWithInfo,
    bids: &[(u32, u16)],
    deposits: &[u64],
    is_token: bool,
    price_unit: u64,
    supply: u64,
) -> Clearing {
    assert!(bids.len() <= MAX_BIDS && deposits.len() == bids.len());
    let active = bids.len().div_ceil(4);
    let records: [Enc<Mxe, Record>; MAX_BATCHES] = std::array::from_fn(|b| {
        if b < active {
            record_enc(std::array::from_fn(|k| bids.get(4 * b + k).copied().unwrap_or((0, 0))))
        } else {
            record_enc([(777, 7); 4])
        }
    });
    let deposit = |i: usize| deposits.get(i).copied().unwrap_or(0) as u128;
    let pairs: [u128; MAX_BIDS / 2] = std::array::from_fn(|j| deposit(2 * j) | (deposit(2 * j + 1) << 64));
    ix.eval((records, pairs, active as u8, is_token, price_unit, supply))
}

/// The clearing price by brute force: the highest price below 2^32 whose
/// demand covers the supply, with the weight above and at it.
fn reference(bids: &[(u32, u16)], deposits: &[u64], is_token: bool, price_unit: u64, supply: u64) -> Clearing {
    let weight = |i: usize| -> u128 {
        if is_token {
            deposits[i] as u128
        } else {
            bids[i].1 as u128
        }
    };
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

fn award(record: [(u32, u16); 4], slot: u8, price: u32, filled: bool) -> (u8, u16) {
    get_instruction("award_bid").eval((record_enc(record), slot, price, filled))
}

// ---------------------------------------------------------------------------
// check_bids
// ---------------------------------------------------------------------------

#[test]
fn token_bids_count_from_the_minimum_price() {
    let record = check_tokens(
        [(bid(500, 0), 10_000), (bid(99, 3), 5_000), (bid(100, 9), 1), (bid(4_000_000_000, 0), 7)],
        4,
        100,
    );
    // The quantity of a token bid is ignored; below the minimum is no bid.
    assert_eq!(record, [(500, 0), (0, 0), (100, 0), (4_000_000_000, 0)]);
}

#[test]
fn padding_slots_are_recorded_empty() {
    let record = check_tokens(
        [(bid(500, 0), 10_000), (bid(600, 0), 10_000), (bid(700, 0), 10_000), (bid(800, 0), 10_000)],
        2,
        100,
    );
    assert_eq!(record, [(500, 0), (600, 0), (0, 0), (0, 0)]);
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
    let ix = get_instruction("clear_price");
    // Demand: 2 at 500, 4 at 300, 7 at 200.
    let bids = [(500, 2), (300, 2), (200, 3)];
    let deposits = [0; 3];
    assert_eq!(clear(&ix, &bids, &deposits, false, 1, 5), (200, 4, 3));
    assert_eq!(clear(&ix, &bids, &deposits, false, 1, 4), (300, 2, 2));
    assert_eq!(clear(&ix, &bids, &deposits, false, 1, 2), (500, 0, 2));
    assert_eq!(clear(&ix, &bids, &deposits, false, 1, 1), (500, 0, 2));
    // Never covered: no price qualifies and all valid demand is above 0.
    assert_eq!(clear(&ix, &bids, &deposits, false, 1, 8), (0, 7, 0));
}

#[test]
fn tied_nft_bids_share_the_clearing_price() {
    let ix = get_instruction("clear_price");
    let bids = [(100, 1); 4];
    assert_eq!(clear(&ix, &bids, &[0; 4], false, 1, 3), (100, 0, 4));
}

#[test]
fn token_clearing_meets_the_budgets() {
    let ix = get_instruction("clear_price");
    // price_unit 10 and supply 1_000: demand covers the supply at price c when
    // the budgets at or above c reach 100 * c.
    let bids = [(10, 0), (8, 0), (5, 0)];
    let deposits = [500, 300, 400];
    // At 8 the budgets at or above are 800 = 100 * 8; at 9 only 500.
    assert_eq!(clear(&ix, &bids, &deposits, true, 10, 1_000), (8, 500, 300));
    // A single budget clears where it buys the whole supply: 500 >= 100 * 5.
    assert_eq!(clear(&ix, &[(20, 0)], &[500], true, 10, 1_000), (5, 500, 0));
    // Two equal bids at 10 buy everything at exactly their price.
    assert_eq!(clear(&ix, &[(10, 0), (10, 0)], &[500, 500], true, 10, 1_000), (10, 0, 1_000));
}

#[test]
fn invalid_and_inactive_bids_never_count() {
    let ix = get_instruction("clear_price");
    // Price 0 marks an invalid bid; its weight must not count anywhere.
    let bids = [(0, 9), (300, 2), (0, 0), (200, 3)];
    assert_eq!(clear(&ix, &bids, &[u64::MAX, 0, u64::MAX, 0], false, 1, 5), (200, 2, 3));
    let token = clear(&ix, &[(0, 0), (10, 0)], &[u64::MAX, 500], true, 10, 1_000);
    assert_eq!(token, (5, 500, 0));
}

#[test]
fn clearing_matches_brute_force() {
    let ix = get_instruction("clear_price");
    let mut rng = thread_rng();
    for round in 0..6 {
        let n = [5usize, 17, 40, 64, 130, MAX_BIDS][round];
        let bids: Vec<(u32, u16)> = (0..n)
            .map(|_| {
                let valid = rng.gen_range(0..10) > 0;
                let price = if valid { rng.gen_range(1..200u32) * 1_000 + rng.gen_range(0..3u32) } else { 0 };
                (price, rng.gen_range(0..=MAX_PER_BID))
            })
            .map(|(p, q)| if q == 0 { (0, 0) } else { (p, if p == 0 { 0 } else { q }) })
            .collect();
        let supply = rng.gen_range(1..(n as u64 * 6));
        assert_eq!(
            clear(&ix, &bids, &vec![0; n], false, 1, supply),
            reference(&bids, &vec![0; n], false, 1, supply),
            "collection round {round}"
        );
        let token_bids: Vec<(u32, u16)> = bids.iter().map(|b| (b.0, 0)).collect();
        let deposits: Vec<u64> = (0..n).map(|_| rng.gen_range(1..5_000_000_000u64)).collect();
        let supply = rng.gen_range(1..1_000_000_000_000u64);
        let unit = 10u64.pow(rng.gen_range(0..10));
        assert_eq!(
            clear(&ix, &token_bids, &deposits, true, unit, supply),
            reference(&token_bids, &deposits, true, unit, supply),
            "token round {round}"
        );
    }
}

// ---------------------------------------------------------------------------
// award_bid
// ---------------------------------------------------------------------------

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
fn check_then_award(tricky: Enc<Shared, (i128, u16)>, price: u32) -> ((u32, u16), (u8, u16)) {
    let ix = get_instruction("check_bids");
    let record: Enc<Mxe, Record> = ix.eval((
        (tricky, u64::MAX, bid(0, 0), 0u64, bid(0, 0), 0u64),
        (bid(0, 0), 0u64, 1u8, false, 1u32, NFT_SCALE, MAX_PER_BID),
    ));
    let checked = decrypt_record(&record)[0];
    let awarded: (u8, u16) = get_instruction("award_bid").eval((record, 0u8, price, true));
    (checked, awarded)
}

/// A malformed price decodes differently from one evaluation to the next, so
/// the award must come from the record the check wrote: whatever the check
/// made of the bid, the award agrees with it.
#[test]
fn awards_agree_with_the_check_for_ambiguous_prices() {
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..30 {
        let tricky = bidder().from_arcis((-(1i128 << 40), 2u16));
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
