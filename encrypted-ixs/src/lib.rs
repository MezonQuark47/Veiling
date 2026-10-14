//! Encrypted circuits for a sealed-bid, uniform-price auction with open
//! prices: every bid names any price it likes, the highest bids win and every
//! winner pays the same clearing price.
//!
//! A bid is a private `(price, quantity)` pair. Prices are whole "price
//! ticks" (a u32); the auction fixes what a tick is worth.
//! - Token auctions: `quantity` is the bid's budget in lamports, the most it
//!   spends, and `price` the highest price per token it accepts. The budget
//!   is private too: the public deposit only has to cover it, so a deposit
//!   says nothing exact about the demand behind it.
//! - Collection auctions: a bid asks for `quantity` NFTs at up to `price`
//!   each, and its deposit must cover that.
//!
//! The circuits carry a `_v2` suffix: the first version took token budgets
//! from the public deposits, and its computation definitions stay registered
//! under the old names.
//!
//! Flow after bidding closes:
//! 1. `check_bids_v2` decodes and checks bids four at a time and stores them as
//!    one MXE-encrypted batch record. An invalid bid is recorded as price 0,
//!    which never wins.
//! 2. `clear_price_v2` reads every batch record and finds the clearing price
//!    exactly, bit by bit from the top: the highest price at which demand
//!    covers the supply. Only that price and the demand above and at it are
//!    revealed.
//! 3. `award_bid_v2` decides one bid's outcome from its batch record against
//!    that public result, and reveals its size (budget or NFTs) only if it
//!    wins something: the program needs it to work out the award in the
//!    open. A losing bid's price and size are never revealed.
//! 4. Collections only: once every bid is settled, `draw_seed` draws the
//!    random seed that decides which NFTs each winner gets.
//!
//! One `clear_price_v2` reads one page of the bid book: 64 batch records,
//! 256 bids. An auction with more pages (up to four, 1,024 bids) finds the
//! same clearing price with `fold_batch_v2` instead, which reads one page at a
//! time and carries what it found in an MXE-encrypted state from one step to
//! the next. See `fold_batch_v2`.
//!
//! Each client ciphertext is decoded exactly once, in `check_bids_v2`. A
//! malformed plaintext (a value outside its type's range) decodes to some
//! value in range, but not necessarily the same one twice, so the clearing
//! and every award come from that single decoding.

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Bits of a price; prices are u32 price ticks.
    pub const PRICE_BITS: usize = 32;
    /// Bids checked per computation and stored per batch record.
    pub const BATCH_SIZE: usize = 4;
    /// Batch records an auction can have.
    pub const MAX_BATCHES: usize = 64;
    pub const MAX_BIDS: usize = BATCH_SIZE * MAX_BATCHES;
    /// A bidder's private order, encrypted client-side.
    #[derive(Clone, Copy)]
    pub struct BidInput {
        pub price: u32,
        /// Lamports of budget for a token bid, NFTs for a collection bid.
        pub quantity: u64,
    }

    /// A bid after checking. `price == 0` means it does not count.
    #[derive(Clone, Copy)]
    pub struct CheckedBid {
        pub price: u32,
        pub quantity: u64,
    }

    /// The checked bids of one batch, packed into two ciphertexts.
    pub type BatchRecord = Pack<[CheckedBid; BATCH_SIZE]>;

    /// Revealed result of `clear_price`.
    pub struct Clearing {
        /// Highest price at which demand covers the supply; below the
        /// auction's minimum price when it never does.
        pub price: u32,
        /// Demand strictly above `price` and exactly at it: lamports of
        /// budget for a token auction, NFTs for a collection auction.
        pub weight_above: u128,
        pub weight_at: u128,
    }

    /// Revealed outcome for one bid.
    pub struct Award {
        /// 0 = nothing, 1 = above the clearing price (or every valid bid when
        /// demand never covered the supply), 2 = exactly at it.
        pub outcome: u8,
        /// For outcomes 1 and 2: the bid's budget in lamports (tokens) or
        /// the NFTs it asked for (collections). 0 otherwise.
        pub quantity: u64,
    }

    /// Checks one bid against the public terms and its deposit.
    ///
    /// A token bid needs a budget of at least `min_budget` (and at least one
    /// lamport) that its deposit covers. A collection bid needs 1 to
    /// `max_quantity` NFTs and a deposit that covers them at its price.
    fn check_bid(
        bid: BidInput,
        deposit: u64,
        is_token: bool,
        min_price: u32,
        price_scale: u64,
        max_quantity: u64,
        min_budget: u64,
    ) -> CheckedBid {
        let price_ok = bid.price >= min_price;
        let budget_ok = bid.quantity >= min_budget && bid.quantity >= 1u64 && bid.quantity <= deposit;
        let quantity_ok = bid.quantity >= 1u64 && bid.quantity <= max_quantity;
        // An out-of-range size is invalid anyway; leaving it out keeps
        // price * scale * size below 2^32 * 2^64 * 2^16, inside a u128.
        let size = if quantity_ok { bid.quantity } else { 0u64 };
        let cost = (bid.price as u128) * (price_scale as u128) * (size as u128);
        let funded = cost <= deposit as u128;
        let valid = if is_token {
            price_ok && budget_ok
        } else {
            price_ok && quantity_ok && funded
        };
        CheckedBid {
            price: if valid { bid.price } else { 0u32 },
            quantity: if valid { bid.quantity } else { 0u64 },
        }
    }

    /// Checks a batch of up to four bids and records them for `clear_price`
    /// and `award_bid`. Slots at or beyond `active_count` are padding and are
    /// recorded as empty. The record is encrypted under a fresh nonce.
    #[instruction]
    #[allow(clippy::too_many_arguments)]
    pub fn check_bids_v2(
        bid_0: Enc<Shared, BidInput>,
        deposit_0: u64,
        bid_1: Enc<Shared, BidInput>,
        deposit_1: u64,
        bid_2: Enc<Shared, BidInput>,
        deposit_2: u64,
        bid_3: Enc<Shared, BidInput>,
        deposit_3: u64,
        active_count: u8,
        is_token: bool,
        min_price: u32,
        price_scale: u64,
        max_quantity: u64,
        min_budget: u64,
    ) -> Enc<Mxe, BatchRecord> {
        let bids = [bid_0.to_arcis(), bid_1.to_arcis(), bid_2.to_arcis(), bid_3.to_arcis()];
        let deposits = [deposit_0, deposit_1, deposit_2, deposit_3];
        let mut record = [CheckedBid {
            price: 0u32,
            quantity: 0u64,
        }; BATCH_SIZE];
        for k in 0..BATCH_SIZE {
            let checked = check_bid(
                bids[k],
                deposits[k],
                is_token,
                min_price,
                price_scale,
                max_quantity,
                min_budget,
            );
            let active = (k as u8) < active_count;
            record[k] = CheckedBid {
                price: if active { checked.price } else { 0u32 },
                quantity: if active { checked.quantity } else { 0u64 },
            };
        }
        Mxe::get().from_arcis(Pack::new(record))
    }

    /// Finds the clearing price from every batch record.
    ///
    /// Demand at price `c` is the weight of the bids at or above `c`: their
    /// private budgets for a token auction, their quantities for a
    /// collection; either way the `quantity` each record holds. It
    /// covers the supply when `demand * price_unit >= supply * c` (tokens:
    /// the budgets buy the whole supply at `c`) or `demand >= supply`
    /// (collections). Demand only falls as `c` rises, so the highest such `c`
    /// is found bit by bit from the top, keeping for each bid whether its
    /// price still matches the bits chosen so far.
    ///
    /// Records at or beyond `active_batches` are ignored.
    #[instruction]
    pub fn clear_price_v2(
        records: [Enc<Mxe, BatchRecord>; MAX_BATCHES],
        active_batches: u8,
        is_token: bool,
        price_unit: u64,
        supply: u64,
    ) -> Clearing {
        let mut prices = [0u32; MAX_BIDS];
        let mut weights = [0u128; MAX_BIDS];
        for b in 0..MAX_BATCHES {
            let record = records[b].to_arcis().unpack();
            let active = (b as u8) < active_batches;
            for k in 0..BATCH_SIZE {
                let i = b * BATCH_SIZE + k;
                prices[i] = record[k].price;
                weights[i] = if active { record[k].quantity as u128 } else { 0u128 };
            }
        }
        // Token demand is compared as budget * price_unit against
        // supply * price; the program keeps price_unit <= 10^16, so with at
        // most 256 budgets below 2^64 neither side reaches 2^128.
        let scale = if is_token { price_unit as u128 } else { 1u128 };
        let mut equal = [true; MAX_BIDS];
        let mut weight_above = 0u128;
        let mut prefix = 0u32;
        for step in 0..PRICE_BITS {
            let k = (PRICE_BITS - 1 - step) as u32;
            let candidate = prefix + (1u32 << k);
            // Bids still level with the prefix whose next bit is set: with
            // the bids already above, they are the demand at `candidate`.
            let mut rising = [false; MAX_BIDS];
            let mut rising_weight = 0u128;
            for i in 0..MAX_BIDS {
                let bit = ((prices[i] >> k) & 1u32) == 1u32;
                let r = equal[i] && bit;
                rising[i] = r;
                rising_weight = rising_weight + if r { weights[i] } else { 0u128 };
            }
            let demand = weight_above + rising_weight;
            let needed = if is_token {
                (supply as u128) * (candidate as u128)
            } else {
                supply as u128
            };
            let take = demand * scale >= needed;
            prefix = if take { candidate } else { prefix };
            weight_above = if take { weight_above } else { demand };
            for i in 0..MAX_BIDS {
                // Taking the bit keeps the rising bids level; otherwise they
                // are now above the prefix and the others stay level.
                equal[i] = if take { rising[i] } else { equal[i] != rising[i] };
            }
        }
        let mut weight_at = 0u128;
        for i in 0..MAX_BIDS {
            weight_at = weight_at + if equal[i] { weights[i] } else { 0u128 };
        }
        Clearing {
            price: prefix,
            weight_above,
            weight_at,
        }
        .reveal()
    }

    /// Decides the bid in `slot` of a batch record against the public
    /// clearing price. Reveals the size (a token bid's budget, a collection
    /// bid's NFTs) only when the bid wins something.
    #[instruction]
    pub fn award_bid_v2(
        record_ctxt: Enc<Mxe, BatchRecord>,
        slot: u8,
        clearing_price: u32,
        filled: bool,
    ) -> Award {
        let record = record_ctxt.to_arcis().unpack();
        let mut bid = CheckedBid {
            price: 0u32,
            quantity: 0u64,
        };
        for k in 0..BATCH_SIZE {
            if slot == k as u8 {
                bid = record[k];
            }
        }
        let counts = bid.price > 0u32;
        let above = counts && (!filled || bid.price > clearing_price);
        let at = counts && filled && bid.price == clearing_price;
        let outcome = if above {
            1u8
        } else if at {
            2u8
        } else {
            0u8
        };
        Award {
            outcome,
            quantity: if above || at { bid.quantity } else { 0u64 },
        }
        .reveal()
    }

    /// Digit values of one `fold_batch_v2` pass: each pass fixes the next
    /// four bits of the clearing price, so 8 passes fix all 32.
    pub const RADIX: usize = 16;
    pub const DIGIT_BITS: usize = 4;
    /// Values `fold_batch_v2` carries between steps: the demand above the
    /// digits fixed so far, then the demand at each value of the next digit.
    pub const FOLD_VALUES: usize = RADIX + 1;

    /// A demand total. Demand never reaches 2^80 (at most 1,024 budgets, each
    /// within a real deposit, below 2^60 lamports), so it travels as 80 bits.
    #[derive(Clone, Copy)]
    pub struct Wide {
        pub lo: u64,
        pub hi: u16,
    }

    /// What `fold_batch_v2` carries from one step to the next, encrypted for
    /// the MXE: `FOLD_VALUES` totals packed into seven ciphertexts.
    pub type FoldState = Pack<[Wide; FOLD_VALUES]>;

    fn widen(w: Wide) -> u128 {
        ((w.hi as u128) << 64) + (w.lo as u128)
    }

    fn narrow(v: u128) -> Wide {
        Wide {
            lo: v as u64,
            hi: (v >> 64) as u16,
        }
    }

    /// Which of the 16 values a 4-bit digit (least significant bit first)
    /// has, as one flag per value.
    fn one_hot(d: [bool; DIGIT_BITS]) -> [bool; RADIX] {
        let mut low = [false; 4];
        let mut high = [false; 4];
        for c in 0..4 {
            let b0 = c % 2 == 1;
            let b1 = c / 2 == 1;
            low[c] = (if b0 { d[0] } else { !d[0] }) && (if b1 { d[1] } else { !d[1] });
            high[c] = (if b0 { d[2] } else { !d[2] }) && (if b1 { d[3] } else { !d[3] });
        }
        let mut out = [false; RADIX];
        for k in 0..RADIX {
            out[k] = low[k % 4] && high[k / 4];
        }
        out
    }

    /// The four bits of a price from bit `j` up, where `starts[j]` is set for
    /// exactly one public `j`.
    fn digit_at(bits: [bool; PRICE_BITS], starts: [bool; PRICE_BITS]) -> [bool; DIGIT_BITS] {
        let mut digit = [false; DIGIT_BITS];
        for i in 0..DIGIT_BITS {
            let mut bit = false;
            for j in 0..PRICE_BITS {
                if j + i < PRICE_BITS {
                    bit = bit ^ (starts[j] && bits[j + i]);
                }
            }
            digit[i] = bit;
        }
        digit
    }

    /// Revealed by `fold_batch_v2`. Zero except on a step that ends a pass
    /// (`digit`) and on the step that ends the last pass (the weights), so
    /// nothing is revealed that the final clearing does not reveal anyway.
    pub struct FoldResult {
        /// The digit of the clearing price this pass fixed, 0 to 15.
        pub digit: u8,
        /// As in `Clearing`, once the price is complete.
        pub weight_above: u128,
        pub weight_at: u128,
    }

    /// One step of the paged clearing: reads one page of batch records (up
    /// to 256 bids) for one digit of the clearing price.
    ///
    /// `clear_price_v2` fixes the price bit by bit with every bid at hand.
    /// Across pages that would take 32 rounds through every page, so this
    /// fixes four bits per pass instead, in 8 passes. A pass visits every
    /// page and adds up, by the value of the next digit, the demand of the
    /// bids level with the digits fixed so far (`prefix`; the digit is the
    /// four bits from `shift` up). The step that ends a pass (`decide`) then
    /// has the whole demand at each of the 16 candidates `prefix + t * step`
    /// (`step = 2^shift`), picks the highest one that covers the supply
    /// exactly as `clear_price_v2` does, and reveals that digit. The digits
    /// are the clearing price's own, which is public once complete, so
    /// revealing them a pass at a time reveals nothing more. The demand
    /// totals stay encrypted in the state.
    ///
    /// Reading a page costs far more than the arithmetic on it, so the step
    /// that ends a pass also starts the next one on the same page, with the
    /// digit it just found (unless `last_pass`). The program visits the pages
    /// forwards and backwards in turn, so the page that ends one pass begins
    /// the next: `8 * (pages - 1) + 1` steps in all.
    ///
    /// `fresh` marks the very first step; the state passed then is ignored.
    /// Records at or beyond `active_batches` are ignored.
    #[instruction]
    #[allow(clippy::too_many_arguments)]
    pub fn fold_batch_v2(
        state: Enc<Mxe, FoldState>,
        records: [Enc<Mxe, BatchRecord>; MAX_BATCHES],
        active_batches: u8,
        fresh: bool,
        decide: bool,
        last_pass: bool,
        prefix: u64,
        shift: u8,
        step: u64,
        is_token: bool,
        price_unit: u64,
        supply: u64,
    ) -> (Enc<Mxe, FoldState>, FoldResult) {
        let carried = state.to_arcis().unpack();
        let weight_above = if fresh { 0u128 } else { widen(carried[0]) };
        let mut buckets = [0u128; RADIX];
        for k in 0..RADIX {
            buckets[k] = if fresh { 0u128 } else { widen(carried[k + 1]) };
        }

        // Public, per bit of a price: whether it belongs to the digits fixed
        // so far and its value there, and where this digit and the next
        // pass's digit start.
        let mut fixed = [false; PRICE_BITS];
        let mut fixed_bit = [false; PRICE_BITS];
        let mut starts = [false; PRICE_BITS];
        let mut next_starts = [false; PRICE_BITS];
        for j in 0..PRICE_BITS {
            fixed[j] = (j as u8) >= shift + 4u8;
            fixed_bit[j] = ((prefix >> (j as u64)) & 1u64) == 1u64;
            starts[j] = (j as u8) == shift;
            next_starts[j] = (j as u8) + 4u8 == shift;
        }

        // This pass: each bid's demand, if level, by the value of its digit.
        let mut digits = [[false; RADIX]; MAX_BIDS];
        let mut next_digits = [[false; RADIX]; MAX_BIDS];
        let mut level_weights = [0u128; MAX_BIDS];
        for b in 0..MAX_BATCHES {
            let record = records[b].to_arcis().unpack();
            let active = (b as u8) < active_batches;
            for k in 0..BATCH_SIZE {
                let i = b * BATCH_SIZE + k;
                let price = record[k].price;
                let mut bits = [false; PRICE_BITS];
                for j in 0..PRICE_BITS {
                    bits[j] = ((price >> (j as u32)) & 1u32) == 1u32;
                }
                let mut level = active;
                for j in 0..PRICE_BITS {
                    level = level && (!fixed[j] || bits[j] == fixed_bit[j]);
                }
                digits[i] = one_hot(digit_at(bits, starts));
                next_digits[i] = one_hot(digit_at(bits, next_starts));
                let weight = if level { record[k].quantity as u128 } else { 0u128 };
                level_weights[i] = weight;
                for t in 0..RADIX {
                    buckets[t] = buckets[t] + if digits[i][t] { weight } else { 0u128 };
                }
            }
        }

        // The highest candidate whose demand covers the supply, as in
        // `clear_price_v2`. Candidate 0 is the prefix itself, which earlier
        // passes found covered (or is 0). Demand falls and the need rises
        // with the candidate, so the covered ones come first.
        let scale = if is_token { price_unit as u128 } else { 1u128 };
        let mut at_least = [0u128; RADIX + 1];
        for t in 0..RADIX {
            let k = RADIX - 1 - t;
            at_least[k] = at_least[k + 1] + buckets[k];
        }
        let mut covered = [false; RADIX + 1];
        covered[0] = true;
        for t in 1..RADIX {
            let candidate = prefix + (t as u64) * step;
            let needed = if is_token {
                (supply as u128) * (candidate as u128)
            } else {
                supply as u128
            };
            covered[t] = (weight_above + at_least[t]) * scale >= needed;
        }
        covered[RADIX] = false;
        let mut chosen = [false; RADIX];
        let mut digit = 0u8;
        let mut above_digit = 0u128;
        let mut at_digit = 0u128;
        for t in 0..RADIX {
            // Exactly one `t` is the last covered candidate.
            chosen[t] = covered[t] && !covered[t + 1];
            digit = digit + if chosen[t] { t as u8 } else { 0u8 };
            at_digit = at_digit + if chosen[t] { buckets[t] } else { 0u128 };
            above_digit = above_digit + if chosen[t] { at_least[t + 1] } else { 0u128 };
        }
        let new_above = weight_above + above_digit;

        // The next pass on this same page: the bids level with the new digit
        // too, by the value of the digit after it.
        let mut next_buckets = [0u128; RADIX];
        for i in 0..MAX_BIDS {
            let mut same = false;
            for t in 0..RADIX {
                same = same ^ (digits[i][t] && chosen[t]);
            }
            let weight = if same { level_weights[i] } else { 0u128 };
            for t in 0..RADIX {
                next_buckets[t] = next_buckets[t] + if next_digits[i][t] { weight } else { 0u128 };
            }
        }

        let done = decide && last_pass;
        let mut out = [narrow(0u128); FOLD_VALUES];
        out[0] = narrow(if decide { new_above } else { weight_above });
        for t in 0..RADIX {
            let value = if done {
                0u128
            } else if decide {
                next_buckets[t]
            } else {
                buckets[t]
            };
            out[t + 1] = narrow(value);
        }
        let result = FoldResult {
            digit: if decide { digit } else { 0u8 },
            weight_above: if done { new_above } else { 0u128 },
            weight_at: if done { at_digit } else { 0u128 },
        };
        (Mxe::get().from_arcis(Pack::new(out)), result.reveal())
    }

    /// Draws the seed that shuffles a collection's NFTs among its winners.
    /// The nodes generate it together, so no single one picks it, and the
    /// program only asks for it once every bid is settled and the winners'
    /// places are fixed, so nobody can steer which NFTs a win becomes.
    #[instruction]
    pub fn draw_seed() -> u128 {
        ArcisRNG::gen_integer_from_width(128).reveal()
    }
}
