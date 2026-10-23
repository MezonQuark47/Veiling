import type { Auction } from "../lib/chain";
import { formatPrice, phaseOf } from "../lib/chain";
import { formatCount, formatDuration, formatSol, shortAddress } from "../lib/format";
import { type AssetInfo, goodsAmount, useAssetInfo } from "./ui";

export function statusText(a: Auction, now: number, asset: AssetInfo): string {
  const clearing = formatPrice(a, a.clearingPrice, asset.decimals);
  switch (phaseOf(a, now)) {
    case "upcoming":
      return `Starts in ${formatDuration(a.startTime - now)}`;
    case "bidding":
      return `Ends in ${formatDuration(a.endTime - now)}`;
    case "no-bids":
      return "Ended with no bids";
    case "checking":
      return `Checking bids, ${a.checkedCount} of ${a.bidCount}`;
    case "ready-to-clear":
      return "Ready to reveal the price";
    case "stalled":
      return "Stalled, refunds are open";
    case "settling":
      return `Settling at ${clearing}`;
    case "settled":
      return `Settled at ${clearing}`;
    case "finished":
      return a.bidCount > 0 && a.sold > 0n ? `Sold at ${clearing}` : "Closed";
    case "cancelled":
      return "Cancelled";
  }
}

/** "1,000,000 TULIP" or "333 NFTs". */
export function supplyDescription(a: Auction, asset: AssetInfo): string {
  return goodsAmount(a.supply, asset);
}

function Row({ auction, now }: { auction: Auction; now: number }) {
  const asset = useAssetInfo(auction);
  const phase = phaseOf(auction, now);
  const live = phase === "bidding";
  const named = auction.kind === "collection" ? asset.collection !== null : Boolean(asset.token?.symbol || asset.token?.name);
  return (
    <tr className={live ? "row--live" : undefined}>
      <td>
        <a className="row__token" href={`#/auction/${auction.address.toBase58()}`}>
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
        {auction.launch ? <span className="tag">Fair launch</span> : null}
        {auction.hidden ? <span className="tag">Hidden</span> : null}
      </td>
      <td className="num">{supplyDescription(auction, asset)}</td>
      <td className="num">
        {formatPrice(auction, auction.minPrice, asset.decimals)}
        <span className="row__unit"> per {asset.unit}</span>
      </td>
      <td className="num">
        {formatCount(auction.bidCount)}
        <span className="row__unit"> {auction.bidCount === 1 ? "bid" : "bids"}</span>
      </td>
      <td className="num">
        {formatSol(auction.totalDeposited, 2)} SOL
        <span className="row__unit"> deposited</span>
      </td>
      <td className={`status status--${phase}`}>{statusText(auction, now, asset)}</td>
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
