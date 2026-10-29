import { type CSSProperties, useMemo, useRef, useState } from "react";
import { Notice, useLoader } from "../components/ui";
import { EXPLORER_CLUSTER } from "../config";
import { formatCount, shortAddress } from "../lib/format";
import { type StatsSnapshot, type WalletPoints, fetchStats, rankOf } from "../lib/stats";
import { requestConnect, useWallet } from "../lib/wallet";

const sol = (value: number) =>
  `${value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 0 : value >= 1 ? 2 : 4 })} SOL`;

function ago(unixSecs: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (secs < 90) return "a minute ago";
  if (secs < 3600) return `${Math.round(secs / 60)} minutes ago`;
  if (secs < 86_400 * 2) return `${Math.round(secs / 3600)} hours ago`;
  return `${Math.round(secs / 86_400)} days ago`;
}

const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Round axis steps: 1, 2 or 5 times a power of ten. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * power >= value) return k * power;
  return 10 * power;
}

/**
 * One measure over time: a line (a running total) or bars (a count per day).
 * Hover or touch shows the day and its value.
 */
function TimeChart({
  title,
  points,
  kind,
  format,
}: {
  title: string;
  points: { day: string; value: number }[];
  kind: "line" | "bar";
  format: (value: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 640;
  const H = 220;
  const L = 44;
  const R = 12;
  const T = 12;
  const B = 28;
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const n = points.length;
  const slot = (W - L - R) / Math.max(1, n);
  const x = (i: number) => L + slot * i + slot / 2;
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const labels = n > 0 ? [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i) : [];

  const pick = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const box = svg.getBoundingClientRect();
    const at = ((clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.floor((at - L) / slot))));
  };

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = n > 0 ? `${line} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : "";
  const shown = hover !== null ? points[hover] : points[n - 1];

  return (
    <figure className="tchart">
      <figcaption className="tchart__head">
        <span className="tchart__title">{title}</span>
        {shown ? (
          <span className="tchart__now">
            <strong>{format(shown.value)}</strong> <span className="muted">{shortDay(shown.day)}</span>
          </span>
        ) : null}
      </figcaption>
      {n === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <svg
          ref={svgRef}
          className="tchart__svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${title}: ${format(points[n - 1].value)} on ${shortDay(points[n - 1].day)}`}
          onPointerMove={(e) => pick(e.clientX)}
          onPointerDown={(e) => pick(e.clientX)}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="tchart__grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
              <text className="tchart__tick" x={L - 8} y={y(t) + 4} textAnchor="end">
                {t >= 1000 ? `${t / 1000}k` : t}
              </text>
            </g>
          ))}
          {labels.map((i) => (
            <text key={i} className="tchart__tick" x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
              {shortDay(points[i].day)}
            </text>
          ))}
          {kind === "line" ? (
            <>
              <path className="tchart__area" d={area} />
              <path className="tchart__line" d={line} />
            </>
          ) : (
            points.map((p, i) => {
              const top = y(p.value);
              const w = Math.max(2, slot - 2);
              const h = y(0) - top;
              return (
                <path
                  key={p.day}
                  className={`tchart__bar${hover === i ? " is-on" : ""}`}
                  d={
                    h > 4
                      ? `M${x(i) - w / 2},${y(0)} V${top + 2} q0,-2 2,-2 H${x(i) + w / 2 - 2} q2,0 2,2 V${y(0)} Z`
                      : `M${x(i) - w / 2},${y(0)} V${top} H${x(i) + w / 2} V${y(0)} Z`
                  }
                />
              );
            })
          )}
          {hover !== null ? (
            <>
              <line className="tchart__cross" x1={x(hover)} x2={x(hover)} y1={T} y2={y(0)} />
              {kind === "line" ? <circle className="tchart__dot" cx={x(hover)} cy={y(points[hover].value)} r={5} /> : null}
            </>
          ) : null}
        </svg>
      )}
    </figure>
  );
}

function YourPoints({ stats }: { stats: StatsSnapshot }) {
  const { publicKey } = useWallet();
  if (!publicKey) {
    return (
      <div className="mypoints mypoints--empty">
        <p>Connect your wallet to see your points and your place on the board.</p>
        <button className="btn btn--primary" onClick={requestConnect}>
          Connect wallet
        </button>
      </div>
    );
  }
  const wallet = publicKey.toBase58();
  const mine = stats.wallets[wallet];
  const rank = rankOf(stats, wallet);
  if (!mine) {
    return (
      <div className="mypoints mypoints--empty">
        <p>
          No points yet for {shortAddress(wallet)}. Win a sale, launch one that sells, bid, or help finish a sale to
          earn some.
        </p>
        <a className="btn btn--secondary" href="#/auctions">
          See live sales
        </a>
      </div>
    );
  }
  const [points, bought, raised, bids, steps] = mine;
  const p = stats.points;
  return (
    <div className="mypoints">
      <div className="mypoints__head">
        <span className="mypoints__label">Your points</span>
        <span className="mypoints__value">{formatCount(points)}</span>
        {rank ? <span className="mypoints__rank">#{formatCount(rank)} of {formatCount(Object.keys(stats.wallets).length)}</span> : null}
      </div>
      <dl className="mypoints__parts">
        <div>
          <dt>Bought</dt>
          <dd>
            {sol(bought)} <span className="muted">→ {formatCount(Math.round(bought * p.perSolBought))}</span>
          </dd>
        </div>
        <div>
          <dt>Your sales raised</dt>
          <dd>
            {sol(raised)} <span className="muted">→ {formatCount(Math.round(raised * p.perSolRaised))}</span>
          </dd>
        </div>
        <div>
          <dt>Bids</dt>
          <dd>{formatCount(bids)}</dd>
        </div>
        <div>
          <dt>Steps you ran</dt>
          <dd>
            {formatCount(steps)} <span className="muted">→ {formatCount(steps * p.perStep)}</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function Leaderboard({ board, size = 25 }: { board: WalletPoints[]; size?: number }) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const [all, setAll] = useState(false);
  const rows = all ? board : board.slice(0, size);
  if (rows.length === 0) return <p className="muted">No points yet. The first sale's buyers will lead here.</p>;
  return (
    <>
      <div className="table-wrap">
        <table className="board-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Wallet</th>
              <th scope="col" className="num">
                Points
              </th>
              <th scope="col" className="num board-table__more">
                Bought
              </th>
              <th scope="col" className="num board-table__more">
                Raised
              </th>
              <th scope="col" className="num board-table__more">
                Bids
              </th>
              <th scope="col" className="num board-table__more">
                Steps
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w, i) => (
              <tr key={w.wallet} className={w.wallet === me ? "is-me" : undefined}>
                <td className={`board-table__rank${i < 3 ? " board-table__rank--top" : ""}`}>{i + 1}</td>
                <td>
                  <a
                    className="address"
                    href={`https://explorer.solana.com/address/${w.wallet}${EXPLORER_CLUSTER}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={w.wallet}
                  >
                    {shortAddress(w.wallet)}
                  </a>
                  {w.wallet === me ? <span className="tag tag--featured">You</span> : null}
                </td>
                <td className="num board-table__points">{formatCount(w.points)}</td>
                <td className="num board-table__more">{w.boughtSol > 0 ? sol(w.boughtSol) : "—"}</td>
                <td className="num board-table__more">{w.raisedSol > 0 ? sol(w.raisedSol) : "—"}</td>
                <td className="num board-table__more">{formatCount(w.bids)}</td>
                <td className="num board-table__more">{formatCount(w.steps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {board.length > size ? (
        <button className="btn btn--secondary" onClick={() => setAll((v) => !v)}>
          {all ? `Show the top ${size}` : `Show the top ${board.length}`}
        </button>
      ) : null}
    </>
  );
}

/** "Oct 30 to Dec 14, 2026": a season's days, its end being the day before it closes. */
export function seasonDates(season: { start: number; end: number }): string {
  const day = (secs: number, year: boolean) =>
    new Date(secs * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
  return `${day(season.start, false)} to ${day(season.end - 1, true)}`;
}

export function Stats() {
  const loaded = useLoader(fetchStats, [], 60_000);
  const [seasonBoard, setSeasonBoard] = useState(true);
  const stats = loaded.data ?? null;
  const users = useMemo(() => (stats ? stats.days.map((d) => ({ day: d.day, value: d.users })) : []), [stats]);
  const volume = useMemo(() => (stats ? stats.days.map((d) => ({ day: d.day, value: d.volumeSol })) : []), [stats]);

  if (loaded.loading && !stats) {
    return (
      <main className="page" aria-label="Loading stats" role="status">
        <span className="skeleton skeleton--title" />
        <span className="skeleton skeleton--card" />
      </main>
    );
  }
  if (!stats) {
    return (
      <main className="page">
        <h1 className="page__title">Stats</h1>
        <Notice tone="info">{loaded.error ?? "Stats are not available yet. Check back soon."}</Notice>
      </main>
    );
  }
  const t = stats.totals;
  const p = stats.points;
  const cards: [string, string, string | null][] = [
    [formatCount(t.users), "Users", `${formatCount(t.bidders)} bidders, ${formatCount(t.sellers)} sellers`],
    [formatCount(t.sales), "Sales", `${formatCount(t.newTokens)} new tokens, ${formatCount(t.collections)} NFT collections`],
    [formatCount(t.tokensMade), "Tokens made", "New tokens whose sale sold out"],
    [formatCount(t.bids), "Bids placed", null],
    [sol(t.volumeSol), "SOL bought", "Paid by winners at final prices"],
    [formatCount(t.stepsRun), "Finishing steps run", "By Veiling's bot and by users"],
  ];

  return (
    <main className="page stats-page">
      <h1 className="page__title">Stats</h1>
      <p className="page__lede">
        Everything that has happened on Veiling since its first sale, and who earned the most points. Updated{" "}
        {ago(stats.updatedAt)}.
      </p>

      <section className="totals" aria-label="All-time totals">
        {cards.map(([value, label, note], i) => (
          <div key={label} className="total" data-reveal style={{ "--i": i } as CSSProperties}>
            <span className="total__value">{value}</span>
            <span className="total__label">{label}</span>
            {note ? <span className="total__note">{note}</span> : null}
          </div>
        ))}
      </section>

      <section className="section charts" aria-label="Over time">
        <div className="charts__grid">
          <TimeChart title="Users, all time" points={users} kind="line" format={(v) => `${formatCount(v)} users`} />
          <TimeChart title="SOL bought per day" points={volume} kind="bar" format={sol} />
        </div>
      </section>

      <section className="section" aria-labelledby="points-title">
        <div className="section__head">
          <h2 id="points-title" className="section__title">
            Points
          </h2>
        </div>
        <div className="points-layout">
          <div>
            <YourPoints stats={stats} />
            <div className="points-rules">
              <h3>How points work</h3>
              <ul>
                <li>
                  <strong>{p.perSolBought} points</strong> for every SOL you pay for what you win.
                </li>
                <li>
                  <strong>{p.perSolRaised} points</strong> for every SOL your sales raise.
                </li>
                <li>
                  <strong>{p.perBid} points</strong> per bid, up to {p.bidsPerSale} bids in each sale.
                </li>
                <li>
                  <strong>{p.perStep} points</strong> for each finishing step you run, for example with{" "}
                  <em>Finish the sale</em>.
                </li>
                {p.perInvite ? (
                  <li>
                    <strong>{p.perInvite} points</strong> for each friend you invite who wins in a sale, plus{" "}
                    {Math.round((p.inviteShare ?? 0) * 100)}% of the buying points they earn. Your invite link is on your{" "}
                    <a href="#/bids">dashboard</a>.
                  </li>
                ) : null}
              </ul>
              <p className="muted">
                Points have no cash value, and the rules may change. <a href="#/terms">Terms</a>
              </p>
            </div>
          </div>
          <div>
            {stats.season ? (
              <div className="segmented points-board__switch" role="group" aria-label="Leaderboard">
                {(
                  [
                    [true, stats.season.name],
                    [false, "All time"],
                  ] as const
                ).map(([s, label]) => (
                  <button
                    key={label}
                    type="button"
                    className={`segmented__item${seasonBoard === s ? " segmented__item--on" : ""}`}
                    aria-pressed={seasonBoard === s}
                    onClick={() => setSeasonBoard(s)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <h3 className="points-board__title">Leaderboard</h3>
            )}
            <Leaderboard board={stats.season && seasonBoard ? stats.season.leaderboard : stats.leaderboard} />
            {stats.season && seasonBoard ? (
              <p className="muted">
                Points earned from {seasonDates(stats.season)}. <a href="#/season">About {stats.season.name}</a>
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}
