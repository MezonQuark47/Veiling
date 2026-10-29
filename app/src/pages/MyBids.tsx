import { useMemo, useState } from "react";
import { LeftoverNotes, NoteUnlock } from "../components/BidNotes";
import { AddressLink, Button, Notice, goodsAmount, useAssetInfo, useLoader, useNow } from "../components/ui";
import { openOnClick, statusText } from "../components/AuctionTable";
import { type Auction, type Bid, fetchAuction, fetchBidsForBidder, formatPrice, priceSuffix, revealMissed, waitsForPool } from "../lib/chain";
import { noteSize, readNote } from "../lib/notes";
import { formatSol, plural } from "../lib/format";
import { requestConnect, useWallet } from "../lib/wallet";
import { DashboardSummary, JoinedSales, LaunchedSales } from "../components/Dashboard";
import { Avatar } from "../components/Account";
import { fetchWalletView } from "../lib/stats";
import { SEASON, STATS_URL } from "../config";
import { InviteCard } from "../components/Invite";
import { shortAddress } from "../lib/format";

function AuctionBids({ auction, bids, now }: { auction: Auction; bids: Bid[]; now: number }) {
  const asset = useAssetInfo(auction);
  const open = openOnClick(`#/auction/${auction.address.toBase58()}`);
  return (
    <li
      className="mybids__auction mybids__auction--link"
      onClick={open}
      onAuxClick={(e) => {
        if (e.button === 1) open(e);
      }}
    >
      <a href={`#/auction/${auction.address.toBase58()}`} className="mybids__title">
        <strong>{asset.title}</strong> <span className="muted">{statusText(auction, now, asset)}</span>
      </a>
      <ul className="bidlist">
        {bids.map((b) => {
          const note = readNote(b.address);
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
                    ? `Sealed: a budget of ${formatSol(noteSize(note) > 0n ? noteSize(note) : b.deposit)} SOL at up to ${sealedAt}${priceSuffix(auction, asset.unit)}.`
                    : `Sealed for ${plural(Number(noteSize(note)), "NFT")} at up to ${sealedAt} each.`}
                </p>
              ) : null}
              <p className="bidlist__state">
                {b.status === "sealed"
                  ? "Sealed"
                  : b.status === "atClearing"
                    ? "At the final price. Your share is ready to collect on the auction page once every bid at that price is revealed."
                    : b.won > 0n && auction.kind === "collection" && auction.unrevealed && !b.delivered
                      ? revealMissed(auction, now)
                        ? `Won ${goodsAmount(b.won, asset)}, but the art was not revealed in time. Take your whole deposit back on the auction page.`
                        : `Won ${goodsAmount(b.won, asset)} for ${formatSol(b.payment)} SOL. They are made once the seller reveals the art.`
                      : waitsForPool(auction, b)
                        ? `Won ${goodsAmount(b.won, asset)} for ${formatSol(b.payment)} SOL. Collect them on the auction page once the token's pool is open.`
                        : b.won > 0n
                        ? `Won ${goodsAmount(b.won, asset)} for ${formatSol(b.payment)} SOL. Collect your ${asset.goods} and refund on the auction page.`
                        : "Did not win. Collect your deposit on the auction page."}
              </p>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function MyBids() {
  const now = useNow(5_000);
  const { publicKey } = useWallet();
  const key = publicKey?.toBase58();
  const loaded = useLoader(
    async () => {
      if (!publicKey) return [];
      const bids = await fetchBidsForBidder(publicKey);
      const byAuction = new Map<string, Bid[]>();
      for (const b of bids) {
        const k = b.auction.toBase58();
        byAuction.set(k, [...(byAuction.get(k) ?? []), b]);
      }
      const auctions = await Promise.all([...byAuction.keys()].map((k) => fetchAuction(bids.find((b) => b.auction.toBase58() === k)!.auction)));
      return auctions
        .filter((a): a is Auction => a !== null)
        .map((a) => ({ auction: a, bids: (byAuction.get(a.address.toBase58()) ?? []).sort((x, y) => x.index - y.index) }));
    },
    [key],
    15_000
  );
  // The wallet's whole history, from the keeper (lib/stats.ts); null without one.
  const history = useLoader(() => (key ? fetchWalletView(key) : Promise.resolve(null)), [key], 60_000);
  const view = history.data ?? null;
  const firstAt = view ? Math.min(...[...view.joined, ...view.launched].map((x) => x.at)) : Infinity;
  const since = Number.isFinite(firstAt)
    ? new Date(firstAt * 1000).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : null;
  const groups = useMemo(() => (loaded.data ?? []).sort((x, y) => y.auction.endTime - x.auction.endTime), [loaded.data]);
  const allBids = useMemo(() => groups.flatMap((g) => g.bids), [groups]);
  // Bumped when notes from chain arrive, to show them.
  const [, setNotesOpened] = useState(0);

  const openBids = loaded.error ? (
    <Notice tone="error">Could not load your bids: {loaded.error}</Notice>
  ) : loaded.loading && !loaded.data ? (
    <div className="skeletons" aria-label="Loading your bids" role="status">
      {[0, 1, 2].map((n) => (
        <span key={n} className="skeleton skeleton--row" />
      ))}
    </div>
  ) : groups.length === 0 ? (
    <div className="empty">
      <p>No open bids right now.</p>
      <a className="btn btn--secondary" href="#/auctions">
        Browse auctions
      </a>
    </div>
  ) : (
    <>
      <NoteUnlock bids={allBids} onOpened={() => setNotesOpened((n) => n + 1)} />
      <ul className="mybids">
        {groups.map((g) => (
          <AuctionBids key={g.auction.address.toBase58()} auction={g.auction} bids={g.bids} now={now} />
        ))}
      </ul>
    </>
  );

  return (
    <main className="page">
      {publicKey ? (
        <header className="profile">
          <Avatar address={publicKey.toBase58()} size={72} />
          <div className="profile__text">
            <h1 className="page__title">Dashboard</h1>
            <p className="profile__address">
              <AddressLink address={publicKey} label={shortAddress(publicKey.toBase58(), 6)} copy />
            </p>
            <p className="profile__meta">
              {since ? `On Veiling since ${since}` : "New to Veiling"}
              {view?.rank ? ` · #${view.rank} on the leaderboard` : ""}
              {view?.season && view.season.points > 0
                ? ` · ${view.season.points.toLocaleString("en-US")} ${view.season.name} points${view.season.rank ? ` (#${view.season.rank})` : ""}`
                : ""}
            </p>
          </div>
          <div className="profile__actions">
            <a className="btn btn--secondary" href="#/stats">
              Leaderboard
            </a>
            <a className="btn btn--primary" href="#/auctions">
              Find a sale
            </a>
          </div>
        </header>
      ) : (
        <h1 className="page__title">Dashboard</h1>
      )}
      {!publicKey ? (
        <div className="empty dash__connect">
          <p>
            Connect your wallet to see everything it has done on Veiling: your bids, the sales you joined and
            launched, what you spent and won, and your points.
          </p>
          <Button variant="primary" onClick={requestConnect}>
            Connect wallet
          </Button>
        </div>
      ) : (
        <>
          {view ? <DashboardSummary view={view} /> : null}

          <section className="section" aria-label="Invite friends">
            <InviteCard wallet={publicKey.toBase58()} view={view} />
            {SEASON ? (
              <p className="muted dash__note">
                Invites count for <a href="#/season">{SEASON.name}</a> too.
              </p>
            ) : null}
          </section>

          <section className="section" aria-labelledby="open-bids-title">
            <div className="section__head">
              <h2 id="open-bids-title" className="section__title">
                Open bids
              </h2>
            </div>
            {openBids}
          </section>

          {view ? (
            <section className="section" aria-labelledby="joined-title">
              <div className="section__head">
                <h2 id="joined-title" className="section__title">
                  Sales you joined
                </h2>
              </div>
              <JoinedSales sales={view.joined} />
            </section>
          ) : null}

          {view && view.launched.length > 0 ? (
            <section className="section" aria-labelledby="launched-title">
              <div className="section__head">
                <h2 id="launched-title" className="section__title">
                  Sales you launched
                </h2>
              </div>
              <LaunchedSales sales={view.launched} />
            </section>
          ) : null}

          {!STATS_URL && !view ? (
            <p className="muted dash__note">Your full history appears here once Veiling's stats are available.</p>
          ) : null}
          <LeftoverNotes />
        </>
      )}
    </main>
  );
}
