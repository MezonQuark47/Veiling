import type { CSSProperties } from "react";
import { PublicKey } from "@solana/web3.js";
import { LAUNCH_DECIMALS } from "../config";
import { fetchCollectionInfo, fetchTokenInfo } from "../lib/chain";
import { formatCount, formatSol, formatTokens, plural, shortAddress } from "../lib/format";
import type { JoinedSale, LaunchedSale, SaleRef, WalletView } from "../lib/stats";
import { useLoader } from "./ui";

const lamports = (v: string) => BigInt(v || "0");
const sol = (v: string) => `${formatSol(lamports(v))} SOL`;
const date = (unixSecs: number) =>
  new Date(unixSecs * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** A sale's name and what it sells, read from its token or collection when the history has none. */
function useSale(sale: SaleRef): { title: string; goods: string; decimals: number | null } {
  const isCollection = sale.kind === "collection";
  const loaded = useLoader(
    async () => {
      if (!sale.mint) return null;
      const mint = new PublicKey(sale.mint);
      if (isCollection) return { name: (await fetchCollectionInfo(mint))?.name ?? null, symbol: null, decimals: 0 };
      const token = await fetchTokenInfo(mint).catch(() => null);
      return token ? { name: token.name, symbol: token.symbol, decimals: token.decimals } : null;
    },
    [sale.mint]
  );
  const info = loaded.data;
  if (isCollection) {
    return { title: info?.name || `Collection ${shortAddress(sale.mint)}`, goods: "NFTs", decimals: 0 };
  }
  const symbol = info?.symbol || sale.symbol;
  return {
    title: symbol || info?.name || sale.name || `Token ${shortAddress(sale.mint)}`,
    goods: symbol || "tokens",
    decimals: info?.decimals ?? (sale.kind === "launch" ? LAUNCH_DECIMALS : null),
  };
}

const KIND: Record<string, string> = { launch: "New token", token: "Token", collection: "NFTs" };

function SaleCell({ sale, title }: { sale: SaleRef; title: string }) {
  return (
    <td>
      <a className="row__token" href={`#/auction/${sale.auction}`}>
        <span className="row__symbol">{title}</span>
        <span className="row__name">
          {KIND[sale.kind] ?? "Sale"} · {date(sale.at)}
        </span>
      </a>
    </td>
  );
}

const JOINED_RESULT: Record<JoinedSale["result"], [string, string]> = {
  won: ["Won", "tag--ok"],
  lost: ["Not won", ""],
  refunded: ["Refunded", "tag--warn"],
  cancelled: ["Cancelled", ""],
  open: ["In progress", "tag--featured"],
};

function JoinedRow({ sale }: { sale: JoinedSale }) {
  const { title, goods, decimals } = useSale(sale);
  const won = lamports(sale.won);
  const [label, tone] = JOINED_RESULT[sale.result];
  return (
    <tr>
      <SaleCell sale={sale} title={title} />
      <td className="num dash__more">{formatCount(sale.bids)}</td>
      <td className="num dash__more">{sol(sale.deposited)}</td>
      <td className="num">{lamports(sale.paid) > 0n ? sol(sale.paid) : "—"}</td>
      <td className="num">
        {won === 0n
          ? "—"
          : sale.kind === "collection"
            ? plural(Number(won), "NFT")
            : decimals === null
              ? "…"
              : `${formatTokens(won, decimals, 2)} ${goods}`}
      </td>
      <td className="num dash__more">{lamports(sale.refunded) > 0n ? sol(sale.refunded) : "—"}</td>
      <td>
        <span className={`tag ${tone}`}>{label}</span>
      </td>
    </tr>
  );
}

const LAUNCHED_RESULT: Record<LaunchedSale["result"], [string, string]> = {
  made: ["Token made", "tag--ok"],
  sold: ["Sold", "tag--ok"],
  failed: ["Target not reached", "tag--warn"],
  cancelled: ["Cancelled", ""],
  open: ["In progress", "tag--featured"],
};

function LaunchedRow({ sale }: { sale: LaunchedSale }) {
  const { title } = useSale(sale);
  const [label, tone] = LAUNCHED_RESULT[sale.result];
  return (
    <tr>
      <SaleCell sale={sale} title={title} />
      <td className="num">{formatCount(sale.bids)}</td>
      <td className="num dash__more">{formatCount(sale.bidders)}</td>
      <td className="num">{lamports(sale.raised) > 0n ? sol(sale.raised) : "—"}</td>
      <td>
        <span className={`tag ${tone}`}>{label}</span>
      </td>
    </tr>
  );
}

/** The headline numbers of a wallet's history. */
export function DashboardSummary({ view }: { view: WalletView }) {
  const t = view.totals;
  const cards: [string, string, string | null][] = [
    [formatCount(view.points), "Points", view.rank ? `#${formatCount(view.rank)} on the leaderboard` : "Earn some by taking part"],
    [sol(t.paid), "Spent", "Paid at final prices for what you won"],
    [formatCount(t.salesJoined), "Sales joined", `${formatCount(t.salesWon)} won`],
    [formatCount(t.bids), "Bids placed", `${sol(t.deposited)} deposited in all`],
    [sol(t.refunded), "Came back", "Unused deposits and refunds"],
    t.salesLaunched > 0
      ? [formatCount(t.salesLaunched), "Sales launched", `${sol(t.raised)} raised`]
      : [formatCount(t.steps), "Steps you ran", "Helping sales finish"],
  ];
  return (
    <section className="totals" aria-label="Your numbers">
      {cards.map(([value, label, note], i) => (
        <div key={label} className="total" data-reveal style={{ "--i": i } as CSSProperties}>
          <span className="total__value">{value}</span>
          <span className="total__label">{label}</span>
          {note ? <span className="total__note">{note}</span> : null}
        </div>
      ))}
    </section>
  );
}

export function JoinedSales({ sales }: { sales: JoinedSale[] }) {
  if (sales.length === 0) return <p className="muted">You have not bid in any sale yet.</p>;
  return (
    <div className="table-wrap">
      <table className="board-table dash-table">
        <thead>
          <tr>
            <th scope="col">Sale</th>
            <th scope="col" className="num dash__more">
              Bids
            </th>
            <th scope="col" className="num dash__more">
              Deposited
            </th>
            <th scope="col" className="num">
              Paid
            </th>
            <th scope="col" className="num">
              Won
            </th>
            <th scope="col" className="num dash__more">
              Came back
            </th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((s) => (
            <JoinedRow key={s.auction} sale={s} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LaunchedSales({ sales }: { sales: LaunchedSale[] }) {
  return (
    <div className="table-wrap">
      <table className="board-table dash-table">
        <thead>
          <tr>
            <th scope="col">Sale</th>
            <th scope="col" className="num">
              Bids
            </th>
            <th scope="col" className="num dash__more">
              Bidders
            </th>
            <th scope="col" className="num">
              Raised
            </th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((s) => (
            <LaunchedRow key={s.auction} sale={s} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
