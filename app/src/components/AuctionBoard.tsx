import { type Auction, type Bid, bidCapacity, formatPrice, phaseOf } from "../lib/chain";
import { formatCount, formatDateTime, formatDuration } from "../lib/format";
import { statusText } from "./AuctionTable";
import { type AssetInfo, goodsAmount } from "./ui";

type Place = "empty" | "sealed" | "won" | "at" | "lost" | "closed";

/** The state of each of the auction's bid places, by bid index. */
function places(a: Auction, bids: Bid[]): Place[] {
  const byIndex = new Map(bids.map((b) => [b.index, b]));
  return Array.from({ length: bidCapacity(a) }, (_, i) => {
    if (i >= a.bidCount) return "empty";
    const b = byIndex.get(i);
    // While bidding is open a bid account can only be replaced, never closed,
    // so a missing one has not loaded yet.
    if (!b) return a.status === "open" ? "sealed" : "closed";
    if (b.status === "sealed") return "sealed";
    if (b.status === "atClearing") return "at";
    return b.won > 0n ? "won" : "lost";
  });
}

const PLACE_LABELS: Record<Exclude<Place, "empty">, string> = {
  sealed: "Sealed",
  won: "Won",
  at: "At the clearing price",
  lost: "Did not win",
  closed: "Collected",
};

/**
 * Every bid place of the auction, sealed or decided: 256 per page of its bid
 * book, up to 1,024. Shows how full the auction is (a full one only takes bids
 * that out-deposit the smallest) and, after the price is found, which bids
 * won. Prices are never shown.
 */
function BidBook({ auction, bids }: { auction: Auction; bids: Bid[] }) {
  const all = places(auction, bids);
  const capacity = all.length;
  const columns = 32;
  const cell = 10;
  const gap = 3;
  const rows = capacity / columns;
  const present = (Object.keys(PLACE_LABELS) as (keyof typeof PLACE_LABELS)[]).filter((p) => all.includes(p));
  return (
    <figure className="book">
      <svg
        className="book__grid"
        viewBox={`-1 -1 ${columns * (cell + gap) - gap + 2} ${rows * (cell + gap) - gap + 2}`}
        role="img"
        aria-label={`${auction.bidCount} of ${capacity} bid places taken`}
      >
        {all.map((place, i) => (
          <rect
            key={i}
            className={`book__place book__place--${place}`}
            x={(i % columns) * (cell + gap)}
            y={Math.floor(i / columns) * (cell + gap)}
            width={cell}
            height={cell}
            rx={2}
          />
        ))}
      </svg>
      <figcaption className="book__caption">
        <span>
          {formatCount(auction.bidCount)} of {formatCount(capacity)} bid places taken
          {auction.bidCount >= capacity ? ". New bids must out-deposit the smallest." : "."}
        </span>
        {present.length > 1 || (present.length === 1 && present[0] !== "sealed") ? (
          <span className="book__legend">
            {present.map((p) => (
              <span key={p} className="book__key">
                <span className={`book__swatch book__place--${p}`} aria-hidden="true" />
                {PLACE_LABELS[p]}
              </span>
            ))}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/**
 * Where the supply goes at the revealed price: to the bids above it, shared by
 * the bids exactly at it, or back to the seller. Token amounts are worked out
 * from the budgets revealed with the price, so they are close to, not exactly,
 * what settlement delivers.
 */
function allocation(a: Auction): { above: bigint; at: bigint; unsold: bigint } {
  if (a.kind === "collection") {
    const above = a.weightAbove < a.supply ? a.weightAbove : a.supply;
    return a.filled ? { above, at: a.supply - above, unsold: 0n } : { above, at: 0n, unsold: a.supply - above };
  }
  const bought = a.clearingPrice > 0n ? (a.weightAbove * a.priceUnit) / a.clearingPrice : 0n;
  const above = bought < a.supply ? bought : a.supply;
  return a.filled ? { above, at: a.supply - above, unsold: 0n } : { above, at: 0n, unsold: a.supply - above };
}

function SupplyBar({ auction, asset }: { auction: Auction; asset: AssetInfo }) {
  const { above, at, unsold } = allocation(auction);
  const share = (part: bigint) => (auction.supply > 0n ? Number((part * 10_000n) / auction.supply) / 100 : 0);
  const parts = [
    // When demand fell short, every valid bid won all it asked for at the minimum price.
    { key: "above", amount: above, label: auction.filled ? "To bids above the price" : "To the winning bids" },
    { key: "at", amount: at, label: "Shared by bids at the price" },
    { key: "unsold", amount: unsold, label: "Unsold, back to the seller" },
  ].filter((p) => p.amount > 0n);
  return (
    <div className="supply">
      <div className="supply__bar" aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key} className={`supply__part supply__part--${p.key}`} style={{ width: `${share(p.amount)}%` }} />
        ))}
      </div>
      <dl className="supply__legend">
        {parts.map((p) => (
          <div key={p.key}>
            <dt>
              <span className={`supply__swatch supply__part--${p.key}`} aria-hidden="true" />
              {p.label}
            </dt>
            <dd>
              {auction.kind === "token" ? "about " : ""}
              {goodsAmount(p.amount, asset, 2)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The auction's headline: time left while bidding, then the price everyone pays. */
export function AuctionBoard({
  auction,
  asset,
  bids,
  now,
}: {
  auction: Auction;
  asset: AssetInfo;
  bids: Bid[];
  now: number;
}) {
  const phase = phaseOf(auction, now);
  const cleared = auction.status === "settling" || (auction.status === "finished" && auction.sold > 0n);
  return (
    <section className="board" aria-label="Auction status">
      <div className={`board__headline${cleared ? " board__headline--cleared" : ""}`}>
        {phase === "upcoming" ? (
          <>
            <p className="board__label">Bidding opens in</p>
            <p className="board__value">{formatDuration(auction.startTime - now)}</p>
            <p className="board__sub">
              {formatDateTime(auction.startTime)}, then runs until {formatDateTime(auction.endTime)}.
            </p>
          </>
        ) : phase === "bidding" ? (
          <>
            <p className="board__label">Bidding closes in</p>
            <p className="board__value">{formatDuration(auction.endTime - now)}</p>
            <p className="board__sub">
              {formatDateTime(auction.endTime)}. Every price stays sealed until then, and after.
              {auction.extendedSecs > 0
                ? ` Extended by ${formatDuration(auction.extendedSecs)}: a bid was replaced near the end, so its owner had time to answer.`
                : ""}
            </p>
          </>
        ) : cleared ? (
          <>
            <p className="board__label">{auction.filled ? "Clearing price" : "Demand fell short, so every valid bid won at the minimum price"}</p>
            <p className="board__value">
              {formatPrice(auction, auction.clearingPrice, asset.decimals)}
              <span className="board__unit"> per {asset.unit}</span>
            </p>
            <p className="board__sub">Every winner pays this price, whatever they bid.</p>
          </>
        ) : (
          <>
            <p className="board__label">Status</p>
            <p className="board__value board__value--text">{statusText(auction, now, asset)}</p>
          </>
        )}
      </div>
      {cleared ? <SupplyBar auction={auction} asset={asset} /> : null}
      <BidBook auction={auction} bids={bids} />
    </section>
  );
}
