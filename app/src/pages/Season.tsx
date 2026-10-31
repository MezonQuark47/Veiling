import { type CSSProperties, useEffect, useRef } from "react";
import { Avatar } from "../components/Account";
import { InviteCard } from "../components/Invite";
import { Notice, useLoader, useNow } from "../components/ui";
import { EXPLORER_CLUSTER, NETWORK_LABEL, PROJECT_X_URL, SEASON } from "../config";
import { formatCount, shortAddress } from "../lib/format";
import { type StatsSnapshot, type WalletPoints, type WalletView, fetchStats, fetchWalletView } from "../lib/stats";
import { requestConnect, useWallet } from "../lib/wallet";
import { seasonDates } from "./Stats";

/**
 * The sky behind the Season 0 title: sealed bids rise as small dim plates;
 * those that clear the dashed line (the final price) light up as winners.
 * Still when the visitor prefers less motion, and paused off screen.
 */
function SeasonSky() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let frame = 0;
    let visible = true;
    type Bid = { x: number; y: number; v: number; s: number; a: number };
    let bids: Bid[] = [];
    const spawn = (anywhere: boolean): Bid => ({
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : h + 20,
      v: 0.15 + Math.random() * 0.45,
      s: 6 + Math.random() * 10,
      a: 0.25 + Math.random() * 0.5,
    });
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(90, Math.max(30, w / 16)));
      bids = Array.from({ length: count }, () => spawn(true));
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const line = h * 0.3;
      ctx.setLineDash([6, 8]);
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, line);
      ctx.lineTo(w, line);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const b of bids) {
        const won = b.y < line;
        ctx.globalAlpha = won ? Math.min(1, b.a + 0.35) : b.a * 0.7;
        ctx.fillStyle = won ? (b.s > 12 ? "#6ee7b7" : "#b4bfff") : "#3a3f5c";
        if (won) {
          ctx.shadowColor = b.s > 12 ? "rgba(110,231,183,0.8)" : "rgba(138,155,255,0.8)";
          ctx.shadowBlur = 14;
        }
        const r = Math.min(3, b.s / 4);
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(b.x, b.y, b.s, b.s * 0.62, r);
          ctx.fill();
        } else {
          ctx.fillRect(b.x, b.y, b.s, b.s * 0.62);
        }
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    };
    const step = () => {
      if (visible) {
        for (const b of bids) {
          b.y -= b.v;
          if (b.y < -20) Object.assign(b, spawn(false));
        }
        draw();
      }
      frame = requestAnimationFrame(step);
    };
    resize();
    draw();
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);
    window.addEventListener("resize", resize);
    if (!still) frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      io.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);
  return <canvas className="s0-sky" ref={ref} aria-hidden="true" />;
}

function Countdown({ to, now }: { to: number; now: number }) {
  const left = Math.max(0, to - now);
  const parts: [number, string][] = [
    [Math.floor(left / 86_400), "days"],
    [Math.floor((left % 86_400) / 3_600), "hours"],
    [Math.floor((left % 3_600) / 60), "minutes"],
    [left % 60, "seconds"],
  ];
  return (
    <div className="s0-count" role="timer" aria-label={`${parts[0][0]} days ${parts[1][0]} hours ${parts[2][0]} minutes left`}>
      {parts.map(([value, label]) => (
        <div key={label} className="s0-count__cell">
          <span className="s0-count__num">{String(value).padStart(2, "0")}</span>
          <span className="s0-count__label">{label}</span>
        </div>
      ))}
    </div>
  );
}

interface Quest {
  title: string;
  reward: string;
  text: string;
  href: string;
  cta: string;
  done: (v: WalletView | null) => boolean;
}

const QUESTS = (p: StatsSnapshot["points"] | undefined): Quest[] => [
  {
    title: "Place a sealed bid",
    reward: `+${p?.perBid ?? 5} per bid`,
    text: `Up to ${p?.bidsPerSale ?? 3} bids in each sale count. Nobody sees your price.`,
    href: "#/auctions",
    cta: "Find a sale",
    done: (v) => (v?.totals.bids ?? 0) > 0,
  },
  {
    title: "Win in a sale",
    reward: `+${p?.perSolBought ?? 100} per SOL`,
    text: "For every SOL you pay at the final price for what you win.",
    href: "#/auctions",
    cta: "Bid to win",
    done: (v) => (v?.totals.salesWon ?? 0) > 0,
  },
  {
    title: "Launch your own sale",
    reward: `+${p?.perSolRaised ?? 50} per SOL`,
    text: "For every SOL your sale raises. A test token takes a few minutes to set up.",
    href: "#/launch",
    cta: "Launch a sale",
    done: (v) => (v?.totals.salesLaunched ?? 0) > 0,
  },
  {
    title: "Help finish a sale",
    reward: `+${p?.perStep ?? 5} per step`,
    text: "Press Finish the sale on an ended sale to run its last steps yourself.",
    href: "#/auctions",
    cta: "See ended sales",
    done: (v) => (v?.totals.steps ?? 0) > 0,
  },
  {
    title: "Invite a friend",
    reward: `+${p?.perInvite ?? 25} each`,
    text: `When they win in a sale, plus ${Math.round((p?.inviteShare ?? 0.1) * 100)}% of the buying points they earn.`,
    href: "#invite",
    cta: "Get your link",
    done: (v) => (v?.invites?.joined ?? 0) > 0,
  },
  {
    title: "Put your X name on your link",
    reward: "Your link, your name",
    text: "Link your X account once and your invite link ends in your username.",
    href: "#invite",
    cta: "Link my X",
    done: (v) => Boolean(v?.handle),
  },
];

/** Scrolls to the invite card; a plain #invite link would change the page, since pages live in the hash. */
const toInvite = () => document.getElementById("invite")?.scrollIntoView({ behavior: "smooth", block: "start" });

const explorer = (wallet: string) => `https://explorer.solana.com/address/${wallet}${EXPLORER_CLUSTER}`;

function Podium({ board, me }: { board: WalletPoints[]; me: string | null }) {
  const top = board.slice(0, 3);
  const rest = board.slice(3, 10);
  if (top.length === 0) {
    return (
      <div className="s0-empty">
        <p>The board is empty. The first points of {SEASON?.name} put you on top.</p>
        <a className="btn btn--primary" href="#/auctions">
          Be first
        </a>
      </div>
    );
  }
  // Second, first, third: the winner stands in the middle.
  const order = [top[1], top[0], top[2]].filter(Boolean) as WalletPoints[];
  return (
    <>
      <ol className="s0-podium">
        {order.map((w) => {
          const place = board.indexOf(w) + 1;
          return (
            <li key={w.wallet} className={`s0-podium__step s0-podium__step--${place}${w.wallet === me ? " is-me" : ""}`}>
              <span className="s0-podium__medal">{place}</span>
              <Avatar address={w.wallet} size={place === 1 ? 64 : 52} />
              <a className="s0-podium__name" href={explorer(w.wallet)} target="_blank" rel="noreferrer noopener">
                {w.wallet === me ? "You" : shortAddress(w.wallet)}
              </a>
              <span className="s0-podium__points">{formatCount(w.points)}</span>
              <span className="s0-podium__unit">points</span>
              <span className="s0-podium__block" aria-hidden="true" />
            </li>
          );
        })}
      </ol>
      {rest.length > 0 ? (
        <ol className="s0-ranks" start={4}>
          {rest.map((w, i) => (
            <li key={w.wallet} className={w.wallet === me ? "is-me" : undefined}>
              <span className="s0-ranks__place">{i + 4}</span>
              <Avatar address={w.wallet} size={28} />
              <a href={explorer(w.wallet)} target="_blank" rel="noreferrer noopener">
                {w.wallet === me ? "You" : shortAddress(w.wallet)}
              </a>
              <span className="s0-ranks__points">{formatCount(w.points)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </>
  );
}

export function Season() {
  const now = useNow(1000);
  const { publicKey } = useWallet();
  const stats = useLoader(fetchStats, [], 60_000);
  const wallet = publicKey?.toBase58() ?? null;
  const mine = useLoader(() => (wallet ? fetchWalletView(wallet).catch(() => null) : Promise.resolve(null)), [wallet], 60_000);

  if (!SEASON) {
    return (
      <main className="page">
        <h1 className="page__title">Seasons</h1>
        <Notice tone="info">There is no season running right now. Points still count on the <a href="#/stats">Stats</a> page.</Notice>
      </main>
    );
  }
  const live = now >= SEASON.start && now < SEASON.end;
  const over = now >= SEASON.end;
  const season = stats.data?.season ?? null;
  const p = stats.data?.points;
  const view = mine.data ?? null;
  const myPoints = wallet ? view?.season?.points ?? season?.wallets[wallet] ?? 0 : null;
  const myRank = view?.season?.rank ?? null;
  const totalPoints = season ? Object.values(season.wallets).reduce((n, v) => n + v, 0) : null;
  // The next score above this wallet's, to say how far the next place is.
  const above = season && myPoints !== null ? Object.values(season.wallets).filter((v) => v > myPoints).sort((a, b) => a - b)[0] : undefined;
  const quests = QUESTS(p);
  const done = quests.filter((q) => q.done(view)).length;

  return (
    <main className="s0">
      <section className="s0-hero">
        <SeasonSky />
        <div className="s0-hero__inner">
          <span className="s0-tag">
            <span className="nav__live" aria-hidden="true" />
            {over ? "Season over" : live ? "Live now" : "Starts soon"} · {NETWORK_LABEL || "Solana"} test campaign
          </span>
          <h1 className="s0-title">
            <span className="s0-title__word">Season</span>
            <span className="s0-title__zero">0</span>
          </h1>
          <p className="s0-lede">
            Test Veiling before it goes live. Bid, launch and invite friends with free test SOL, and climb the board.
          </p>
          {over ? (
            <p className="s0-ended">Thanks for playing. The final board is below.</p>
          ) : (
            <>
              <span className="s0-count__title">{live ? "Ends in" : "Starts in"}</span>
              <Countdown to={live ? SEASON.end : SEASON.start} now={now} />
            </>
          )}
          <div className="s0-cta">
            <a className="btn btn--primary btn--large" href="#/auctions">
              Start earning
            </a>
            {wallet ? (
              <button type="button" className="btn btn--secondary btn--large" onClick={toInvite}>
                Get your invite link
              </button>
            ) : (
              <button type="button" className="btn btn--secondary btn--large" onClick={requestConnect}>
                Connect wallet
              </button>
            )}
          </div>
          <span className="s0-dates">{seasonDates(SEASON)}</span>
        </div>
      </section>

      <div className="s0-body">
        <section className="s0-ribbon" aria-label="Season numbers">
          <div>
            <span>Players</span>
            <b>{season ? formatCount(season.players) : "…"}</b>
          </div>
          <div>
            <span>Points earned</span>
            <b>{totalPoints === null ? "…" : formatCount(totalPoints)}</b>
          </div>
          <div className="s0-ribbon__me">
            <span>Your points</span>
            <b>{myPoints === null ? "—" : formatCount(myPoints)}</b>
          </div>
          <div className="s0-ribbon__me">
            <span>Your place</span>
            <b>
              {myRank ? `#${formatCount(myRank)}` : "—"}
              {above !== undefined && myPoints !== null && myRank ? (
                <em>
                  {formatCount(above - myPoints)} {above - myPoints === 1 ? "point" : "points"} to #{formatCount(myRank - 1)}
                </em>
              ) : null}
            </b>
          </div>
        </section>

        <section className="s0-section" aria-labelledby="s0-quests">
          <div className="s0-section__head">
            <h2 id="s0-quests">Quests</h2>
            {wallet ? (
              <span className="s0-progress" aria-label={`${done} of ${quests.length} quests done`}>
                <span className="s0-progress__bar">
                  <span style={{ width: `${(done / quests.length) * 100}%` }} />
                </span>
                {done} of {quests.length} done
              </span>
            ) : null}
          </div>
          <ul className="s0-quests">
            {quests.map((q, i) => {
              const ok = q.done(view);
              return (
                <li key={q.title} className={`s0-quest${ok ? " is-done" : ""}`} data-reveal style={{ "--i": i } as CSSProperties}>
                  <span className="s0-quest__reward">{ok ? "Done" : q.reward}</span>
                  <h3>{q.title}</h3>
                  <p>{q.text}</p>
                  {q.href === "#invite" ? (
                    <button type="button" className="s0-quest__go" onClick={toInvite}>
                      {q.cta} →
                    </button>
                  ) : (
                    <a className="s0-quest__go" href={q.href}>
                      {q.cta} →
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="s0-section" aria-labelledby="s0-board">
          <div className="s0-section__head">
            <h2 id="s0-board">Leaderboard</h2>
            <a className="s0-section__link" href="#/stats">
              Full board and all-time points →
            </a>
          </div>
          {season ? (
            <Podium board={season.leaderboard} me={wallet} />
          ) : stats.loading ? (
            <p className="muted">Loading…</p>
          ) : (
            <p className="muted">The leaderboard is not available right now.</p>
          )}
        </section>

        <section className="s0-section" id="invite" aria-label="Your invite link">
          {wallet ? (
            <InviteCard wallet={wallet} view={view} onChanged={mine.reload} />
          ) : (
            <div className="s0-empty">
              <p>Connect your wallet to see your points, your quests and your invite link.</p>
              <button type="button" className="btn btn--primary" onClick={requestConnect}>
                Connect wallet
              </button>
            </div>
          )}
        </section>

        <section className="s0-section s0-start" aria-labelledby="s0-start">
          <h2 id="s0-start">New to devnet?</h2>
          <ol>
            <li>
              <strong>Switch your wallet to Devnet.</strong> In Phantom: Settings, Developer settings, Testnet mode. In
              Solflare: Network, Devnet.
            </li>
            <li>
              <strong>Take free test SOL</strong> from the{" "}
              <a href="https://faucet.solana.com" target="_blank" rel="noreferrer noopener">
                Solana faucet
              </a>
              . It has no value, so nothing is at risk.
            </li>
            <li>
              <strong>Come back and bid.</strong> Every quest above counts from {seasonDates(SEASON)}.
            </li>
          </ol>
        </section>

        <p className="s0-fine">
          Points are a record of who helped test Veiling: they are not a token, have no cash value and promise no reward.
          Farming them with many wallets breaks the <a href="#/terms">terms</a>, and those points are removed.
          {PROJECT_X_URL ? (
            <>
              {" "}
              Found a bug or have an idea? Tell us on{" "}
              <a href={PROJECT_X_URL} target="_blank" rel="noreferrer noopener">
                X
              </a>
              .
            </>
          ) : null}
        </p>
      </div>
    </main>
  );
}
