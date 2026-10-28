import type { MouseEvent } from "react";
import type { Auction } from "../lib/chain";
import { formatPrice, phaseOf, saleFailed, supplyShare } from "../lib/chain";
import { formatCount, formatDuration, formatSol, shortAddress } from "../lib/format";
import { type AssetInfo, goodsAmount, useAssetInfo } from "./ui";

export function statusText(a: Auction, now: number, asset: AssetInfo): string {
  const clearing = `${formatPrice(a, a.clearingPrice, asset.decimals)}${a.launch ? " FDV" : ""}`;
  const phase = phaseOf(a, now);
  // A sale that did not reach its target refunds every bid instead of settling.
  if (saleFailed(a) && (phase === "settling" || phase === "settled")) {
    return phase === "settled" ? "Target not reached, bids refunded" : "Target not reached, refunding bids";
  }
  // A new token that sold out is made, then its pool opens.
  if (a.launch && phase === "settled" && a.liquidity === "planned") return `Sold out at ${clearing}, opening the pool`;
  switch (phase) {
    case "upcoming":
      return `Starts in ${formatDuration(a.startTime - now)}`;
    case "bidding":
      return `Ends in ${formatDuration(a.endTime - now)}`;
    case "no-bids":
      return "Ended with no bids";
    case "checking":
      return `Checking bids, ${a.checkedCount} of ${a.bidCount}`;
    case "ready-to-clear":
      return "Finding the price";
    case "stalled":
      return "Stuck: deposits can be taken back";
    case "settling":
      return `Sold at ${clearing}, finishing up`;
    case "settled":
      return `Sold at ${clearing}`;
    case "finished":
      return a.bidCount > 0 && a.sold > 0n ? `Sold at ${clearing}` : "Closed";
    case "cancelled":
      return "Cancelled";
  }
}

/** "1,000,000 TULIP" or "333 NFTs". */
export function supplyDescription(a: Auction, asset: AssetInfo): string {
  // A new token's sale is half its supply, which says more than a count.
  if (a.launch) return `${supplyShare(a.supply)} of the ${asset.goods} supply`;
  return goodsAmount(a.supply, asset);
}

/**
 * A click anywhere on a row or card opens `href`. The name inside stays a real
 * link, for the keyboard, screen readers and "open in new tab"; clicks on
 * links and buttons inside, and text being selected, are left alone.
 */
export function openOnClick(href: string) {
  return (e: MouseEvent<HTMLElement>) => {
    if ((e.target as Element).closest("a, button, input, label, summary")) return;
    if (window.getSelection()?.toString()) return;
    if (e.metaKey || e.ctrlKey || e.button === 1) window.open(href, "_blank", "noopener");
    else window.location.hash = href;
  };
}

function Row({ auction, now }: { auction: Auction; now: number }) {
  const asset = useAssetInfo(auction);
  const phase = phaseOf(auction, now);
  const live = phase === "bidding";
  const named = auction.kind === "collection" ? asset.collection !== null : Boolean(asset.token?.symbol || asset.token?.name);
  const href = `#/auction/${auction.address.toBase58()}`;
  const open = openOnClick(href);
  return (
    <tr
      className={`row--link${live ? " row--live" : ""}`}
      onClick={open}
      onAuxClick={(e) => {
        if (e.button === 1) open(e);
      }}
    >
      <td>
        <a className="row__token" href={href}>
          <span className="row__symbol">{asset.title}</span>
          <span className="row__name">{asset.sub}</span>
          {named ? (
            <span className="row__mint" title={auction.mint.toBase58()}>
              {shortAddress(auction.mint.toBase58())}
            </span>
          ) : null}
        </a>
        {auction.featured ? <span className="tag tag--featured">Featured</span> : null}
        {auction.kind === "collection" ? <span className="tag">NFT</span> : null}
        {auction.kind === "collection" && auction.unrevealed ? <span className="tag">Art hidden</span> : null}
        {auction.launch ? <span className="tag">New token</span> : null}
        {auction.hidden ? <span className="tag">Hidden</span> : null}
      </td>
      <td className="num">{supplyDescription(auction, asset)}</td>
      <td className="num">
        {formatPrice(auction, auction.minPrice, asset.decimals)}
        {/* A new token's price is its FDV, which the column must say. */}
        {auction.launch ? <span className="row__fdv"> FDV</span> : <span className="row__unit"> per {asset.unit}</span>}
      </td>
      <td className="num">
        {formatCount(auction.bidCount)}
        <span className="row__unit"> {auction.bidCount === 1 ? "bid" : "bids"}</span>
      </td>
      <td className="num">
        {formatSol(auction.totalDeposited, 2)} SOL
        <span className="row__unit"> deposited</span>
      </td>
      <td className={`status status--${phase}`}>
        {statusText(auction, now, asset)}
        <svg className="row__go" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 10h11M11 5l5 5-5 5" />
        </svg>
      </td>
    </tr>
  );
}

export function AuctionTable({ auctions, now }: { auctions: Auction[]; now: number }) {
  return (
    <div className="table-wrap">
      <table className="auctions">
        <thead>
          <tr>
            <th scope="col">Selling</th>
            <th scope="col" className="num">For sale</th>
            <th scope="col" className="num">Minimum price</th>
            <th scope="col" className="num">Bids</th>
            <th scope="col" className="num">Deposited</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {auctions.map((a) => (
            <Row key={a.address.toBase58()} auction={a} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
