import { useMemo, useState } from "react";
import { AuctionTable, statusText, supplyDescription } from "../components/AuctionTable";
import { Notice, useAssetInfo, useLoader, useMetadataImage, useNow } from "../components/ui";
import { type Auction, fetchAdminRoles, fetchAuctions, formatPrice, phaseOf } from "../lib/chain";
import { formatCount, formatSol } from "../lib/format";
import { useWallet } from "../lib/wallet";

type Filter = "live" | "upcoming" | "ended" | "all";

const FILTERS: [Filter, string][] = [
  ["live", "Live"],
  ["upcoming", "Upcoming"],
  ["ended", "Ended"],
  ["all", "All"],
];

/** 0: bidding, 1: settling, 2: starts later, 3: over. */
export function rank(a: Auction, now: number): number {
  const phase = phaseOf(a, now);
  if (phase === "bidding") return 0;
  if (phase === "checking" || phase === "ready-to-clear" || phase === "settling") return 1;
  if (phase === "upcoming") return 2;
  return 3;
}

function matches(filter: Filter, a: Auction, now: number): boolean {
  const r = rank(a, now);
  if (filter === "live") return r < 2;
  if (filter === "upcoming") return r === 2;
  if (filter === "ended") return r === 3;
  return true;
}

/** The featured auction, leading the front page. */
function FeaturedCard({ auction, now }: { auction: Auction; now: number }) {
  const asset = useAssetInfo(auction);
  const art = useMetadataImage(asset.collection?.uri ?? null);
  const phase = phaseOf(auction, now);
  const bidding = phase === "bidding";
  return (
    <a className="feature" href={`#/auction/${auction.address.toBase58()}`}>
      <span className="feature__top">
        <span className="tag tag--featured">Featured</span>
        <span className="feature__status">{statusText(auction, now, asset)}</span>
      </span>
      {art ? <img className="feature__art" src={art} alt="" referrerPolicy="no-referrer" loading="lazy" /> : null}
      <span className="feature__title">{asset.title}</span>
      <span className="feature__sub">{asset.sub}</span>
      <dl className="feature__facts">
        <div>
          <dt>For sale</dt>
          <dd>{supplyDescription(auction, asset)}</dd>
        </div>
        <div>
          <dt>Minimum price</dt>
          <dd>
            {formatPrice(auction, auction.minPrice, asset.decimals)} <span className="muted">per {asset.unit}</span>
          </dd>
        </div>
        <div>
          <dt>Sealed bids</dt>
          <dd>{formatCount(auction.bidCount)}</dd>
        </div>
        <div>
          <dt>Deposited</dt>
          <dd>{formatSol(auction.totalDeposited, 2)} SOL</dd>
        </div>
      </dl>
      <span className="btn btn--primary feature__cta">
        {bidding ? "Place a sealed bid" : phase === "upcoming" ? "See what is coming" : "View the auction"}
      </span>
    </a>
  );
}

/** Every sale: the featured one first, then live, upcoming and ended ones. */
export function Auctions() {
  const now = useNow();
  const { publicKey } = useWallet();
  const [filter, setFilter] = useState<Filter>("live");
  const auctions = useLoader(fetchAuctions, [], 15_000);
  const roles = useLoader(fetchAdminRoles, []);
  const isAdmin = Boolean(publicKey && roles.data && roles.data.admin.equals(publicKey));

  const visible = useMemo(() => {
    const list = (auctions.data ?? []).filter((a) => isAdmin || !a.hidden);
    return list.sort((x, y) => {
      if (x.featured !== y.featured) return x.featured ? -1 : 1;
      const r = rank(x, now) - rank(y, now);
      if (r !== 0) return r;
      // Upcoming sales: the next to open first.
      return rank(x, now) === 2 ? x.startTime - y.startTime : y.startTime - x.startTime;
    });
  }, [auctions.data, isAdmin, now]);

  const featured = visible.find((a) => a.featured && !a.hidden && rank(a, now) < 3) ?? visible.find((a) => a.featured);
  const filtered = visible.filter((a) => matches(filter, a, now));

  return (
    <main className="page">
      <h1 className="page__title">Auctions</h1>
      <p className="page__lede">Bid on live sales, see what opens next, and how past sales cleared.</p>
      {featured ? (
        <div className="auctions__featured">
          <FeaturedCard auction={featured} now={now} />
        </div>
      ) : null}
      <section className="section" aria-labelledby="all-auctions-title">
        <div className="section__head">
          <h2 id="all-auctions-title" className="section__title">
            All sales
          </h2>
          <div className="segmented" role="group" aria-label="Filter auctions">
            {FILTERS.map(([f, label]) => (
              <button
                key={f}
                className={`segmented__item${filter === f ? " segmented__item--on" : ""}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {auctions.error ? <Notice tone="error">Could not load auctions: {auctions.error}</Notice> : null}
        {auctions.loading && !auctions.data ? <p className="muted">Loading auctions…</p> : null}
        {auctions.data && filtered.length === 0 ? (
          <div className="empty">
            <p>
              {filter === "live"
                ? "No live auctions right now."
                : filter === "upcoming"
                ? "No scheduled auctions right now."
                : "Nothing here yet."}
            </p>
            <a className="btn btn--secondary" href="#/launch">
              Launch the first one
            </a>
          </div>
        ) : null}
        {filtered.length > 0 ? <AuctionTable auctions={filtered} now={now} /> : null}
      </section>
    </main>
  );
}
