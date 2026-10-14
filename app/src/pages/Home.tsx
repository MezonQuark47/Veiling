import { useMemo, useState } from "react";
import { DemandChart } from "../components/DemandChart";
import { AuctionTable, statusText, supplyDescription } from "../components/AuctionTable";
import { Button, Notice, useAction, useAssetInfo, useLoader, useMetadataImage, useNow } from "../components/ui";
import { buildAcceptAdmin } from "../lib/actions";
import { type Auction, fetchAdminRoles, fetchAuctions, formatPrice, phaseOf } from "../lib/chain";
import { formatCount, formatSol } from "../lib/format";
import { sendTransaction } from "../lib/tx";
import { useWallet } from "../lib/wallet";

type Filter = "live" | "upcoming" | "ended" | "all";

const FILTERS: [Filter, string][] = [
  ["live", "Live"],
  ["upcoming", "Upcoming"],
  ["ended", "Ended"],
  ["all", "All"],
];

/** 0: bidding, 1: settling, 2: starts later, 3: over. */
function rank(a: Auction, now: number): number {
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

/** Shown to the wallet the admin has offered the role to, until it accepts. */
function AdminOffer({ accepted, onAccepted }: { accepted: boolean; onAccepted: () => void }) {
  const { signer } = useWallet();
  const action = useAction();
  if (accepted) {
    return (
      <div className="offer">
        <Notice tone="success">You are now the admin. Each auction page has buttons to feature or hide it.</Notice>
      </div>
    );
  }
  const accept = () =>
    action.run("accept", async () => {
      if (!signer) return;
      await sendTransaction(await buildAcceptAdmin(signer.publicKey), signer);
      onAccepted();
    });
  return (
    <div className="offer">
      <Notice>
        <p>
          This wallet has been offered the admin role. The admin features and hides auctions and sets the
          platform fees, within the caps the program enforces.
        </p>
        <div className="actions">
          <Button variant="primary" onClick={accept} busy={action.busy === "accept"} disabled={!signer}>
            Accept the admin role
          </Button>
        </div>
      </Notice>
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
    </div>
  );
}

export function Home() {
  const now = useNow();
  const { publicKey } = useWallet();
  const [filter, setFilter] = useState<Filter>("live");
  const auctions = useLoader(fetchAuctions, [], 15_000);
  const roles = useLoader(fetchAdminRoles, []);
  const [accepted, setAccepted] = useState(false);
  const isAdmin = Boolean(publicKey && roles.data && roles.data.admin.equals(publicKey));
  const offered = Boolean(publicKey && roles.data?.pendingAdmin?.equals(publicKey));

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
      {offered || accepted ? (
        <AdminOffer
          accepted={accepted}
          onAccepted={() => {
            setAccepted(true);
            roles.reload();
          }}
        />
      ) : null}
      <section className="hero">
        <div className="hero__copy">
          <h1 className="hero__title">Sealed bids. One fair price.</h1>
          <p className="hero__lede">
            Tokens and NFT collections, sold by sealed bid. Name the most you would pay and it stays encrypted.
            When bidding closes, one clearing price is found, every winner pays it, and whatever you do not spend
            comes back.
          </p>
          <div className="hero__actions">
            <a className="btn btn--primary" href="#/launch">
              Launch an auction
            </a>
            <a className="btn btn--quiet" href="#/docs">
              How it works
            </a>
          </div>
        </div>
        <div className="hero__visual">
          {featured ? <FeaturedCard auction={featured} now={now} /> : <DemandChart animate />}
        </div>
      </section>

      <section className="section" aria-labelledby="all-auctions">
        <div className="section__head">
          <h2 id="all-auctions" className="section__title">
            Auctions
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

      <section className="section how" id="how" aria-labelledby="how-title">
        <h2 id="how-title" className="section__title">
          How a sealed auction works
        </h2>
        <div className={featured ? "how__layout" : undefined}>
          <ol className="steps">
            <li>
              <h3>Name your price</h3>
              <p>
                For a token, deposit the SOL you want to spend and set the most you would pay per token. For an
                NFT collection, choose how many NFTs and the most you would pay for each.
              </p>
            </li>
            <li>
              <h3>Your bid is sealed</h3>
              <p>
                Your price is encrypted in your browser and tied to your bid, so nobody can copy it elsewhere.
                Arcium's network works with the bids without anyone, including us, seeing them one by one.
              </p>
            </li>
            <li>
              <h3>One price clears everyone</h3>
              <p>
                After bidding closes, the clearing price is the highest price at which the bids cover the supply.
                Bids above it win, bids exactly at it share what is left, and every winner pays that one price.
                Token bids spend their budget at it, so a lower price buys more. Bids below it stay sealed and
                are refunded in full.
              </p>
            </li>
          </ol>
          {featured ? <DemandChart className="how__chart" /> : null}
        </div>
        <p className="how__fine">
          Every token sold here has a fixed supply: its mint and freeze rights are revoked before the auction
          opens. An NFT collection is created with its auction and only winners' NFTs are ever minted. If the
          private network ever stalls, bidders can take back their deposits and sellers their tokens three days
          after the end. <a href="#/docs">Read the details</a>.
        </p>
      </section>
    </main>
  );
}
