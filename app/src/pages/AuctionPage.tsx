import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PublicKey, type Transaction } from "@solana/web3.js";
import {
  BATCH_SIZE,
  EVICTION_PREMIUM_PERCENT,
  MAX_BIDS,
  MAX_PRICE_TICKS,
  NFT_MINT_COST_LAMPORTS,
  NFT_PRICE_SCALE,
  PENDING_TIMEOUT_SECS,
} from "../config";
import { AuctionBoard } from "../components/AuctionBoard";
import { statusText, supplyDescription } from "../components/AuctionTable";
import {
  AddressLink,
  type AssetInfo,
  Button,
  Notice,
  TxLink,
  goodsAmount,
  useAction,
  useAssetInfo,
  useLoader,
  useMetadataImage,
  useNow,
} from "../components/ui";
import {
  type Auction,
  type Bid,
  type CollectionMetadata,
  emergencyOpensAt,
  fetchAdmin,
  fetchAuction,
  fetchBid,
  fetchBidsForAuction,
  fetchCollectionMetadata,
  fetchItemList,
  fetchNftMetadata,
  formatPercent,
  formatPrice,
  hasPending,
  hasTokensToCollect,
  maxPriceOf,
  needsShuffle,
  nftMetadataUri,
  nftName,
  nftNumbersOf,
  nftsReady,
  phaseOf,
  refundOf,
  revealClosesAt,
  revealMissed,
  saleFee,
  sharesAreFinal,
  ticksOf,
  bidCrankFee,
  priceOf,
} from "../lib/chain";
import { type ItemEntry, itemStart } from "../lib/items";
import { type RevealStep, revealArt } from "../lib/reveal";
import { traitLabel } from "../components/LaunchParts";
import {
  buildCancelAuction,
  buildCheckBatch,
  buildClaimProceeds,
  buildCloseAuction,
  buildCollect,
  buildDrawSeed,
  buildEmergencyRefund,
  buildFindClearing,
  buildFinalizeShares,
  buildPlaceBid,
  buildSetListing,
  buildSettleBid,
  findEviction,
  buildIncreaseBid,
} from "../lib/actions";
import { closeNoteInstruction, hasChainNote, noteForNewBid } from "../lib/bidNotes";
import { forgetClosedBids, forgetNote, noteSize, readNote, saveNote } from "../lib/notes";
import { NoteUnlock } from "../components/BidNotes";
import { formatCount, formatDateTime, formatDuration, formatSol, parseSol, plural } from "../lib/format";
import { formatDecimal, niceCeil, parseAmount, tokensForBudget } from "../lib/price";
import { errorMessage, sendTransaction, waitUntil, type WalletSigner } from "../lib/tx";
import { useWallet } from "../lib/wallet";

// ---------------------------------------------------------------------------

/**
 * Splits off a share at the clearing price if needed, delivers what the bid
 * won and returns the rest of its deposit, retrying if someone else minted
 * some of the same bid's NFTs at the same moment. Returns the last signature.
 */
async function collectBid(signer: WalletSigner, auction: Auction, bid: Bid): Promise<string> {
  let signature = "";
  for (let attempt = 0; ; attempt++) {
    const fresh = (await fetchAuction(auction.address)) ?? auction;
    const latest = await fetchBid(bid.address);
    if (!latest) return signature;
    try {
      for (const tx of await buildCollect(signer.publicKey, fresh, latest, Math.floor(Date.now() / 1000))) {
        signature = await sendTransaction(tx, signer);
      }
      return signature;
    } catch (e) {
      if (attempt < 2 && /NFT or collection accounts/.test(errorMessage(e))) continue;
      throw e;
    }
  }
}

/** A full auction only takes a bid that out-deposits the smallest one. */
function useEviction(auction: Auction) {
  const full = auction.bidCount >= MAX_BIDS;
  const eviction = useLoader(
    () => (full ? findEviction(auction) : Promise.resolve(null)),
    [auction.address.toBase58(), full],
    full ? 15_000 : undefined
  );
  return { full, eviction, minimumDeposit: eviction.data?.minimumDeposit ?? 0n };
}

function EvictionHint({
  full,
  eviction,
  minimumDeposit,
  enough,
  bidCount,
}: ReturnType<typeof useEviction> & { enough: boolean; bidCount: number }) {
  if (full) {
    return (
      <p className={`hint${enough ? "" : " hint--error"}`}>
        {eviction.data
          ? `This auction is full with ${MAX_BIDS} bids. To get in, deposit at least ${formatSol(minimumDeposit)} SOL, ${EVICTION_PREMIUM_PERCENT}% more than the smallest deposit. That bid is then refunded in full and drops out.`
          : eviction.error
            ? `This auction is full and the smallest deposit could not be loaded: ${eviction.error}`
            : "This auction is full. Checking the smallest deposit…"}
      </p>
    );
  }
  if (bidCount >= (MAX_BIDS * 3) / 4) {
    return (
      <p className="hint">
        Once {MAX_BIDS} bids are in, a new bid can replace the one with the smallest deposit by depositing{" "}
        {EVICTION_PREMIUM_PERCENT}% more; the replaced bid gets its whole deposit back. A larger deposit keeps your
        place.
      </p>
    );
  }
  return null;
}

/** Turns a typed price into ticks, rounded down so a bid never pays more than typed. */
function usePriceInput(auction: Auction, asset: AssetInfo, input: string) {
  const typed = parseAmount(input);
  const ticks = typed ? ticksOf(auction, typed, asset.decimals, "down") : null;
  const tooLow = ticks !== null && ticks < auction.minPrice;
  const tooHigh = ticks !== null && ticks > MAX_PRICE_TICKS;
  const valid = ticks !== null && !tooLow && !tooHigh;
  const shown = valid ? formatPrice(auction, ticks, asset.decimals) : null;
  const typedText = typed ? `${formatDecimal(typed)} SOL` : null;
  return { ticks: valid ? ticks : null, tooLow, tooHigh, rounded: Boolean(shown && typedText && shown !== typedText), shown };
}

function placedMessage(sig: string, evicted: Bid | null, noted: boolean) {
  return (
    <>
      Bid sealed.
      {evicted ? ` It replaced bid ${evicted.index + 1}, whose deposit went back to its owner.` : ""}
      {noted
        ? " Its price and size are saved on chain, encrypted for your wallet, so you can see them on any device."
        : " Its price and size are kept in this browser only."}{" "}
      <TxLink signature={sig} />
    </>
  );
}

/**
 * Adds the bid's encrypted note to its transaction (unless the wallet does not
 * sign for the key) and, when it replaces a bid, closes that bid's note so its
 * rent goes back to its owner. Returns whether the note was added.
 */
async function addNotes(tx: Transaction, signer: WalletSigner, bid: PublicKey, price: bigint, quantity: bigint, evicted: Bid | null) {
  const save = await noteForNewBid(signer, bid, price, quantity);
  if (save) tx.add(save);
  if (evicted && (await hasChainNote(evicted.address))) {
    tx.add(await closeNoteInstruction(signer.publicKey, evicted.bidder, evicted.address));
  }
  return save !== null;
}

/**
 * A token bid: a SOL budget and the most it pays per token, both sealed, and
 * a public deposit that covers the budget without showing it.
 */
function TokenBidComposer({ auction, asset, onPlaced }: { auction: Auction; asset: AssetInfo; onPlaced: () => void }) {
  const { signer } = useWallet();
  const action = useAction();
  const [budgetInput, setBudgetInput] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [mode, setMode] = useState<DepositMode>("private");
  const [customInput, setCustomInput] = useState("");
  const evict = useEviction(auction);
  const price = usePriceInput(auction, asset, priceInput);
  const budget = parseSol(budgetInput) ?? 0n;
  const budgetValid = budget >= auction.minDeposit;
  // A private deposit rounds the budget up to 1, 2, 5, 10, ... steps, so it
  // bounds the budget without showing it.
  const custom = parseSol(customInput);
  const chosen = mode === "private" ? (budget > 0n ? niceCeil(budget) : 0n) : mode === "exact" ? budget : (custom ?? 0n);
  const deposit = mode === "private" && budget > 0n && chosen < evict.minimumDeposit ? evict.minimumDeposit : chosen;
  const enoughToEnter = !evict.full || (Boolean(evict.eviction.data) && deposit >= evict.minimumDeposit);
  const valid = budgetValid && price.ticks !== null && deposit >= budget && enoughToEnter;
  const min = formatPrice(auction, auction.minPrice, asset.decimals);
  const max = maxPriceOf(auction, asset.decimals);
  const cap = (amount: bigint) => (amount < auction.supply ? amount : auction.supply);
  const atYourPrice = price.ticks ? cap(tokensForBudget(budget, auction.priceUnit, price.ticks)) : 0n;
  const atMinimum = cap(tokensForBudget(budget, auction.priceUnit, auction.minPrice));

  const place = () =>
    action.run("place", async () => {
      if (!signer) throw new Error("Connect a wallet first");
      if (!price.ticks) throw new Error("Enter a valid price");
      const { tx, bid, evicted } = await buildPlaceBid(signer.publicKey, auction, price.ticks, budget, deposit);
      const noted = await addNotes(tx, signer, bid, price.ticks, budget, evicted);
      const sig = await sendTransaction(tx, signer);
      saveNote(bid, auction.address, price.ticks, budget);
      onPlaced();
      evict.eviction.reload();
      return placedMessage(sig, evicted, noted);
    });

  return (
    <section className="panel" aria-labelledby="bid-title">
      <h2 id="bid-title" className="panel__title">
        Place a sealed bid
      </h2>
      <div className="field">
        <label htmlFor="budget">Budget (SOL)</label>
        <input
          id="budget"
          inputMode="decimal"
          value={budgetInput}
          placeholder={`At least ${formatSol(auction.minDeposit)}`}
          onChange={(e) => setBudgetInput(e.target.value.replace(/[^0-9.]/g, ""))}
          aria-invalid={budgetInput !== "" && !budgetValid}
          aria-describedby="budget-hint"
        />
        <p id="budget-hint" className={`hint${budgetInput !== "" && !budgetValid ? " hint--error" : ""}`}>
          The most SOL you want to spend, at least {formatSol(auction.minDeposit)} SOL. Sealed like your price:
          only a winning budget is ever revealed.
        </p>
      </div>
      <div className="field">
        <label htmlFor="price">Most you would pay per {asset.unit} (SOL)</label>
        <input
          id="price"
          inputMode="decimal"
          value={priceInput}
          placeholder={`At least ${min.replace(" SOL", "")}`}
          onChange={(e) => setPriceInput(e.target.value.replace(/[^0-9.]/g, ""))}
          aria-invalid={priceInput !== "" && !price.ticks}
          aria-describedby="price-hint"
        />
        <p id="price-hint" className={`hint${price.tooLow || price.tooHigh ? " hint--error" : ""}`}>
          {price.tooHigh && max
            ? `This auction takes prices up to ${formatDecimal(max)} SOL.`
            : `At least ${min}. Sealed: nobody sees it, before or after the auction.`}
          {price.rounded && price.shown ? ` Rounded down to ${price.shown}.` : ""}
        </p>
      </div>
      <fieldset className="field">
        <legend>Deposit</legend>
        <div className="segmented" role="group">
          {(Object.keys(DEPOSIT_LABELS) as DepositMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`segmented__item${mode === m ? " segmented__item--on" : ""}`}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {DEPOSIT_LABELS[m]}
            </button>
          ))}
        </div>
        {mode === "custom" ? (
          <input
            className="field__extra"
            inputMode="decimal"
            placeholder={`At least ${formatSol(budget)} SOL`}
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label="Deposit in SOL"
            aria-invalid={customInput !== "" && !valid}
          />
        ) : null}
        <p className={`hint${mode === "exact" ? " hint--warn" : ""}`}>
          {mode === "private"
            ? budgetValid
              ? `Deposits are public. This one would cover a budget of up to ${formatSol(deposit)} SOL, so it does not show yours.`
              : "Deposits are public. A private deposit is rounded up, so it does not show your budget."
            : mode === "exact"
              ? "Anyone looking at the chain sees your budget in an exact deposit. Use it only if you do not mind that."
              : `Any amount from your budget up. The further it is from your budget, the less it reveals.`}{" "}
          Whatever you do not spend comes back after settlement.
        </p>
        <EvictionHint {...evict} enough={enoughToEnter} bidCount={auction.bidCount} />
      </fieldset>
      <dl className="sums">
        <div>
          <dt>If the price ends at yours</dt>
          <dd>{price.ticks && budget > 0n ? goodsAmount(atYourPrice, asset) : "—"}</dd>
        </div>
        <div>
          <dt>If it ends at the minimum</dt>
          <dd>{budget > 0n ? goodsAmount(atMinimum, asset) : "—"}</dd>
        </div>
        <div>
          <dt>Deposit now</dt>
          <dd>{formatSol(deposit)} SOL</dd>
        </div>
        <SettlementFee auction={auction} />
      </dl>
      <p className="hint">
        Every winner pays the same clearing price, never more than their own. A bid above it spends its whole budget
        at that price, so the lower the price, the more {asset.goods} you get. A bid exactly at it shares what is
        left. Whatever is not spent comes back. Until bidding closes you can raise your bid, but never lower or
        withdraw it.
      </p>
      <Button variant="primary" onClick={place} busy={action.busy === "place"} disabled={!signer || !valid}>
        {signer ? "Seal and place bid" : "Connect a wallet to bid"}
      </Button>
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      {action.done ? <Notice tone="success">{action.done}</Notice> : null}
    </section>
  );
}

/**
 * Who pays for the private steps: anyone can run them, and each pays its
 * runner from the auction's settlement fund once Arcium finishes it.
 */
function CrankNote({ auction }: { auction: Auction }) {
  const r = auction.crankRewards;
  const active = auction.status === "open" || auction.status === "settling";
  if (!active || auction.bidCount === 0 || r.checkBatch + r.clearing + r.settlement + r.seedDraw === 0n) return null;
  const parts = [
    `${formatSol(r.checkBatch)} SOL per check of ${BATCH_SIZE} bids`,
    `${formatSol(r.clearing)} SOL for the price`,
    `${formatSol(r.settlement)} SOL per bid settled`,
    ...(auction.kind === "collection" ? [`${formatSol(r.seedDraw)} SOL for the shuffle`] : []),
  ];
  return (
    <p className="muted">
      Anyone can take the steps below. Each one pays whoever runs it from this auction's settlement fund when Arcium
      finishes it, to cover its network fee: {parts.join(", ")}. {formatSol(auction.crankPool)} SOL is left in the fund;
      what is not used goes back to the seller.
    </p>
  );
}

/** The bid's share of the settlement fund, if this auction has one. */
function SettlementFee({ auction }: { auction: Auction }) {
  const fee = bidCrankFee(auction.crankRewards);
  if (fee === 0n) return null;
  return (
    <div title="Paid to whoever runs the private steps that check and settle the bids. Not refunded.">
      <dt>Settlement fee</dt>
      <dd>{formatSol(fee)} SOL</dd>
    </div>
  );
}

/**
 * Raises an open bid: a new, higher price and size, sealed again, and more
 * deposit if the new bid needs it. The program only makes sure the deposit
 * never shrinks, so the form checks that the bid only goes up.
 */
function RaiseBid({
  auction,
  asset,
  bid,
  onDone,
}: {
  auction: Auction;
  asset: AssetInfo;
  bid: Bid;
  onDone: () => void;
}) {
  const { signer } = useWallet();
  const action = useAction();
  const note = readNote(bid.address);
  const token = auction.kind === "token";
  const oldTicks = note ? BigInt(note.price) : null;
  const oldSize = note ? (noteSize(note) > 0n ? noteSize(note) : token ? bid.deposit : 0n) : null;
  const shownPrice = (ticks: bigint) => {
    const p = priceOf(auction, ticks, asset.decimals);
    return p ? formatDecimal(p).replace(/,/g, "") : "";
  };
  const [priceInput, setPriceInput] = useState(() => (oldTicks ? shownPrice(oldTicks) : ""));
  const [sizeInput, setSizeInput] = useState(() =>
    oldSize === null ? "" : token ? formatSol(oldSize, 9).replace(/,/g, "") : oldSize.toString()
  );
  const price = usePriceInput(auction, asset, priceInput);
  const size = token ? parseSol(sizeInput) : /^\d+$/.test(sizeInput) ? BigInt(sizeInput) : null;
  const sizeOk =
    size !== null && (token ? size >= auction.minDeposit : size >= 1n && size <= BigInt(auction.maxPerBid));
  const notLower =
    oldTicks === null || oldSize === null || (price.ticks !== null && size !== null && price.ticks >= oldTicks && size >= oldSize);
  const raised =
    oldTicks === null || oldSize === null || (price.ticks !== null && size !== null && (price.ticks > oldTicks || size > oldSize));
  // What the new bid needs covered, rounded up the private way, and never
  // less than what is already deposited.
  const needed = !price.ticks || !size ? 0n : token ? size : size * price.ticks * auction.priceScale;
  const rounded = !price.ticks || !size ? 0n : token ? niceCeil(size) : niceCeil(size) * niceCeil(price.ticks) * auction.priceScale;
  const deposit = rounded > bid.deposit ? rounded : bid.deposit;
  const extra = deposit - bid.deposit;
  const valid = Boolean(price.ticks) && sizeOk && notLower && raised && deposit >= needed;

  const raise = () =>
    action.run("raise", async () => {
      if (!signer || !price.ticks || size === null) throw new Error("Connect a wallet first");
      const tx = await buildIncreaseBid(signer.publicKey, auction, bid, price.ticks, size, extra);
      const save = await noteForNewBid(signer, bid.address, price.ticks, size);
      if (save) tx.add(save);
      const sig = await sendTransaction(tx, signer);
      saveNote(bid.address, auction.address, price.ticks, size);
      onDone();
      return (
        <>
          Bid raised and sealed again{extra > 0n ? `, with ${formatSol(extra)} SOL more deposit` : ""}.{" "}
          <TxLink signature={sig} />
        </>
      );
    });

  return (
    <div className="raise">
      <div className="field">
        <label htmlFor={`raise-price-${bid.index}`}>Most you would pay per {asset.unit} (SOL)</label>
        <input
          id={`raise-price-${bid.index}`}
          inputMode="decimal"
          value={priceInput}
          onChange={(e) => setPriceInput(e.target.value.replace(/[^0-9.]/g, ""))}
          aria-invalid={priceInput !== "" && !price.ticks}
        />
      </div>
      <div className="field">
        <label htmlFor={`raise-size-${bid.index}`}>{token ? "Budget (SOL)" : "NFTs"}</label>
        <input
          id={`raise-size-${bid.index}`}
          className={token ? undefined : "field__short"}
          inputMode={token ? "decimal" : "numeric"}
          value={sizeInput}
          onChange={(e) => setSizeInput(e.target.value.replace(token ? /[^0-9.]/g : /[^0-9]/g, ""))}
          aria-invalid={sizeInput !== "" && !sizeOk}
        />
      </div>
      <p className={`hint${notLower ? "" : " hint--error"}`}>
        {oldTicks === null || oldSize === null
          ? "This browser has no note of the bid, so check that the new one is not lower: it replaces the old one."
          : notLower
            ? "A bid can only go up. The new one replaces the old one, sealed again."
            : "The price and size can only go up."}{" "}
        {valid
          ? extra > 0n
            ? `Adds ${formatSol(extra)} SOL to your deposit, ${formatSol(deposit)} SOL in all, rounded up so it does not show the bid.`
            : "Your deposit already covers it."
          : ""}
      </p>
      <Button variant="primary" onClick={raise} busy={action.busy === "raise"} disabled={!signer || !valid}>
        Raise the bid
      </Button>
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      {action.done ? <Notice tone="success">{action.done}</Notice> : null}
    </div>
  );
}

type DepositMode = "private" | "exact" | "custom";

const DEPOSIT_LABELS: Record<DepositMode, string> = {
  private: "Private",
  exact: "Exact",
  custom: "Custom",
};

/** A collection bid: how many NFTs, the most it pays for each, and a deposit that covers them. */
function NftBidComposer({ auction, asset, onPlaced }: { auction: Auction; asset: AssetInfo; onPlaced: () => void }) {
  const { signer } = useWallet();
  const action = useAction();
  const [quantityInput, setQuantityInput] = useState("1");
  const [priceInput, setPriceInput] = useState("");
  const [mode, setMode] = useState<DepositMode>("private");
  const [customInput, setCustomInput] = useState("");
  const evict = useEviction(auction);
  const price = usePriceInput(auction, asset, priceInput);
  const quantity = Number.parseInt(quantityInput, 10);
  const quantityValid = Number.isInteger(quantity) && quantity >= 1 && quantity <= auction.maxPerBid;
  const min = formatPrice(auction, auction.minPrice, asset.decimals);
  const max = maxPriceOf(auction, asset.decimals);

  const cost = quantityValid && price.ticks ? BigInt(quantity) * price.ticks * NFT_PRICE_SCALE : 0n;
  // A private deposit rounds the size and the price up to 1, 2, 5, 10, ...
  // steps, so it bounds the bid without showing it.
  const bucket = quantityValid ? niceCeil(BigInt(quantity)) : 0n;
  const coveredNfts = bucket < BigInt(auction.maxPerBid) ? bucket : BigInt(auction.maxPerBid);
  const coveredTicks = price.ticks ? niceCeil(price.ticks) : 0n;
  const custom = parseSol(customInput);
  const chosen = mode === "private" ? coveredNfts * coveredTicks * NFT_PRICE_SCALE : mode === "exact" ? cost : (custom ?? 0n);
  const deposit = mode === "private" && cost > 0n && chosen < evict.minimumDeposit ? evict.minimumDeposit : chosen;
  const enoughToEnter = !evict.full || (Boolean(evict.eviction.data) && deposit >= evict.minimumDeposit);
  const valid = quantityValid && price.ticks !== null && deposit >= cost && deposit > 0n && enoughToEnter;

  const place = () =>
    action.run("place", async () => {
      if (!signer) throw new Error("Connect a wallet first");
      if (!price.ticks) throw new Error("Enter a valid price");
      const size = BigInt(quantity);
      const { tx, bid, evicted } = await buildPlaceBid(signer.publicKey, auction, price.ticks, size, deposit);
      const noted = await addNotes(tx, signer, bid, price.ticks, size, evicted);
      const sig = await sendTransaction(tx, signer);
      saveNote(bid, auction.address, price.ticks, size);
      onPlaced();
      evict.eviction.reload();
      return placedMessage(sig, evicted, noted);
    });

  return (
    <section className="panel" aria-labelledby="bid-title">
      <h2 id="bid-title" className="panel__title">
        Place a sealed bid
      </h2>
      <div className="field">
        <label htmlFor="quantity">NFTs</label>
        <input
          id="quantity"
          className="field__short"
          inputMode="numeric"
          value={quantityInput}
          onChange={(e) => setQuantityInput(e.target.value.replace(/[^0-9]/g, ""))}
          aria-invalid={!quantityValid}
          aria-describedby="quantity-hint"
        />
        <p id="quantity-hint" className={`hint${quantityValid ? "" : " hint--error"}`}>
          {auction.maxPerBid === 1 ? "One NFT per bid." : `Between 1 and ${formatCount(auction.maxPerBid)} NFTs.`}{" "}
          Each is minted to you when you collect it, for about {formatSol(NFT_MINT_COST_LAMPORTS)} SOL in rent and
          Metaplex fees.
        </p>
      </div>
      <div className="field">
        <label htmlFor="price">Most you would pay per NFT (SOL)</label>
        <input
          id="price"
          inputMode="decimal"
          value={priceInput}
          placeholder={`At least ${min.replace(" SOL", "")}`}
          onChange={(e) => setPriceInput(e.target.value.replace(/[^0-9.]/g, ""))}
          aria-invalid={priceInput !== "" && !price.ticks}
          aria-describedby="price-hint"
        />
        <p id="price-hint" className={`hint${price.tooLow || price.tooHigh ? " hint--error" : ""}`}>
          {price.tooHigh && max
            ? `This auction takes prices up to ${formatDecimal(max)} SOL.`
            : `At least ${min}. Sealed: nobody sees it, before or after the auction.`}
          {price.rounded && price.shown ? ` Rounded down to ${price.shown}.` : ""}
        </p>
      </div>
      <fieldset className="field">
        <legend>Deposit</legend>
        <div className="segmented" role="group">
          {(Object.keys(DEPOSIT_LABELS) as DepositMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`segmented__item${mode === m ? " segmented__item--on" : ""}`}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {DEPOSIT_LABELS[m]}
            </button>
          ))}
        </div>
        {mode === "custom" ? (
          <input
            className="field__extra"
            inputMode="decimal"
            placeholder={`At least ${formatSol(cost)} SOL`}
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label="Deposit in SOL"
            aria-invalid={customInput !== "" && !valid}
          />
        ) : null}
        <p className={`hint${mode === "exact" ? " hint--warn" : ""}`}>
          {mode === "private"
            ? price.ticks && quantityValid
              ? `Deposits are public. This one would cover up to ${plural(Number(coveredNfts), "NFT")} at up to ${formatPrice(auction, coveredTicks, asset.decimals)} each, so it shows neither your price nor your exact size.`
              : "Deposits are public. A private deposit is rounded up, so it shows neither your price nor your exact size."
            : mode === "exact"
              ? "Anyone looking at the chain can work out your price and size from an exact deposit. Use it only if you do not mind that."
              : `Any amount from ${formatSol(cost)} SOL up. The further it is from price × NFTs, the less it reveals.`}{" "}
          Whatever you do not spend comes back after settlement.
        </p>
        <EvictionHint {...evict} enough={enoughToEnter} bidCount={auction.bidCount} />
      </fieldset>
      <dl className="sums">
        <div>
          <dt>Most you can pay</dt>
          <dd>{formatSol(cost)} SOL</dd>
        </div>
        <div>
          <dt>Deposit now</dt>
          <dd>{formatSol(deposit)} SOL</dd>
        </div>
        <SettlementFee auction={auction} />
      </dl>
      <p className="hint">
        Winners pay the clearing price for each NFT, never more than their own. Bids at exactly that price share
        what is left. Until bidding closes you can raise your bid, but never lower or withdraw it.
      </p>
      <Button variant="primary" onClick={place} busy={action.busy === "place"} disabled={!signer || !valid}>
        {signer ? "Seal and place bid" : "Connect a wallet to bid"}
      </Button>
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      {action.done ? <Notice tone="success">{action.done}</Notice> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

function Step({ state, title, children }: { state: "done" | "active" | "waiting"; title: string; children?: ReactNode }) {
  return (
    <li className={`progress__step progress__step--${state}`}>
      <span className="progress__marker" aria-hidden="true" />
      <div>
        <h3 className="progress__title">
          {title}
          <span className="sr-only">{state === "done" ? " (done)" : state === "active" ? " (now)" : ""}</span>
        </h3>
        {children}
      </div>
    </li>
  );
}

const REVEAL_STEPS: Record<RevealStep, string> = {
  key: "Waiting for your wallet to sign, which makes the key to the sealed art…",
  pay: "Waiting for you to approve the storage payment…",
  credit: "Waiting for Turbo to count the payment…",
  publish: "Publishing the art…",
  check: "Checking that your metadata is online…",
  reveal: "Waiting for you to approve the reveal…",
};

function Progress({
  auction,
  asset,
  bids,
  now,
  refresh,
  meta,
  collectionUri,
}: {
  auction: Auction;
  asset: AssetInfo;
  bids: Bid[];
  now: number;
  refresh: () => void;
  meta: CollectionMetadata | null;
  collectionUri: string | null;
}) {
  const { signer, publicKey } = useWallet();
  const action = useAction();
  const [revealing, setRevealing] = useState<{ step: RevealStep; progress?: [number, number] } | null>(null);
  const phase = phaseOf(auction, now);
  const auctionPending = hasPending(auction.pendingComputation, auction.pendingSince, now, PENDING_TIMEOUT_SECS);
  const emergency = now >= emergencyOpensAt(auction);
  const isSeller = Boolean(publicKey && publicKey.equals(auction.seller));
  const mine = publicKey ? bids.filter((b) => b.bidder.equals(publicKey)) : [];
  const unsettled = bids.filter(
    (b) => b.status === "sealed" && !hasPending(b.pendingComputation, b.pendingSince, now, PENDING_TIMEOUT_SECS)
  );
  const atClearing = bids.filter((b) => b.status === "atClearing");
  const sharesReady = sharesAreFinal(auction);
  // Settled bids that still hold tokens or NFTs to deliver or a deposit to return.
  const uncollected = bids.filter((b) => b.status === "settled");
  const collection = auction.kind === "collection";
  // A collection's winners wait for the shuffle; bids that won nothing can go now.
  const ready = nftsReady(auction, now);
  // A hidden collection's winners also wait for the reveal; if it never
  // comes, delivering a winning bid gives its payment back instead.
  const missed = revealMissed(auction, now);
  const hiddenArt = collection && (auction.unrevealed || Boolean(meta?.hidden));
  const revealDeadline = revealClosesAt(auction);
  const deliverable = uncollected.filter(
    (b) => auction.kind === "token" || b.won === 0n || b.delivered || missed || (ready && !auction.unrevealed)
  );
  const shuffleDue = needsShuffle(auction);
  // Auctions opened before NFTs were shuffled numbered them in claim order.
  const unshuffled = collection && auction.resolvedCount === auction.bidCount && auction.sold > 0n && auction.assignedPositions === 0;
  const clearing = formatPrice(auction, auction.clearingPrice, asset.decimals);
  const unit = asset.unit;

  const needSigner = () => {
    if (!signer) throw new Error("Connect a wallet first");
    return signer;
  };

  const check = () =>
    action.run("check", async () => {
      const s = needSigner();
      const { tx, count } = await buildCheckBatch(s.publicKey, auction, bids);
      const target = auction.checkedCount + count;
      await sendTransaction(tx, s);
      const after = await waitUntil(
        () => fetchAuction(auction.address),
        (a) => !a || a.checkedCount >= target || a.pendingComputation.equals(PublicKey.default)
      );
      refresh();
      return after && after.checkedCount >= target
        ? `Checked bids up to ${target} of ${auction.bidCount}.`
        : "Arcium could not finish this time. Try again.";
    });

  const clear = () =>
    action.run("clear", async () => {
      const s = needSigner();
      await sendTransaction(await buildFindClearing(s.publicKey, auction), s);
      const after = await waitUntil(
        () => fetchAuction(auction.address),
        (a) => !a || a.status !== "open" || a.pendingComputation.equals(PublicKey.default)
      );
      refresh();
      return after && after.status === "settling"
        ? `The price is ${formatPrice(after, after.clearingPrice, asset.decimals)} per ${unit}.`
        : "Arcium could not finish this time. Try again.";
    });

  const settle = (bid: Bid) =>
    action.run(`settle-${bid.address.toBase58()}`, async () => {
      const s = needSigner();
      await sendTransaction(await buildSettleBid(s.publicKey, auction, bid), s);
      const after = await waitUntil(
        () => fetchBid(bid.address),
        (b) => !b || b.status !== "sealed" || b.pendingComputation.equals(PublicKey.default)
      );
      refresh();
      if (!after || after.status === "sealed") return "Arcium could not finish this time. Try again.";
      if (after.status === "atClearing") {
        return `Bid ${bid.index + 1} is at the clearing price. Its share is split off once every bid at that price is revealed.`;
      }
      return after.won > 0n
        ? `Bid ${bid.index + 1} won ${goodsAmount(after.won, asset)} for ${formatSol(after.payment)} SOL.`
        : `Bid ${bid.index + 1} did not win; its deposit is ready to collect.`;
    });

  const shuffle = () =>
    action.run("shuffle", async () => {
      const s = needSigner();
      await sendTransaction(await buildDrawSeed(s.publicKey, auction), s);
      const after = await waitUntil(
        () => fetchAuction(auction.address),
        (a) => !a || a.seedDrawn || a.pendingComputation.equals(PublicKey.default)
      );
      refresh();
      return after && after.seedDrawn
        ? "The NFTs are shuffled. Every winner's NFTs are now fixed and can be delivered."
        : "Arcium could not finish this time. Try again.";
    });

  const split = () =>
    action.run("split", async () => {
      const s = needSigner();
      const sig = await sendTransaction(await buildFinalizeShares(auction, atClearing), s);
      refresh();
      return (
        <>
          Shares at the clearing price are split off. <TxLink signature={sig} />
        </>
      );
    });

  const deliver = (bid: Bid) =>
    action.run(`deliver-${bid.address.toBase58()}`, async () => {
      const s = needSigner();
      const refunded = missed && bid.won > 0n && !bid.delivered;
      const sig = await collectBid(s, auction, bid);
      forgetNote(bid.address);
      refresh();
      return refunded ? (
        <>
          Bid {bid.index + 1} got its payment back: its whole {formatSol(bid.deposit)} SOL deposit went to its owner.{" "}
          {sig ? <TxLink signature={sig} /> : null}
        </>
      ) : (
        <>
          Bid {bid.index + 1} is complete: {hasTokensToCollect(bid) ? `its ${asset.goods} and ` : ""}
          {formatSol(refundOf(bid))} SOL went to its owner. {sig ? <TxLink signature={sig} /> : null}
        </>
      );
    });

  const reveal = () =>
    action
      .run("reveal", async () => {
        const s = needSigner();
        if (!collectionUri) throw new Error("The collection's details have not loaded yet. Try again in a moment.");
        const sig = await revealArt(s, auction, collectionUri, meta, (step, progress) => setRevealing({ step, progress }));
        refresh();
        return (
          <>
            The art is revealed. Winners can now collect their NFTs, and you the proceeds. <TxLink signature={sig} />
          </>
        );
      })
      .finally(() => setRevealing(null));

  const claim = () =>
    action.run("claim", async () => {
      const s = needSigner();
      const sig = await sendTransaction(await buildClaimProceeds(auction), s);
      refresh();
      return (
        <>
          {collection
            ? "Proceeds were sent to you. Unsold NFTs are never minted."
            : "Proceeds and any unsold tokens were sent to you. Tokens that winners have not collected yet stay in escrow for them."}{" "}
          <TxLink signature={sig} />
        </>
      );
    });

  const cancel = () =>
    action.run("cancel", async () => {
      const s = needSigner();
      const sig = await sendTransaction(await buildCancelAuction(auction), s);
      refresh();
      return (
        <>
          {collection
            ? "Auction cancelled. The collection and every rent came back to you."
            : "Auction cancelled. Your tokens and every rent came back to you."}{" "}
          <TxLink signature={sig} />
        </>
      );
    });

  const refund = (bid: Bid) =>
    action.run(`refund-${bid.address.toBase58()}`, async () => {
      const s = needSigner();
      const sig = await sendTransaction(await buildEmergencyRefund(s.publicKey, bid), s);
      forgetNote(bid.address);
      refresh();
      const own = publicKey && bid.bidder.equals(publicKey);
      return (
        <>
          {own ? "Your" : `Bid ${bid.index + 1}'s`} deposit of {formatSol(bid.deposit)} SOL went back
          {own ? " to you" : " to its owner"}. <TxLink signature={sig} />
        </>
      );
    });

  const close = () =>
    action.run("close", async () => {
      const s = needSigner();
      const sig = await sendTransaction(await buildCloseAuction(auction), s);
      refresh();
      return (
        <>
          Auction closed. Its rent came back to you{collection ? " and the collection is yours to manage" : ""}.{" "}
          <TxLink signature={sig} />
        </>
      );
    });

  // In the safety net, sealed bids can be refunded, and so can bids at the
  // clearing price whose shares can no longer be split off.
  const refundable = emergency ? [...unsettled, ...(sharesReady ? [] : atClearing)] : [];
  const othersRefundable = refundable.filter((b) => !publicKey || !b.bidder.equals(publicKey));
  const mineRefundable = refundable.filter((b) => publicKey && b.bidder.equals(publicKey));
  const ended = auction.status === "finished" || auction.status === "cancelled";
  const canClose = isSeller && ended && auction.liveBids === 0;

  // Hidden art that sold must be revealed before the seller is paid; if it
  // never is, the sale can only end once every winner has their payment back.
  const awaitingReveal = collection && auction.unrevealed && auction.sold > 0n;
  const canClaim =
    isSeller &&
    (!awaitingReveal || (missed && auction.proceeds === 0n)) &&
    ((auction.status === "settling" && (auction.resolvedCount === auction.bidCount || emergency)) ||
      (auction.status === "open" && auction.bidCount === 0 && now >= auction.endTime) ||
      (auction.status === "open" && emergency));
  const fee = saleFee(auction.proceeds, auction.saleFeeBps);

  const checkState = phase === "checking" ? "active" : auction.checkedCount === auction.bidCount && auction.bidCount > 0 ? "done" : "waiting";
  const priceState = phase === "ready-to-clear" ? "active" : auction.status !== "open" ? "done" : "waiting";
  const settleState = phase === "settling" ? "active" : phase === "settled" || auction.status === "finished" ? "done" : "waiting";
  const shuffleState = shuffleDue ? "active" : auction.seedDrawn || (phase === "settled" && auction.delivered >= auction.sold) ? "done" : "waiting";
  const collectState =
    deliverable.length > 0 && auction.status !== "open"
      ? "active"
      : auction.status === "finished" || (phase === "settled" && uncollected.length === 0)
        ? "done"
        : "waiting";
  const left = auction.supply - auction.weightAbove;
  const revealState = !auction.unrevealed
    ? "done"
    : now >= auction.endTime && (!missed || deliverable.length > 0)
      ? "active"
      : missed
        ? "done"
        : "waiting";
  const revealHint = revealing
    ? `${REVEAL_STEPS[revealing.step]}${
        revealing.step === "publish" && revealing.progress && revealing.progress[1] > 0
          ? ` ${formatCount(revealing.progress[0])} of ${formatCount(revealing.progress[1])} files.`
          : ""
      }`
    : null;

  return (
    <section className="panel" aria-labelledby="progress-title">
      <h2 id="progress-title" className="panel__title">
        {phase === "bidding" || phase === "upcoming" ? "After bidding closes" : "Settlement"}
      </h2>
      <CrankNote auction={auction} />

      {auction.status === "cancelled" ? (
        <p>The seller cancelled this auction before any bids.</p>
      ) : auction.bidCount === 0 && auction.status === "open" ? (
        <p>
          {phase === "upcoming" || phase === "bidding" ? "No bids yet." : "Bidding closed without bids."}
        </p>
      ) : (
        <ol className="progress">
          <Step state={checkState} title="Check the sealed bids">
            <p className="muted">
              {formatCount(auction.checkedCount)} of {formatCount(auction.bidCount)} checked. Arcium checks each bid
              against the terms and its deposit, four at a time, without opening any of them.
            </p>
            {phase === "checking" ? (
              auctionPending ? (
                <p className="working">Checking on Arcium…</p>
              ) : (
                <Button variant="primary" onClick={check} busy={action.busy === "check"} disabled={!signer}>
                  Check the next {Math.min(BATCH_SIZE, auction.bidCount - auction.checkedCount)} bids
                </Button>
              )
            ) : null}
          </Step>
          <Step state={priceState} title="Reveal the clearing price">
            {auction.status === "open" ? (
              <p className="muted">
                The highest price at which the bids cover the supply. Only that price and the demand at and above it
                are revealed.
              </p>
            ) : (
              <p>
                {auction.filled
                  ? `Cleared at ${clearing} per ${unit}.`
                  : `Demand did not cover the supply, so every valid bid wins at the minimum price of ${clearing}.`}
              </p>
            )}
            {phase === "ready-to-clear" ? (
              auctionPending ? (
                <p className="working">Finding the price on Arcium…</p>
              ) : (
                <Button variant="primary" onClick={clear} busy={action.busy === "clear"} disabled={!signer}>
                  Reveal the price
                </Button>
              )
            ) : null}
          </Step>
          <Step state={settleState} title="Settle every bid">
            <p className="muted">
              {formatCount(auction.resolvedCount)} of {formatCount(auction.bidCount)} settled. Arcium decides each
              bid against the price without showing what it bid. Anyone can settle any bid.
            </p>
            {collection && auction.filled && auction.weightAt > 0n && auction.status !== "open" ? (
              <p className="muted">
                Bids at exactly the clearing price share the {plural(Number(left), "NFT")} left there by size; any NFT
                lost to rounding goes to the earliest of them.
                {sharesReady
                  ? ""
                  : ` ${formatCount(Number(auction.atRevealed))} of ${plural(Number(auction.weightAt), "NFT")} wanted at that price revealed so far.`}
              </p>
            ) : null}
            {!collection && auction.filled && auction.status !== "open" ? (
              <p className="muted">
                Bids above the price spend their whole budget at it; bids exactly at it share the tokens left, by
                budget.
              </p>
            ) : null}
            {phase === "settling" && (unsettled.length > 0 || (sharesReady && atClearing.length > 0)) ? (
              <div className="actions">
                {mine
                  .filter((b) => unsettled.includes(b))
                  .slice(0, 1)
                  .map((b) => (
                    <Button key="mine" variant="primary" onClick={() => settle(b)} busy={action.busy === `settle-${b.address.toBase58()}`} disabled={!signer}>
                      Settle my bid
                    </Button>
                  ))}
                {unsettled.length > 0 ? (
                  <Button
                    onClick={() => settle(unsettled[0])}
                    busy={action.busy === `settle-${unsettled[0].address.toBase58()}`}
                    disabled={!signer}
                  >
                    Settle the next bid
                  </Button>
                ) : null}
                {sharesReady && atClearing.length > 0 ? (
                  <Button onClick={split} busy={action.busy === "split"} disabled={!signer}>
                    Split the shares at the clearing price
                  </Button>
                ) : null}
              </div>
            ) : null}
          </Step>
          {hiddenArt ? (
            <Step state={revealState} title="Reveal the art">
              {!auction.unrevealed ? (
                <p>Revealed. The NFTs show their art.</p>
              ) : missed ? (
                <p>
                  The seller did not reveal the art by {formatDateTime(revealDeadline)}, so no NFT is minted and every
                  winner takes their payment back.
                </p>
              ) : now < auction.endTime ? (
                <p className="muted">
                  The art stays hidden until the seller reveals it after bidding ends, by{" "}
                  {formatDateTime(revealDeadline)}. No NFT can be minted before; if it is not revealed by then, every
                  winner takes their payment back.
                </p>
              ) : isSeller ? (
                <>
                  <p>
                    Reveal the art by {formatDateTime(revealDeadline)}.{" "}
                    {meta?.sealed
                      ? "Your wallet makes the key that opens your sealed art, which is then published as committed."
                      : "Your NFTs' metadata must be online at the link you committed."}{" "}
                    Then winners can collect their NFTs and you the proceeds.
                  </p>
                  <Button variant="primary" onClick={reveal} busy={action.busy === "reveal"} disabled={!signer}>
                    Reveal the art
                  </Button>
                  {revealHint ? <p className="working">{revealHint}</p> : null}
                </>
              ) : (
                <p className="muted">
                  Waiting for the seller to reveal the art, until {formatDateTime(revealDeadline)}. If it is not
                  revealed by then, every winner takes their payment back.
                </p>
              )}
            </Step>
          ) : null}
          {collection && !unshuffled ? (
            <Step state={shuffleState} title="Shuffle the NFTs">
              <p className="muted">
                Which NFTs each winner gets is drawn at random by Arcium once every bid is settled, so nobody can
                pick or predict them. Anyone can start it.
              </p>
              {auction.seedDrawn ? (
                <p>Shuffled. Every winner's NFTs are fixed.</p>
              ) : !ready && shuffleDue ? (
                auctionPending ? (
                  <p className="working">Shuffling on Arcium…</p>
                ) : (
                  <Button variant="primary" onClick={shuffle} busy={action.busy === "shuffle"} disabled={!signer}>
                    Shuffle the NFTs
                  </Button>
                )
              ) : null}
            </Step>
          ) : null}
          <Step state={collectState} title={`Deliver ${asset.goods} and refunds`}>
            <p className="muted">
              {uncollected.length > 0 ? `${plural(uncollected.length, "settled bid")} still to deliver. ` : ""}
              Winners get their {asset.goods} and everyone gets their unused SOL. Anyone can do this for any bid; it
              only ever pays the bid's owner.
              {collection
                ? ` NFTs are minted as they are delivered, after the shuffle, and whoever delivers pays about ${formatSol(NFT_MINT_COST_LAMPORTS)} SOL per NFT in rent and Metaplex fees.`
                : ""}
            </p>
            {deliverable.length > 0 ? (
              <Button
                onClick={() => deliver(deliverable[0])}
                busy={action.busy === `deliver-${deliverable[0].address.toBase58()}`}
                disabled={!signer}
              >
                Deliver the next bid
              </Button>
            ) : null}
          </Step>
        </ol>
      )}

      {isSeller && auction.status === "open" && auction.bidCount === 0 && (phase === "upcoming" || phase === "bidding" || phase === "no-bids") ? (
        <div className="panel__footer">
          <p className="muted">
            Nobody has bid yet, so you can withdraw{phase === "upcoming" ? ", even before bidding opens" : ""}.{" "}
            {collection ? "The empty collection" : "Your tokens"} and every rent come back to you; the listing fee
            does not.
          </p>
          <Button onClick={cancel} busy={action.busy === "cancel"}>
            Cancel auction
          </Button>
        </div>
      ) : null}

      {canClaim && !(auction.status === "open" && auction.bidCount === 0) ? (
        <div className="panel__footer">
          <p>
            {auction.status === "settling"
              ? auction.saleFeeBps > 0
                ? `You can collect ${formatSol(auction.proceeds - fee)} SOL: ${formatSol(auction.proceeds)} SOL of sales less the ${formatPercent(auction.saleFeeBps)} platform fee (${formatSol(fee)} SOL)${collection ? "." : ", plus any unsold tokens."}`
                : `You can collect ${formatSol(auction.proceeds)} SOL${collection ? "." : " and any unsold tokens."}`
              : collection
                ? "Settlement stalled; you can end the sale. Unsold NFTs are never minted."
                : "Settlement stalled; you can take your tokens back."}
          </p>
          <Button variant="primary" onClick={claim} busy={action.busy === "claim"}>
            {auction.status === "settling" ? "Claim proceeds" : collection ? "End the sale" : "Take tokens back"}
          </Button>
        </div>
      ) : isSeller && awaitingReveal && auction.status === "settling" && !missed ? (
        <div className="panel__footer">
          <p className="muted">Reveal the art above to collect the proceeds.</p>
        </div>
      ) : isSeller && awaitingReveal && missed && auction.proceeds > 0n ? (
        <div className="panel__footer">
          <p className="muted">
            The art was not revealed in time. Once every winner has taken their payment back, you can end the sale.
          </p>
        </div>
      ) : isSeller && auction.status === "settling" && atClearing.length > 0 && auction.resolvedCount + atClearing.length === auction.bidCount ? (
        <div className="panel__footer">
          <p className="muted">Split the shares at the clearing price above, then you can claim the proceeds.</p>
        </div>
      ) : null}

      {mineRefundable.length > 0 ? (
        <div className="panel__footer">
          <p>
            Settlement stalled for three days, so you can take your deposit back in full. The bid then counts as
            lost.
          </p>
          {mineRefundable.map((b) => (
            <Button key={b.address.toBase58()} onClick={() => refund(b)} busy={action.busy === `refund-${b.address.toBase58()}`}>
              Refund bid {b.index + 1} ({formatSol(b.deposit)} SOL)
            </Button>
          ))}
        </div>
      ) : null}

      {othersRefundable.length > 0 ? (
        <div className="panel__footer">
          <p>
            {plural(othersRefundable.length, "unsettled bid")} can be refunded. Anyone can do this; the deposit only
            ever goes back to the bid's owner.
          </p>
          <Button
            onClick={() => refund(othersRefundable[0])}
            busy={action.busy === `refund-${othersRefundable[0].address.toBase58()}`}
            disabled={!signer}
          >
            Refund the next bid
          </Button>
        </div>
      ) : null}

      {isSeller && ended && auction.status !== "cancelled" ? (
        <div className="panel__footer">
          {canClose ? (
            <>
              <p>
                Every bid is closed. Close the auction to get its rent back
                {collection ? " and take over the collection's update authority" : ""}.
              </p>
              <Button variant="primary" onClick={close} busy={action.busy === "close"}>
                Close auction
              </Button>
            </>
          ) : (
            <p className="muted">
              Once all {plural(auction.liveBids, "remaining bid")} {auction.liveBids === 1 ? "is" : "are"} delivered
              or refunded, you can close the auction and get its rent back.
            </p>
          )}
        </div>
      ) : null}

      {/* The safety net only matters while some bid is still undecided. */}
      {!emergency && auction.status !== "cancelled" && auction.bidCount > 0 && auction.resolvedCount < auction.bidCount ? (
        <p className="hint">
          If settlement ever stalls, refunds open on {formatDateTime(emergencyOpensAt(auction))}.
        </p>
      ) : null}

      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      {action.done ? <Notice tone="success">{action.done}</Notice> : null}
    </section>
  );
}

/** "Lale, Çini #2 and Gün Batımı #1", or the first few and how many more. */
function nameList(names: string[]): string {
  const shown = names.slice(0, 8);
  if (names.length > shown.length) return `${shown.join(", ")} and ${formatCount(names.length - shown.length)} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
}

// ---------------------------------------------------------------------------

function YourBids({
  auction,
  asset,
  bids,
  now,
  refresh,
  entries,
}: {
  auction: Auction;
  asset: AssetInfo;
  bids: Bid[];
  now: number;
  refresh: () => void;
  /** A collection named per item: its item list's entries, once loaded. */
  entries: ItemEntry[] | null;
}) {
  const { publicKey, signer } = useWallet();
  const action = useAction();
  // Bumped when notes from chain arrive, to show them.
  const [, setNotesOpened] = useState(0);
  /** The bid whose raise form is open. */
  const [raising, setRaising] = useState<string | null>(null);
  if (!publicKey) return null;
  const biddingOpen = phaseOf(auction, now) === "bidding";
  const mine = bids.filter((b) => b.bidder.equals(publicKey));
  if (mine.length === 0) return null;
  const sharesReady = sharesAreFinal(auction);
  const nftsKnown = nftsReady(auction, now);
  const missed = revealMissed(auction, now);
  const collect = (bid: Bid) =>
    action.run(`collect-${bid.address.toBase58()}`, async () => {
      if (!signer) throw new Error("Connect a wallet first");
      const sig = await collectBid(signer, auction, bid);
      forgetNote(bid.address);
      refresh();
      return (
        <>
          Collected. {auction.kind === "collection" ? "Your NFTs are in your wallet; " : ""}
          the rest of your deposit came back. {sig ? <TxLink signature={sig} /> : null}
        </>
      );
    });
  return (
    <section className="panel" aria-labelledby="yours-title">
      <h2 id="yours-title" className="panel__title">
        Your bids
      </h2>
      <ul className="bidlist">
        {mine.map((b) => {
          const note = readNote(b.address);
          const owed = auction.kind === "collection" && b.status === "settled" && b.won > 0n && !b.delivered;
          const takesBack = owed && missed;
          const waitsForReveal = owed && auction.unrevealed && !missed;
          const waitsForShuffle = owed && !nftsKnown && !takesBack;
          const ready =
            takesBack ||
            (b.status === "settled" && !waitsForShuffle && !waitsForReveal) ||
            (b.status === "atClearing" && sharesReady);
          const numbers = nftNumbersOf(auction, b, now);
          const names = numbers?.map((n) => nftName(auction, n, entries) ?? `#${n}`) ?? null;
          const sealedAt = note ? formatPrice(auction, BigInt(note.price), asset.decimals) : null;
          return (
            <li key={b.address.toBase58()}>
              <div className="bidlist__main">
                <strong>Bid {b.index + 1}</strong>
                <span className="muted">
                  Deposit {formatSol(b.deposit)} SOL
                </span>
              </div>
              {note && sealedAt ? (
                <p className="bidlist__note">
                  {auction.kind === "token"
                    ? `Sealed: a budget of ${formatSol(noteSize(note) > 0n ? noteSize(note) : b.deposit)} SOL at up to ${sealedAt} per ${asset.unit}.`
                    : `Sealed for ${plural(Number(noteSize(note)), "NFT")} at up to ${sealedAt} each.`}{" "}
                  Only your wallet can read this note, and it is deleted once the bid is collected.
                </p>
              ) : null}
              {biddingOpen && b.status === "sealed" ? (
                raising === b.address.toBase58() ? (
                  <RaiseBid
                    auction={auction}
                    asset={asset}
                    bid={b}
                    onDone={() => {
                      setRaising(null);
                      refresh();
                    }}
                  />
                ) : (
                  <Button variant="quiet" onClick={() => setRaising(b.address.toBase58())}>
                    Raise this bid
                  </Button>
                )
              ) : null}
              <p className="bidlist__state">
                {b.status === "sealed"
                  ? "Sealed"
                  : b.status === "atClearing"
                    ? sharesReady
                      ? "At the clearing price. Your share is ready to collect."
                      : "At the clearing price. Your share is known once every bid at that price is revealed."
                    : takesBack
                      ? `Won ${goodsAmount(b.won, asset)}, but the art was not revealed in time, so no NFT is minted and your whole ${formatSol(b.deposit)} SOL deposit comes back.`
                      : b.won > 0n
                        ? `Won ${goodsAmount(b.won, asset)}${names ? ` (${nameList(names)})` : ""} for ${formatSol(b.payment)} SOL. ${formatSol(refundOf(b))} SOL comes back.${waitsForShuffle ? " Which NFTs is drawn at random once every bid is settled." : ""}${waitsForReveal ? ` They are minted once the seller reveals the art, by ${formatDateTime(revealClosesAt(auction))}; if not, you take your payment back.` : ""}`
                        : `Did not win. Your ${formatSol(refundOf(b))} SOL deposit comes back.`}
              </p>
              {ready ? (
                <Button
                  variant="primary"
                  onClick={() => collect(b)}
                  busy={action.busy === `collect-${b.address.toBase58()}`}
                  disabled={!signer}
                >
                  {b.status === "atClearing"
                    ? "Split off my share"
                    : takesBack
                      ? "Take my deposit back"
                      : hasTokensToCollect(b)
                        ? `Collect ${asset.goods} and refund`
                        : "Collect refund"}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <NoteUnlock bids={mine} onOpened={() => setNotesOpened((n) => n + 1)} />
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      {action.done ? <Notice tone="success">{action.done}</Notice> : null}
    </section>
  );
}

function AdminControls({ auction, refresh }: { auction: Auction; refresh: () => void }) {
  const { signer } = useWallet();
  const action = useAction();
  if (!signer) return null;
  const update = (featured: boolean, hidden: boolean) =>
    action.run("listing", async () => {
      await sendTransaction(await buildSetListing(signer.publicKey, auction.address, featured, hidden), signer);
      refresh();
      return "Listing updated.";
    });
  return (
    <div className="admin" aria-label="Admin">
      <span className="muted">Admin</span>
      <Button variant="quiet" onClick={() => update(!auction.featured, auction.hidden)} busy={action.busy === "listing"}>
        {auction.featured ? "Remove from featured" : "Feature"}
      </Button>
      <Button variant="quiet" onClick={() => update(auction.featured, !auction.hidden)} busy={action.busy === "listing"}>
        {auction.hidden ? "Show in listings" : "Hide from listings"}
      </Button>
      {action.error ? <span className="admin__error">{action.error}</span> : null}
    </div>
  );
}

/** The collection's picture, when its metadata names one that can be shown. */
function CollectionArt({ uri, name, image: known }: { uri: string | null; name: string; image: string | null }) {
  const loaded = useMetadataImage(known ? null : uri);
  const image = known ?? loaded;
  const [failed, setFailed] = useState(false);
  if (!image || failed) return null;
  return (
    <img
      className="auction-head__art"
      src={image}
      alt={`${name} collection art`}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** One NFT or item of the collection: its image, name and traits, read from its metadata. */
function NftTile({ uri, name, caption, image: fixed }: { uri: string | null; name: string; caption?: string; image?: string | null }) {
  const meta = useLoader(() => (uri ? fetchNftMetadata(uri) : Promise.resolve(null)), [uri]);
  const image = fixed ?? meta.data?.image ?? null;
  const traits = meta.data?.attributes ?? [];
  return (
    <li className="nftcard">
      {image ? (
        <img className="nftcard__img" src={image} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <span className={`nftcard__img nftcard__img--empty${meta.loading ? " nftcard__img--loading" : ""}`} aria-hidden="true" />
      )}
      <span className="nftcard__name">{name}</span>
      {caption ? <span className="nftcard__meta">{caption}</span> : null}
      {traits.length > 0 ? (
        <span className="nftcard__traits">
          {traits.slice(0, 4).map((t, i) => (
            <span key={i} className="trait" title={t.trait ? `${t.trait}: ${t.value}` : t.value}>
              {traitLabel(t.trait, t.value)}
            </span>
          ))}
          {traits.length > 4 ? <span className="trait trait--more">+{traits.length - 4}</span> : null}
        </span>
      ) : null}
    </li>
  );
}

const GALLERY_PAGE = 12;

/** What the collection holds: its items, its NFTs a page at a time, or placeholders while the art is hidden. */
function Gallery({ auction, meta, entries }: { auction: Auction; meta: CollectionMetadata | null; entries: ItemEntry[] | null }) {
  const [shown, setShown] = useState(GALLERY_PAGE);
  const supply = Number(auction.supply);
  let tiles: ReactNode[];
  let more = 0;
  let lede: string;
  if (auction.unrevealed) {
    const veil = meta?.preview ?? meta?.image ?? null;
    tiles = Array.from({ length: Math.min(6, supply) }, (_, i) => (
      <NftTile key={i} uri={null} name={`${auction.itemName} #?`} caption="Revealed after the sale" image={veil} />
    ));
    lede = `${plural(supply, "NFT")}, hidden until the seller reveals them after the sale. Bid on the collection: which NFTs you get is drawn at random.`;
  } else if (auction.namedItems) {
    if (!entries) return null;
    tiles = entries.slice(0, shown).map((entry, k) => {
      const start = itemStart(entries, k);
      const editions = entry.end - start;
      return (
        <NftTile
          key={k}
          uri={nftMetadataUri(auction, start)}
          name={entry.name}
          caption={editions === 1 ? "One of a kind" : `${formatCount(editions)} editions`}
        />
      );
    });
    more = entries.length - shown;
    lede = `${plural(entries.length, "item")}, ${plural(supply, "NFT")} in all. Which ones each winner gets is drawn at random after the sale.`;
  } else if (!auction.uriPerItem) {
    tiles = [<NftTile key={0} uri={auction.itemUri} name={`${auction.itemName} #1 to #${formatCount(supply)}`} caption="Every NFT shows this" />];
    lede = `${plural(supply, "NFT")}, all with the same art.`;
  } else {
    tiles = Array.from({ length: Math.min(shown, supply) }, (_, n) => (
      <NftTile key={n} uri={nftMetadataUri(auction, n)} name={`${auction.itemName} #${n + 1}`} />
    ));
    more = supply - shown;
    lede = `${plural(supply, "NFT")}. Which ones each winner gets is drawn at random after the sale, so nobody can pick the rare ones.`;
  }
  return (
    <section className="gallery" aria-labelledby="gallery-title">
      <h2 id="gallery-title" className="gallery__title">
        In this collection
      </h2>
      <p className="muted">{lede}</p>
      <ul className="nftgrid">{tiles}</ul>
      {more > 0 ? (
        <Button variant="quiet" onClick={() => setShown((n) => n + GALLERY_PAGE * 2)}>
          Show more ({formatCount(more)} left)
        </Button>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

export function AuctionPage({ address }: { address: string }) {
  const now = useNow();
  const { publicKey } = useWallet();
  const key = useMemo(() => {
    try {
      return new PublicKey(address);
    } catch {
      return null;
    }
  }, [address]);
  const loaded = useLoader(
    async () => {
      if (!key) return null;
      const auction = await fetchAuction(key);
      const bids = auction ? await fetchBidsForAuction(key) : [];
      return auction ? { auction, bids } : null;
    },
    [address],
    8_000
  );
  const admin = useLoader(fetchAdmin, []);
  const auction = loaded.data?.auction ?? null;
  const [replaced, setReplaced] = useState(0);

  // Notes for bids that no longer exist are deleted. While the auction is
  // open, a bid can only disappear by being replaced in a full auction.
  useEffect(() => {
    if (!loaded.data) return;
    const { auction: a, bids: live } = loaded.data;
    const removed = forgetClosedBids(a.address, live.map((b) => b.address));
    // Before the safety net opens, an open auction's bids only close when replaced.
    if (removed > 0 && a.status === "open" && Date.now() / 1000 < emergencyOpensAt(a)) {
      setReplaced((n) => n + removed);
    }
  }, [loaded.data]);
  const asset = useAssetInfo(auction);
  const collectionUri = asset.collection?.uri ?? null;
  const meta = useLoader(
    () => (collectionUri ? fetchCollectionMetadata(collectionUri) : Promise.resolve(null)),
    [collectionUri]
  );
  const named = Boolean(auction?.namedItems);
  const itemList = useLoader(() => (named && key ? fetchItemList(key) : Promise.resolve(null)), [address, named]);
  const entries = itemList.data?.entries ?? null;

  if (!key) return <main className="page"><Notice tone="error">That is not a valid auction address.</Notice></main>;
  if (loaded.loading && !loaded.data) return <main className="page"><p className="muted">Loading auction…</p></main>;
  if (!auction) {
    return (
      <main className="page">
        <Notice tone="error">{loaded.error ?? "No auction was found at this address."}</Notice>
      </main>
    );
  }

  const bids = loaded.data?.bids ?? [];
  const phase = phaseOf(auction, now);
  const bidding = phase === "bidding";
  const cleared = auction.status === "settling" || (auction.status === "finished" && auction.sold > 0n);
  const collection = auction.kind === "collection";
  const token = asset.token;
  const locked = collection ? true : token ? token.mintAuthority === null && token.freezeAuthority === null : null;
  const isAdmin = Boolean(publicKey && admin.data && admin.data.equals(publicKey));
  const firstName = `${auction.itemName} #1`;
  const lastName = `${auction.itemName} #${formatCount(Number(auction.supply))}`;
  const minPrice = formatPrice(auction, auction.minPrice, asset.decimals);

  const about = collection ? meta.data ?? null : null;

  return (
    <main className="page">
      <a className="back" href="#/">
        All auctions
      </a>
      {about?.banner ? <img className="auction-banner" src={about.banner} alt="" referrerPolicy="no-referrer" /> : null}
      <header className="auction-head">
        {collection ? <CollectionArt uri={collectionUri} name={asset.title} image={about?.image ?? null} /> : null}
        <div className="auction-head__text">
          <h1 className="auction-head__title">
            {asset.title}
            {collection ? (
              <span className="auction-head__name">
                {about?.kind === "drop" ? "Drop" : about?.kind === "collection" ? "Collection" : "NFT collection"}
              </span>
            ) : token?.name && token.symbol ? (
              <span className="auction-head__name">{token.name}</span>
            ) : null}
          </h1>
          {about?.description ? <p className="auction-head__about">{about.description}</p> : null}
          {about?.website || about?.x ? (
            <p className="auction-head__links">
              {about.website ? (
                <a href={about.website} target="_blank" rel="noreferrer noopener nofollow">
                  Website
                </a>
              ) : null}
              {about.x ? (
                <a href={about.x} target="_blank" rel="noreferrer noopener nofollow">
                  X
                </a>
              ) : null}
            </p>
          ) : null}
          <p className="auction-head__mint">
            {collection ? "Collection address" : "Token address"}{" "}
            <AddressLink address={auction.mint} label={auction.mint.toBase58()} />
          </p>
          <p className="auction-head__status">{statusText(auction, now, asset)}</p>
        </div>
        <div className="auction-head__tags">
          {auction.featured ? <span className="tag tag--featured">Featured</span> : null}
          {collection && auction.unrevealed ? <span className="tag tag--warn">Art hidden until revealed</span> : null}
          {collection ? <span className="tag tag--ok">Minted only for winners</span> : null}
          {!collection && locked ? <span className="tag tag--ok">Supply locked</span> : null}
          {!collection && locked === false ? <span className="tag tag--warn">Supply not locked</span> : null}
        </div>
      </header>
      {isAdmin ? <AdminControls auction={auction} refresh={loaded.reload} /> : null}
      {replaced > 0 ? (
        <Notice tone="info">
          {replaced === 1 ? "One of your bids was" : `${replaced} of your bids were`} replaced by a larger deposit
          after the auction filled up. The deposit went back to your wallet in full.
        </Notice>
      ) : null}

      <div className="auction-grid">
        <AuctionBoard auction={auction} asset={asset} bids={bids} now={now} />
        <dl className="facts">
            <div>
              <dt>For sale</dt>
              <dd>
                {supplyDescription(auction, asset)}
                {collection ? (
                  <span className="muted">
                    {" "}
                    (
                    {auction.namedItems
                      ? entries
                        ? `${plural(entries.length, "item")}, each named`
                        : "named per item"
                      : auction.supply === 1n
                        ? firstName
                        : `${firstName} to ${lastName}`}
                    )
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Minimum price</dt>
              <dd>
                {minPrice} per {asset.unit}
              </dd>
            </div>
            <div>
              <dt>Smallest bid</dt>
              <dd>
                {collection
                  ? `One NFT at the minimum price, ${formatSol(auction.minDeposit)} SOL`
                  : `A sealed budget of ${formatSol(auction.minDeposit)} SOL`}
              </dd>
            </div>
            {collection ? (
              <div>
                <dt>Most per bid</dt>
                <dd>{plural(auction.maxPerBid, "NFT")}</dd>
              </div>
            ) : null}
            <div>
              <dt>Bidding {now < auction.startTime ? "opens" : "opened"}</dt>
              <dd>{formatDateTime(auction.startTime)}</dd>
            </div>
            <div>
              <dt>Bidding {now < auction.endTime ? "ends" : "ended"}</dt>
              <dd>{formatDateTime(auction.endTime)}</dd>
            </div>
            <div>
              <dt>Total deposited</dt>
              <dd>
                {formatSol(auction.totalDeposited)} SOL
                <span className="muted"> across {plural(auction.bidCount, "bid")}</span>
              </dd>
            </div>
            {cleared ? (
              <div>
                <dt>Sold so far</dt>
                <dd>
                  {goodsAmount(auction.sold, asset)} of {supplyDescription(auction, asset)}
                </dd>
              </div>
            ) : null}
            {collection ? (
              <>
                <div>
                  <dt>NFT metadata</dt>
                  <dd className="facts__wrap">
                    {auction.unrevealed ? (
                      <>
                        Hidden until the seller reveals it. Its link is fixed already:{" "}
                        <span className="muted">{auction.itemUri}</span>
                      </>
                    ) : auction.uriPerItem ? (
                      <>
                        One file per NFT: <span className="muted">{auction.itemUri}</span>0.json for #1, and so on.
                      </>
                    ) : (
                      <>
                        Every NFT uses <span className="muted">{auction.itemUri}</span>
                      </>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Royalty</dt>
                  <dd>
                    {auction.royaltyBps > 0
                      ? `${formatPercent(auction.royaltyBps)} of resales, to the seller`
                      : "None"}
                  </dd>
                </div>
              </>
            ) : (
              <div>
                <dt>Token</dt>
                <dd>
                  <AddressLink address={auction.mint} />
                </dd>
              </div>
            )}
            <div>
              <dt>Seller</dt>
              <dd>
                <AddressLink address={auction.seller} />
              </dd>
            </div>
            <div>
              <dt>Platform fee</dt>
              <dd>{auction.saleFeeBps > 0 ? `${formatPercent(auction.saleFeeBps)} of the proceeds, paid by the seller` : "None"}</dd>
            </div>
        </dl>
        <div className="auction-grid__side">
          {phase === "upcoming" ? (
            <section className="panel" aria-labelledby="opens-title">
              <h2 id="opens-title" className="panel__title">
                Place a sealed bid
              </h2>
              <p>
                Bidding opens {formatDateTime(auction.startTime)}, in {formatDuration(auction.startTime - now)}. Come
                back then to place yours.
              </p>
            </section>
          ) : bidding ? (
            collection ? (
              <NftBidComposer auction={auction} asset={asset} onPlaced={loaded.reload} />
            ) : (
              <TokenBidComposer auction={auction} asset={asset} onPlaced={loaded.reload} />
            )
          ) : null}
          <YourBids auction={auction} asset={asset} bids={bids} now={now} refresh={loaded.reload} entries={entries} />
          <Progress
            auction={auction}
            asset={asset}
            bids={bids}
            now={now}
            refresh={loaded.reload}
            meta={about}
            collectionUri={collectionUri}
          />
        </div>
      </div>
      {collection ? <Gallery auction={auction} meta={about} entries={entries} /> : null}
    </main>
  );
}
