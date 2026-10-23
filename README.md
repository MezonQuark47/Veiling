# Veiling: sealed-bid Dutch auctions on Solana

Veiling lets anyone sell a fixed-supply token, or a new NFT collection, through
a sealed-bid, uniform-price ("Dutch") auction. Bidders name any price they
like; the price, and the size of the bid, are encrypted in their browser and
stay encrypted on chain.
Arcium's multi-party computation (MPC) network finds a single clearing price
without any single party seeing individual bids. Every winner pays the same
price, and unused deposits are refunded.

> Status: **devnet prototype**. Not audited. Do not use with real funds.

## How an auction works

1. **Seller opens an auction** and pays the platform's listing fee.
   - A *token auction* escrows `supply` base units of the token. Only tokens
     whose mint and freeze authorities are revoked are accepted, and
     Token-2022 mints may only use the metadata extensions. The seller sets a
     minimum price per token and the smallest deposit and budget a bid may
     make.
   - A *collection auction* creates a new Metaplex Core collection of up to
     10,000 NFTs, with the auction as its update authority. Its NFTs are
     minted only when winners collect them. The seller sets a minimum price
     per NFT and the most NFTs one bid may ask for.

   Prices are whole *price ticks* (a u32). For a token they are lamports per
   `price_unit` base units, a power of ten the app picks so that the minimum
   price is about 10,000 ticks: fine enough for any typed price, with room for
   bids tens of thousands of times higher. For a collection a tick is 1,000
   lamports per NFT. Opening also creates the auction's bid book, one page of
   room for 256 bids. The book grows on its own: once every page is full, the
   next bid opens another (`open_book_page`, sent in front of it by the app),
   up to four pages (1,024 bids) for a token auction and forty (10,240 bids)
   for a collection, so even a 10,000-NFT collection can sell out at one NFT
   per bid. However many pages it has, it is one auction with one clearing
   price. The settlement fund, which by then holds
   every bid's crank fee, pays the caller the page's rent back, so neither the
   seller nor the bidder pays for room up front; the rent comes back to the
   seller when the auction is closed. A seller can still add pages ahead of
   time with `add_book_page` (up to page 3), paying for them as before.
   With its second page a book also gets a `BookIndex`: each page's smallest
   deposit and, after the clearing, the count of bids at the clearing price
   on each page. With it no instruction reads more than one page, so a bid,
   an eviction or a share costs the same on a book of forty pages as of two.

   Bidding runs for 1 minute to 14 days. It opens right away, or at a
   `start_time` the seller schedules up to 30 days ahead (a time already past
   means right away); the auction then runs its full duration from that start.
   Until the first bid, the seller can cancel, scheduled or not.
2. **Bidders place sealed bids.** A bid is an encrypted `(price, quantity)`
   pair plus a public SOL deposit, and commits to the auction terms the
   bidder saw; it is refused if the auction has any other terms.
   - A token bid names a budget in lamports (`quantity`), the most it
     spends, and the most it pays per token (`price`). It counts only if its
     deposit covers the budget and the budget is at least the minimum, so a
     deposit is an upper bound, not the bid's real demand: a large deposit
     can hide a small budget and the other way round.
   - A collection bid asks for `quantity` NFTs at up to `price` each. It
     counts only if the deposit covers `price × quantity`; deposits may be
     larger to hide the bid.

   An auction holds 256 bids per page of its bid book, up to 1,024 (tokens)
   or 10,240 (collections). Once every page is full and no page can be added,
   a new bid must deposit at least 10% more than the smallest deposit on any
   page (the `BookIndex` knows which page holds it); that bid is refunded in
   full and replaced. The
   auction keeps the total of all deposits.

   Soft close: a replacement within the last 10 minutes of bidding moves the
   end to 10 minutes after it (`soft_close`), up to 24 hours past the end the
   auction opened with (`Auction::extended_secs`). Prices are sealed, so the
   deposit is the only thing a place can be competed for; this keeps that
   competition open long enough for a replaced bidder to answer, instead of
   letting someone push honest bids out in the last seconds. Bids built
   against the earlier end are still accepted. Since the book grows to its
   last page before any bid can be replaced, crowding real bidders out takes
   1,024 larger deposits (10,240 for a collection).

   Until bidding closes, `increase_bid` lets a bidder re-seal their bid (a
   fresh encryption, bound to the same address nonce) and add to its
   deposit. The program cannot see inside the bid, so it only makes sure the
   deposit never shrinks: nobody can show demand with a deposit and pull it
   later. The app only offers raising the price and size. Whatever version
   is sealed when bidding closes is the one checked.
3. **Bids are checked privately.** After the deadline anyone can call
   `check_batch`. MPC decodes four bids at a time, checks each against the
   terms and its deposit (an invalid bid is recorded as price 0, which never
   wins) and stores them, still encrypted, as one record of two ciphertexts
   in the bid book.
   Each bid is decoded exactly once, so everything after agrees about it.
4. **The clearing price is revealed.** `find_clearing` reads every record and
   finds, bit by bit from the top, the highest price `p` at which demand
   covers the supply: for tokens, the sealed budgets of the bids at or above `p` buy
   the whole supply at `p`; for a collection, they ask for at least the whole
   supply. Only `p` and the demand above and at it are revealed. If demand
   never covers the supply at the minimum price, every valid bid wins at the
   minimum price.

   When the bids fill more than one page, `fold_clearing` finds the same
   price a page at a time instead: 8 passes, each fixing four bits of `p`.
   In every pass each page adds up, by the value of the next four bits, the
   demand of its bids that match the bits fixed so far; the step that ends a
   pass picks the highest value whose demand covers the supply and reveals
   those four bits, which are `p`'s own and public at the end anyway. The
   totals in between stay encrypted for the MXE. Pages are visited forwards
   and backwards in turn, so the page that ends one pass starts the next in
   the same step: `8 × (pages − 1) + 1` steps in all, 9 for two pages, 25
   for four and 313 for a collection's forty (about an hour at the 12 seconds
   a step takes on devnet).
5. **Bids are settled.** `settle_batch` asks MPC for the outcomes (above, at
   or below the clearing price) of the bids of one stored batch record, up to
   four, in one computation (`award_batch`), and its callback settles each of
   them; `settle_bid` does the same for one bid (`award_bid_v2`), for a batch
   whose bids cannot all be settled together. Every bid's outcome is revealed
   when it settles either way, so deciding four at once reveals nothing more,
   and it takes a quarter of the computations. The program works out the
   rest in the open:
   - a token bid above the price spends its whole budget at it (if those bids
     alone could buy everything, they share the supply by budget); a token
     bid at the price shares the tokens left by budget, up to what its budget
     buys; every payment is rounded up to a lamport and never exceeds the
     budget, and base units lost to rounding go back to the seller;
   - a collection bid above the price gets every NFT it asked for; one at the
     price only records its size, and once every such bid is revealed
     `finalize_share` gives each of them `floor(size × left / demand_at)`,
     with the NFTs lost to rounding going one each to the earliest of them
     (lowest bid index), so every NFT is sold. On a book of several pages,
     `tally_clearing_page` first counts those bids page by page into the
     `BookIndex` (how many come before each page, and what rounding leaves
     over), so each share reads only its own page.

   Settlement moves the payment to the auction. `claim_tokens` then delivers
   a token bid's tokens and `close_bid` returns the rest of the deposit.
   Anyone can call all of these, but funds and NFTs always go to the bid's
   owner.
6. **A collection's NFTs are shuffled.** Each winning collection bid took the
   next places in line as it settled. Once every bid is settled,
   `draw_nft_seed` has Arcium draw a random seed, which decides which NFT each
   place becomes (see NFT collections below). `claim_nfts` then mints each
   winner's NFTs to them.
7. **Seller is paid.** `claim_proceeds` (or `claim_collection_proceeds`) sends
   the SOL proceeds, less the sale fee, and any unsold tokens to the seller
   once all bids are resolved. Once every bid account is closed,
   `close_auction` (or `close_collection_auction`) returns the remaining rent
   to the seller; closing a collection auction also makes the seller the
   collection's update authority. A book of many pages first closes them a
   few at a time from the end (`close_book_page`, which anyone can send; the
   rent goes to the seller), down to the second, which closes with the
   auction.

`scripts/crank.ts` takes an ended auction through every step anyone may take
(steps 3 to 6 and the deliveries), paying only transaction fees and the
accounts created for winners, and earning the auction's crank rewards. `find_clearing` needs about 370,000 compute
units, so it is sent with a higher compute limit; so is each `fold_clearing`
step.

### Why 1,024 bids for tokens and 10,240 for collections

One MPC computation reads one page of the bid book: 64 batch records, about
6 KB of arguments, which have to fit in a 10 KB cross-program call, and the
page itself (about 8 KB) has to stay under the 10 KB a program can create in
one go. For tokens, four pages are the most the circuits' arithmetic allows
as it is: 1,024 budgets of up to 2^64 lamports, times the largest price unit
(10^16), still fit in 128 bits; twice as many would need a smaller price
unit. A collection's demand is counted in NFTs instead, at most 10,240 bids
of at most 10,000 each, far inside the circuits' 80-bit totals, so its book
can grow to forty pages with the same circuits; that is enough for a
10,000-NFT collection to sell out at one NFT per bid. Each page adds checks,
settlements and 8 clearing steps, and the bids on it pay for them: 10,240
bids take 2,560 checks, 313 clearing steps and 2,560 batch settlements,
which takes hours after bidding ends.
For comparison, Gnosis Auction has no fixed cap but asks sellers to set a
minimum order size so that its on-chain price calculation stays affordable,
and Zama's sealed-bid token auction capped each wallet at 10 active bids
without a stated per-auction cap; neither hides both the price and the size
of every bid as this does.

### Safety net

If the MPC network stalls, nothing stays locked. Three days after the end of
bidding (`EMERGENCY_DELAY_SECS`):

- anyone can return an unsettled bid's full deposit to its owner
  (`emergency_refund`); the bid then counts as lost. This includes a
  collection bid at the clearing price whose share can no longer be finalized
  because another such bid was never revealed;
- the seller can reclaim the remaining tokens and any proceeds already paid
  (`claim_proceeds`);
- no new MPC computation can be queued. One queued before the deadline can
  still finish until the seller claims, except the NFT shuffle: if its seed
  is not drawn by then, each winner's places are their own NFT numbers.

### Sale rules

The web app sells tokens only as new tokens (see New tokens below); the
program still supports sales of existing tokens with these rules and
auto-liquidity, for scripts and integrations.

A token sale can open with rules (`SaleRules`, fixed in `create_auction`):

- **Minimum raise** (`min_raise`, lamports): when the price is found,
  `apply_clearing` compares what the winners would pay in all
  (`expected_gross_proceeds`) with it. A sale below it sets `raise_missed`
  and does not go ahead: `settle_bid` is refused, every bid is refunded in
  full by `refund_failed_bid` (no MPC), the seller takes all the tokens back
  with `claim_proceeds`, and a planned pool is released. The minimum is part
  of `ExpectedTerms`, so a bid commits to it.
- **Allowlist** (`allowlist`): only listed wallets can bid. The seller
  records the root of a Merkle tree of the wallets and a link to the list
  with `set_allowlist`, once, before any bid; until then nobody can join.
  Leaves are `sha256(0x00 || wallet)` and nodes `sha256(0x01 || low ||
  high)` with the children in byte order, so proofs need no direction bits
  and a node cannot pass for a leaf. A wallet joins once with its proof
  (`join_auction`, at most 24 hashes), which makes its `Participant`; its
  bids and raises pass it. `close_participant` returns its rent once bidding
  is over, and the list's account closes with the auction. The app publishes
  the list on Arweave as chunks of 2,000 addresses plus an index naming the
  root, and checks a downloaded list against the root before using it.
- **Most per wallet** (`wallet_cap`, lamports, only with an allowlist): the
  most one wallet may deposit across its bids, counted in its `Participant`.
  A replaced bid's deposit comes off its wallet's count. Since a budget never
  exceeds its deposit, this caps what one wallet can buy.

### Auto-liquidity

A token sale can open a Meteora DAMM v2 pool the moment it settles, at
exactly its clearing price, so winners can trade at once and the price they
paid is where the market starts (`programs/sealed_auction/src/liquidity.rs`).

- **Planned before any bid.** The seller opts in with `plan_liquidity`, in the
  same transaction as `create_auction`: `lp_bps` of the net proceeds (after
  the sale fee), from 20% to 100%; a `floor`, the least SOL the pool gets;
  and the pool's trading fee (0.25%, 1% or 2%). They escrow a reserve of as
  many tokens as are for sale and 0.025 SOL for the pool's rent. Bidders see
  all of it before they bid, and none of it can change.
- **The floor.** The pool's share rises as needed, up to all the net
  proceeds, to reach the floor. If the clearing shows the sale cannot raise
  the floor, the sale fails: every bid gets its whole deposit back with
  `refund_failed_bid` (no MPC), and the seller takes back the tokens and the
  reserve (`claim_proceeds`, `release_liquidity`).
- **Opening.** Once every bid is settled, anyone can send
  `bootstrap_liquidity`. It moves the pool's SOL out of the proceeds, opens
  DAMM v2's pool for the token and SOL at the clearing price with the tokens
  that SOL buys there (never more than were sold), permanently locks the whole
  position, and pays the seller the rest of the proceeds, the unused reserve
  and the unused rent. The pool is full range (x · y = k) and collects its
  fees in SOL.
- **Locked for good.** The position NFT belongs to a data-less address of the
  program (`[b"lp_authority", auction]`), and no instruction withdraws
  liquidity, so the seller cannot pull it.
- **Anti-sniper fee.** Trading opens with a 50% fee that falls linearly to the
  pool's fee over 10 one-minute steps (DAMM v2's fee time scheduler).
- **Fees.** DAMM v2 keeps 20% of every trading fee. Anyone can send
  `claim_pool_fees`, which pays the rest out in SOL: 80% to the seller, 20%
  to the platform's treasury. The plan account stays after the auction
  closes, so this works for as long as the pool trades.
- **Someone opened the pool first.** DAMM v2 has one customizable pool per
  token and SOL. If it already exists when the sale settles,
  `bootstrap_liquidity` opens no pool: the seller gets all the net proceeds
  and the reserve, and nothing is held up. A dedicated DAMM v2 config whose
  pool creator is this program's `[b"pool_creator"]` address removes this
  case.
- **Stalled sales.** A planned pool's reserve also comes back if the sale is
  cancelled, ends without bids, or reaches the safety net.

Measured on devnet: opening the pool takes about 300,000 compute units and
about 0.017 SOL of rent, paid from the seller's deposit.

### New tokens (fair launches)

The app's token sale: a token that does not exist yet and only comes into
being if its sale succeeds, after pump.fun's graduation but by sealed bid
(`programs/sealed_auction/src/launch.rs`). The app shows its amounts as shares
of the total supply: 50% for sale, up to the other 50% for the pool.

- **Opening.** `create_launch` takes the token's name, symbol and metadata
  URI, a graduation target of at least 10 SOL, a bidding time of 1, 2 or 5
  hours and the pool's trading fee. It opens a `Launch` auction for 50% of a
  1,000,000,000-token maximum supply (6 decimals) with no mint behind it, plans
  a pool of all the net proceeds (`lp_bps` 100%), and records the token in a
  `LaunchToken` account (`[b"launch", auction]`). The creator deposits 0.04
  SOL for the token's accounts and pool; what is not used comes back.
- **Sells out or fails.** The lowest price is the target divided by the
  supply for sale, and the minimum raise is the target, so a launch graduates
  only if bids cover every token for sale. Bids start at 0.1 SOL.
- **Graduation.** Once every bid is settled, anyone can send
  `graduate_launch`. It creates the Token-2022 mint (`[b"launch_mint",
  auction]`) with its metadata on the mint itself and no update authority,
  mints exactly the tokens sold into the sale's vault and the tokens the pool
  takes into its reserve, and revokes minting for good. The supply never
  passes 1,000,000,000 and is usually a little under it.
  `bootstrap_liquidity` then opens the pool as for any token sale; rounding
  dust left in the reserve is burned. Winners claim their tokens only once
  the pool is open, so nobody trades before it.
- **Failure.** If the launch misses its target, no mint is ever made and every
  bid is refunded in full with `refund_failed_bid`. The creator then sends
  `close_launch` to get the deposit and the accounts' rents back.
- **No creator allocation.** The creator holds no tokens and takes no SOL from
  the sale; they earn the seller's 80% of the pool's trading fees.
- **Safety net.** A stalled launch reaches the safety net one day after
  bidding ends instead of three.

Measured in tests: graduation takes about 180,000 compute units and opening a
launch's pool about 355,000.

### NFT collections

- NFT `i` (from 0) is named `"{item_name} #{i + 1}"`. Its metadata URI is
  `item_uri` followed by `"{i}.json"` when the seller chose one file per NFT,
  or `item_uri` itself otherwise.
- A collection can be named per item instead. Before opening, the seller
  writes an item list for the auction's address (`init_item_list`,
  `add_items`): up to 500 items, each with a name of up to 24 bytes and a
  number of NFTs (its editions), adding up to the supply. Opening seals it.
  Item `k` covers the NFT numbers after item `k - 1`'s, and an NFT is named
  after its item, with `" #{edition}"` when the item has more than one
  (`item_nft_name`; `src/lib/items.ts` mirrors it). The list's rent comes
  back with `close_collection_auction`; an unused list closes with
  `close_item_list`.
- A collection can be hidden until after the sale (`CollectionTerms::hidden`,
  needs one file per NFT). Its `item_uri` is fixed when the auction opens,
  but its files need not exist yet. NFTs cannot be claimed and the seller
  cannot be paid until the seller calls `reveal_collection`, after bidding
  ends and within `REVEAL_DELAY_SECS` (7 days). If they do not, anyone can
  send `refund_unrevealed` for each winning bid, which moves its payment back
  to the bid so `close_bid` returns the whole deposit; the sale can then end
  with nothing to pay.
- Winners get their NFTs at random. When a winning bid settles it takes the
  next places in line, one per NFT (`Bid::first_position`). Once every bid is
  settled, `draw_nft_seed` has Arcium draw a 128-bit seed (circuit
  `draw_seed`), and `claim_nfts` turns each place into an NFT number with a
  swap-or-not shuffle keyed by it (`shuffled_items`, 64 rounds; the app's
  `src/lib/shuffle.ts` computes the same numbers). Nobody knows the seed while
  places are handed out, so neither settlement nor claim order lets anyone
  steer which NFTs they get. NFT accounts are derived from places. If the seed
  is not drawn by the time the safety net opens, places are their own numbers
  so winners can still collect; a seed arriving after that is ignored.
- Minting costs about 0.0033 SOL per NFT (rent and Metaplex's protocol fee),
  paid by whoever collects. `claim_nfts` mints up to five NFTs per
  transaction.
- An optional Royalties plugin (up to 10%) pays the seller on resales.
- NFTs nobody wins are never minted. Lamports sent to an NFT's or the
  collection's address before it exists cannot block its creation; they go
  to whoever pays for it.

### Fees

| Fee | Default | Paid |
| --- | --- | --- |
| Listing | 0.02 SOL | By the seller, when the auction opens; not refunded on cancel |
| Sale | 1% of the proceeds | By the seller, out of the proceeds when claiming them |

The admin sets both with `set_fees`, within caps compiled into the program
(0.5 SOL and 5%). A seller names the most they accept when opening an
auction, and each auction keeps the sale fee and treasury it opened with. If
the treasury could not receive a fee (a closed account), the fee is skipped
rather than blocking the seller.

#### Crank rewards

Queueing an MPC computation costs a network fee (measured on devnet with the
v2 circuits: about 0.0053 SOL to check four bids, 0.0224 SOL to find the
price, 0.0042 SOL to settle a batch of four bids (0.0037 SOL for one) and
0.0028 SOL to draw a collection's
seed). So that anyone can settle a sale without paying for it, every auction
keeps a crank pool in its own account:

- the seller pays a clearing, one batch check, one batch settlement and, for
  a collection, a seed draw into it when the auction opens;
- pages opened on demand are paid for out of the pool, and so are the steps of
  the paged clearing they need (9 steps with the second page, 8 more with
  each further one; a step pays the clearing reward, as it costs about the
  same: 0.0232 SOL measured on devnet). Each bid that lands on such a page
  adds a room fee (`room_fee`): the page's rent and clearing steps spread
  over its 256 places, about 0.0011 SOL with the default rewards, so a full
  page pays for itself. Any reward the pool still runs short of, when a page
  is only partly filled, is paid out of the proceeds collected so far
  (`crank_payment`). A seller who adds pages ahead of time (`add_book_page`) funds their
  clearing steps then (`page_crank_fee`);
- each bid pays its share of a batch check and of a batch settlement
  (`(check_batch + settlement) / 4`, rounded up), not refunded, on top of
  its deposit, and the seller one of each when the auction opens, so a last,
  partial batch is covered. A bid settled on its own (`settle_bid`) pays its
  caller a whole settlement reward; what that leaves the pool short of comes
  out of the proceeds (`crank_payment`);
- each step's callback, once its computation succeeds, pays whoever queued it
  the step's reward from the pool (as far as the pool reaches). A failed
  computation pays nothing, and a stale callback is refused as before, so a
  step is never paid twice;
- what is left goes to the seller when the auction is closed.

The admin sets the rewards with `set_crank_rewards`
(`scripts/set-crank-rewards.ts`), each capped at 0.1 SOL; each auction keeps
the rewards it opened with. The defaults on devnet are 0.006, 0.025, 0.0046
and 0.003 SOL, a little above the measured fees.

### What is public and what stays private

| Public | Private |
| --- | --- |
| Who bid, how many bids and each deposit | The price of every bid, winning or not |
| The clearing price, demand above and at it | The budget of every losing token bid |
| Each winner's outcome, what it won and paid | The size of every losing collection bid |
| | Individual bids while they are checked |

A deposit only bounds a bid. A token bid's budget is sealed with its price,
so the deposits on chain say nothing exact about demand, and a "whale wall"
of large deposits proves nothing. When a bid wins, `award_bid_v2` reveals
its budget (or NFTs) so the program can work out its award in the open;
that is no more than its public payment shows. A deposit of exactly the
budget, or exactly `price × quantity` for a collection bid, gives the bid
away; the app's default "Private" deposit rounds it up to 1, 2, 5, 10, ...
steps. The
app shows only the total deposited and never lists bidders, but anyone can
read them from the chain. A bid at exactly the clearing price is known to be
at it once settled.

## Trust model

- **No custody by the platform.** Escrowed tokens sit in a token account owned
  by the auction's program-derived address; deposits sit in each bid's own
  account. Only the rules above can move them. The platform admin can only
  feature or hide auctions in the listing, register the circuits and set the
  fees, within their caps, for auctions that open later.
- **Pinned circuits.** Circuits are hosted off chain (see below). The program
  embeds each circuit's SHA-256 hash. It registers circuits only with that
  hash, and it refuses to start a computation unless the registered definition
  is active and carries that hash, so a definition registered some other way
  cannot run on auction data. Arcium nodes refuse a file that does not match
  the hash, so a changed file can only make computations fail.
- **Encryption keys.** `place_bid` accepts a bidder's x25519 key only if
  Arcium's nodes would accept it (on the curve, in its prime-order subgroup),
  so no bid can make checking fail for everyone else. Each ciphertext must
  use a nonce derived from the bid's own address, so a copied ciphertext
  decrypts to noise anywhere else.
- **MPC assumptions.** Bid privacy relies on Arcium's cluster: privacy holds as
  long as at least one node is honest. Every successful result is checked
  against the cluster's BLS signature over the output and the computation it
  belongs to, and the revealed clearing result must be consistent with the
  auction's terms. A failure report is not signed; it only clears the pending
  computation so it can be retried, and no funds move. A computation that
  returns nothing can be re-queued after 30 minutes.
- **Random NFTs.** The seed that shuffles a collection's NFTs is generated
  jointly by the cluster's nodes, so it is unpredictable as long as one of
  them is honest, and it is drawn only after every winner's places are fixed.
  The nodes see the seed before it is posted, so a dishonest cluster could
  withhold it and let the draw be retried; that is the same trust the
  auction already places in the cluster for privacy.
- **Collections.** Until a collection auction is closed, only the auction's
  address can add NFTs to its collection or change it; the program never
  changes its name, metadata or royalty.
- **Authorities.** The deploying wallet holds two keys that matter: the
  program's upgrade authority and the MXE authority in Arcium, which manages
  this program's MXE and its computation definitions. Before any mainnet use,
  move both to a multisig with a timelock, or make the program immutable.

## Repository layout

```
programs/sealed_auction/   Anchor program (Rust)
encrypted-ixs/             Arcis MPC circuits and their tests
tests/sealed_auction.ts    End-to-end test against a live Arcium cluster
tests/svm/                 The compiled program in LiteSVM (no MPC needed)
scripts/crank.ts           Takes an ended auction through every public step
scripts/set-fees.ts        Sets the platform fees (admin only)
scripts/set-crank-rewards.ts Sets the rewards for running MPC steps (admin only)
scripts/set-listing.ts     Features or hides auctions in the listing (admin only)
scripts/upgrade-devnet.sh  Upgrades the devnet program and checks the deployed bytes
app/                       Web app (Vite + React + TypeScript)
```

## Building and testing

Prerequisites: Rust, Solana CLI, Anchor 1.0.2, Arcium CLI 0.15.0, Node and
Yarn (see https://docs.arcium.com/developers/installation).

```bash
arcium build                                    # circuits, program and IDL
cargo test -p encrypted-ixs                     # circuits under mock MPC (after arcium build)
cargo test -p sealed_auction                    # layouts, keys, awards, shares, fees, Core encodings
solana program dump -u devnet CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
  tests/svm/fixtures/mpl_core.so                # Metaplex Core, for the LiteSVM tests
solana program dump -u devnet cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  tests/svm/fixtures/cp_amm.so                  # Meteora DAMM v2, for the auto-liquidity tests
cargo +stable test --manifest-path tests/svm/Cargo.toml # terms, bidding, fees, sales, shares, NFTs, items, reveals, pools, safety net, closing
```

The LiteSVM crate needs a newer compiler than the program's pinned 1.89, hence
`+stable`.

The LiteSVM tests write the results MPC callbacks would record straight into
the accounts, then run the real instructions after them, including minting
NFTs through the real Metaplex Core program and opening, trading against and
claiming fees from pools on the real Meteora DAMM v2 program.

`anchor build` rebuilds only the program; use it when the circuits have not
changed, so their hashes stay those of the hosted files. `arcium build` clears
`artifacts/` of JSON files, so keep backups elsewhere.

End-to-end on devnet (needs the deployed program, the hosted circuits and
devnet SOL; it registers the circuits and sets default fees on first run):

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/devnet-test.json ARCIUM_CLUSTER_OFFSET=456 \
CIRCUIT_BASE_URL=https://raw.githubusercontent.com/<user>/<repo>/<commit> \
  yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/sealed_auction.ts
```

## Deploying to devnet

First deployment:

```bash
arcium deploy --cluster-offset 456 --recovery-set-size 4 \
  --keypair-path ~/.config/solana/devnet-test.json --rpc-url <devnet-rpc-url>
```

Upgrades: `scripts/upgrade-devnet.sh` deploys `target/deploy/sealed_auction.so`
over the devnet program and checks that the deployed bytes match the build.
The CLI extends the program account when the new build is larger; the
temporary buffer needs about as much SOL as the program's rent, and it is
returned afterwards. An upgrade that changes an account layout makes existing
accounts of that type unreadable, so finish and close every open auction
first. This release's accounts carry their own discriminators (`VAuctn03`,
`VBook_03`, `VBid__02`), so accounts from earlier releases are never mistaken
for them.

Then call `initialize` once (signed by the upgrade authority), register the
six circuits (`check_bids_v2`, `clear_price_v2`, `fold_batch_v2`,
`award_bid_v2`, `award_batch` and `draw_seed`) with `init_check_bids_comp_def`,
`init_clear_price_comp_def`, `init_fold_batch_comp_def`,
`init_award_bid_comp_def`, `init_award_batch_comp_def` and
`init_draw_seed_comp_def`, passing the URL of
each `.arcis` file, set the fees with `set_fees` (`scripts/set-fees.ts`) and
the crank rewards with `set_crank_rewards` (`scripts/set-crank-rewards.ts`);
no auction can open before both are set. The end-to-end test does the first
three if they are missing.

### Circuit hosting

The compiled circuits (`build/check_bids_v2.arcis`, `build/clear_price_v2.arcis`
and `build/fold_batch_v2.arcis`, several MB each, `build/award_bid_v2.arcis`,
`build/award_batch.arcis` and `build/draw_seed.arcis`) are too large
to store on chain cheaply, so they are served from a public URL. Upload exactly the files
produced by the build that compiled the program, and register them with a URL
that names a commit rather than a branch, such as
`https://raw.githubusercontent.com/<user>/<repo>/<commit>/check_bids_v2.arcis`, so
the file behind the URL cannot change. For mainnet, prefer permanent storage
such as Arweave or IPFS with pinning.

## Web app

```bash
cd app
npm install
npm run dev        # http://localhost:5173
SITE_URL=https://your.domain npm run build   # static site in app/dist
```

Search and AI crawlers (ChatGPT's OAI-SearchBot, Claude, Perplexity) mostly do
not run JavaScript, so `npm run build` ends with `scripts/prerender.mjs`. It
renders the front page and the docs into static HTML (`dist/index.html`,
`dist/docs/index.html`, with their fees read from the chain), adds titles,
descriptions and schema.org data (Organization, WebSite, WebApplication, and
the docs' questions as FAQPage), and writes `robots.txt` (search, answer and
training crawlers all allowed), `llms.txt`, `llms-full.txt` (the docs as
Markdown) and, with `SITE_URL` set, `sitemap.xml` and canonical links. Link
previews on X, Telegram and Discord show `public/og.png` (1200×630). The
host must serve `dist/docs/index.html` at `/docs/`, as static hosts do. In
the browser the app replaces the static HTML when it starts; the app reads
its page from the hash (`#/launch`), or from the path when there is none, so
`/docs/` opens the docs.

`VITE_RPC_URL` overrides the public devnet RPC. `npm run dev` with `?mock` in
the URL shows sample data for design work (`?mock&nofeature` shows the front
page without a featured auction); production builds drop it.

Wallets connect through the Wallet Standard (Phantom, Solflare, Backpack and
others). Set the wallet to the app's network before signing.

The app's text is written for mainnet, so nothing needs rewording at launch.
The network shows only through `config.ts`: on a test network the header
carries a badge (`NETWORK_LABEL`), and explorer links follow
`EXPLORER_CLUSTER`; both drop away when `WALLET_CHAIN` is mainnet.

People type prices in SOL per token or per NFT; the app converts them to
price ticks exactly, rounding a bid's price down so it never pays more than
typed. The app shows you the price and size of your own bids. With each bid
it stores a note of them on chain (`save_bid_note`, a 32-byte `BidNote`
account next to the bid), encrypted with AES-256-GCM under a key made from the
wallet's signature of a fixed message. Ed25519 signatures are deterministic,
so the same wallet opens its notes on any device after one signature, and
nobody else can. The note's rent (about 0.0012 SOL) comes back when the bid is
collected; notes of bids replaced in a full auction can be closed from My
bids. A wallet that cannot sign messages bids without a note on chain. The
browser keeps a copy so it need not ask again, deleted once the bid is
collected and after 30 days. A collection's metadata file and image
are fetched without cookies or referrer, and only https images are shown. The
Docs page (`#/docs`) explains auctions, fees and privacy for users.

### Uploading art

The Launch page offers three kinds of launch; all of
them sell through the same sealed auction:

- **Drop**: a whole collection at once. One image per NFT (up to 10,000), or
  one image every NFT shares, or a link to metadata the seller hosts. A
  metadata sheet in OpenSea's CSV format (`src/lib/csv.ts`: `tokenID`, `name`,
  `description`, `file_name`, `external_url`, `attributes[Trait]`; commas,
  semicolons or tabs) gives every NFT its own description, link and traits,
  and its own name for drops of up to 500 (written to the item list). The
  page offers a template listing the chosen files. A drop can be hidden until
  after the sale.
- **Collection**: built item by item, each with its image, name, editions,
  description, link and traits; always named per item through the item list.
- **Token**: a new token, made only if its sale sells out (see New tokens
  above).

The collection's details (logo, optional banner, description, website and X
links) go into its metadata file: `image`, `banner_image` and `external_url`
as OpenSea reads them, and a `veiling` object with what only this app shows
(`kind`, `links`, and for hidden drops `hidden`, `preview` and `sealed`). Each
NFT's file has `name` (exactly its on-chain name), `description` (its own or
the collection's), `image`, `external_url`, `attributes` and Metaplex's
`properties.files`.

When launching, a seller can upload images instead of linking to metadata
they host. In the browser, the app:

1. Prepares each image (`src/lib/images.ts`) so that only the picture is
   published, not hidden details such as where a photo was taken. Only still
   PNG, JPEG and WebP images are taken; GIFs are refused and animations are
   dropped. Each image is ready in two forms:
   - Compressed. A PNG of 100 KB or less keeps its exact pixels and loses its
     text, date, EXIF and animation chunks. Other images are redrawn: as a PNG
     if that fits, otherwise as WebP (JPEG where the browser cannot write WebP)
     at falling quality, then falling size, until it fits.
   - Original, up to 10 MB. The file as chosen, with hidden details cut from
     its container without re-encoding, so the pixels stay exactly as they
     were. A JPEG loses its EXIF, XMP, comments, Photoshop and IPTC blocks,
     JFIF thumbnail and any images stored after the first (such as a phone's
     depth map); it keeps its color profile, Adobe's color block and, for a
     rotated photo, a fresh EXIF block holding only the orientation. A WebP
     loses its EXIF and XMP; an animated WebP cannot be kept as an original.
     A PNG keeps only the chunks that shape the still picture. Each changed
     file is decoded again to check it is still the same picture.

   The work runs in Web Workers (`src/lib/imageWorker.ts`, sharing
   `src/lib/imageCore.ts` with the page): up to four images at a time, one per
   core, so a large collection is ready sooner and the page stays responsive
   while it is prepared. Where workers cannot draw (no `OffscreenCanvas`), the
   page prepares the images itself, one at a time.
2. Writes the metadata JSON files (`src/lib/uploads.ts`), with Metaplex's
   `image` and `properties.files` fields. For one image per NFT it also writes
   an Arweave path manifest, so NFT `i` reads `{manifest}/{i}.json`.
3. Uploads everything to Arweave through ArDrive Turbo before the wallet is
   asked to approve the auction. Each file is an ANS-104 data item
   (`src/lib/arweave.ts`; signature type 4, as Turbo's SDK signs for Solana
   keys).

A collection's seller chooses compressed or original storage, and the Launch
page shows what each holds and costs; a token's image is always compressed.
Uploads are public and permanent.

**Hidden drops** (`src/lib/sealed.ts`). The NFTs' files (images, metadata and
the path manifest) are signed as data items at launch but not published:
signing fixes their ids, so the manifest id, and with it `item_uri`, is known
before anything of the art is public. The signed items are packed in order
(each after its length), encrypted with AES-256-GCM under
`sha256("veiling/reveal-key/v1" || wallet signature || auction address)`,
where the wallet signature is the one the upload key comes from, and uploaded
as packages: up to 105 KiB each on free storage, 8 MiB on paid. A small index
lists the packages, the manifest id and the files' count and size; the
collection's metadata points to it (`veiling.sealed`). To reveal, the seller's
wallet signs the same message again, and the app downloads and opens the
packages, checks that the last file is the committed manifest, publishes every
file exactly as signed and sends `reveal_collection`. Paid hidden art is
signed with the upload key, and the launch buys credit for both the sealed
copy and the reveal. Hidden drops are numbered rather than named, since an
item list would show names before the reveal. A hidden drop linked to files
the seller hosts only checks, at the reveal, that the first NFT's file is
online.

**Free storage.** Turbo stores items of up to 105 KiB for free, 10 MiB in all
per wallet and per network, for life. Free uploads go to
`https://upload.ardrive.io`, signed by a throwaway ed25519 key made for the
page, so the seller's wallet signs nothing and the key never holds funds.
Links point to `https://arweave.net/<id>`.

**Paid storage** (`src/lib/storage.ts`). Original files, and compressed sets
over the free allowance, are paid for by the seller in SOL before the auction
opens; bidders never pay for storage. Prices come from Turbo's payment service
(`/v1/rates` and `/v1/price/solana/…`, Turbo's fee included) and the app adds
1% for price moves. To pay:

1. The wallet signs a fixed message, and a tagged SHA-256 of the signature is
   the seller's upload key. Solana wallets sign deterministically, so a wallet
   always gets the same key and credit left over is there for its next
   upload. The key only signs uploads; it holds no SOL.
2. If the key's credit falls short, the wallet sends the difference to Turbo's
   Solana address, pinned in `config.ts` and checked against the service's
   `/v1/info` first, with the memo `turboCreditDestinationAddress=<key>`, as
   Turbo's SDK does. The app waits for finality, reports the transaction to
   Turbo and waits until the credit shows. Until then the transaction id is
   kept in the browser, so a payment sent just before the page closed is
   counted later instead of being paid again.
3. The uploads are signed with the upload key and draw on its credit. Files
   already stored in this session are skipped, so trying a launch again pays
   only for what is missing.

On mainnet, paid storage uses `https://payment.ardrive.io` and
`https://upload.ardrive.io`. On devnet it uses Turbo's test services
(`https://payment.services.ar-io.dev` and `https://upload.services.ar-io.dev`),
which take devnet SOL and serve files from `https://ar-io.dev`, purged after
about three days. The data item encoder matches arbundles 1.0.4 byte for
byte. A Content-Security-Policy for the hosted app must allow connections to
these services.

## Known limitations

- Devnet only and unaudited.
- Up to 1,024 bids per token auction, 10,240 per collection auction and 10,000
  NFTs per collection. Checks run one batch of four bids at a time, so a
  collection with thousands of bids takes hours to settle after bidding ends;
  winners get their NFTs then. In a full auction, the bid with the smallest deposit
  can be replaced (and refunded) until bidding ends; a replacement near the
  end extends bidding, by up to 24 hours in all. Someone willing to lock up
  larger deposits than every real bidder can still take every place, and then
  wins at the minimum price, which is the seller's floor.
- Prices are u32 ticks: a token auction usually takes bids up to at least
  40,000 times its minimum price, and a collection auction up to about
  4,295 SOL per NFT.
  For a token without decimals the price refers to at least one whole token,
  so such a token can be priced at no more than about 4.29 SOL.
- Bids cannot be lowered or withdrawn before the deadline, only raised.
- In-app uploads of one image per NFT stop at 10,000 NFTs, and every image is
  prepared in the browser, which takes a while for large drops. Originals are
  limited to 10 MB each, and animated images and video are not supported.
- Item lists hold up to 500 items, with names of up to 24 bytes; larger drops
  are numbered.
- Hidden art costs about twice as much to store: sealed at launch and
  published at the reveal.
- On devnet, paid storage goes to Turbo's test service, which deletes files
  after about three days, so a hidden drop stored there must be revealed
  within three days of launching.
- No allowlists or mint stages: once bidding opens, anyone can bid.
- A bidder who has turned on required memos for their Token-2022 account must
  turn it off before the tokens they won can be delivered.
- `@solana/web3.js` v1, required by Arcium's client, carries npm advisories that
  affect Node servers parsing untrusted JSON, not this browser app.

## Before any mainnet launch

- Independent security audit of the program and circuits.
- Legal review for every market you serve (token sales, NFT sales and auction
  platforms are regulated in many places, including Turkey under SPK rules).
- Multisig with a timelock for the upgrade authority, the MXE authority and
  the fee admin, or an immutable program.
- A dedicated Meteora DAMM v2 config for auto-liquidity pools, with this
  program's `[b"pool_creator"]` address as the pool creator, so nobody can
  open a sale's pool before it settles.
- Dedicated RPC provider, monitoring, and permanent circuit hosting.
- Point the app at mainnet (`WALLET_CHAIN`, `RPC_URL`), which also moves paid
  storage to Turbo's main services, and check the pinned Turbo payment
  address in `config.ts` against Turbo's own records.
