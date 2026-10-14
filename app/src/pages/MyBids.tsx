import { useMemo, useState } from "react";
import { LeftoverNotes, NoteUnlock } from "../components/BidNotes";
import { Notice, goodsAmount, useAssetInfo, useLoader, useNow } from "../components/ui";
import { statusText } from "../components/AuctionTable";
import { type Auction, type Bid, fetchAuction, fetchBidsForBidder, formatPrice, revealMissed } from "../lib/chain";
import { readNote } from "../lib/notes";
import { formatSol, plural } from "../lib/format";
import { useWallet } from "../lib/wallet";

function AuctionBids({ auction, bids, now }: { auction: Auction; bids: Bid[]; now: number }) {
  const asset = useAssetInfo(auction);
  return (
    <li className="mybids__auction">
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
                  {auction.kind === "token" ? "Budget" : "Deposit"} {formatSol(b.deposit)} SOL
                </span>
              </div>
              {note && sealedAt ? (
                <p className="bidlist__note">
                  {auction.kind === "token"
                    ? `Sealed at up to ${sealedAt} per ${asset.unit}.`
                    : `Sealed for ${plural(note.quantity, "NFT")} at up to ${sealedAt} each.`}
                </p>
              ) : null}
              <p className="bidlist__state">
                {b.status === "sealed"
                  ? "Sealed"
                  : b.status === "atClearing"
                    ? "At the clearing price. Your share is ready to collect on the auction page once every bid at that price is revealed."
                    : b.won > 0n && auction.kind === "collection" && auction.unrevealed && !b.delivered
                      ? revealMissed(auction, now)
                        ? `Won ${goodsAmount(b.won, asset)}, but the art was not revealed in time. Take your whole deposit back on the auction page.`
                        : `Won ${goodsAmount(b.won, asset)} for ${formatSol(b.payment)} SOL. They are minted once the seller reveals the art.`
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
  const groups = useMemo(() => (loaded.data ?? []).sort((x, y) => y.auction.endTime - x.auction.endTime), [loaded.data]);
  const allBids = useMemo(() => groups.flatMap((g) => g.bids), [groups]);
  // Bumped when notes from chain arrive, to show them.
  const [, setNotesOpened] = useState(0);

  return (
    <main className="page">
      <h1 className="page__title">My bids</h1>
      {!publicKey ? (
        <p className="muted">Connect a wallet to see your bids.</p>
      ) : loaded.error ? (
        <Notice tone="error">Could not load your bids: {loaded.error}</Notice>
      ) : loaded.loading && !loaded.data ? (
        <p className="muted">Loading…</p>
      ) : groups.length === 0 ? (
        <div className="empty">
          <p>You have not bid on anything yet.</p>
          <a className="btn btn--secondary" href="#/">
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
      )}
      {publicKey ? <LeftoverNotes /> : null}
    </main>
  );
}
