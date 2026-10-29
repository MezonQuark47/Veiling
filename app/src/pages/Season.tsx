import type { CSSProperties } from "react";
import { InviteCard } from "../components/Invite";
import { Notice, useLoader, useNow } from "../components/ui";
import { NETWORK_LABEL, PROJECT_X_URL, SEASON } from "../config";
import { formatCount, formatDuration } from "../lib/format";
import { fetchStats, fetchWalletView } from "../lib/stats";
import { requestConnect, useWallet } from "../lib/wallet";
import { Leaderboard, seasonDates } from "./Stats";

const STEPS: { title: string; text: string; href: string; cta: string; external?: boolean }[] = [
  {
    title: "Get free test SOL",
    text: "Switch your wallet to Devnet (in Phantom: Settings, Developer settings, Testnet mode; in Solflare: Network, Devnet), then take free SOL from the faucet. It has no value, so nothing is at risk.",
    href: "https://faucet.solana.com",
    cta: "Open the faucet",
    external: true,
  },
  {
    title: "Bid in a sale",
    text: "Name the highest price you would pay. Nobody sees it. When bidding ends, every winner pays the same final price.",
    href: "#/auctions",
    cta: "See sales",
  },
  {
    title: "Launch your own",
    text: "Open a test sale for a new token or an NFT collection in a few minutes, and see how buyers bid on it.",
    href: "#/launch",
    cta: "Launch a sale",
  },
  {
    title: "Invite friends",
    text: "Share your invite link. You earn points when the people you invite win in a sale.",
    href: "#/bids",
    cta: "Get your link",
  },
];

export function Season() {
  const now = useNow();
  const { publicKey } = useWallet();
  const stats = useLoader(fetchStats, [], 60_000);
  const wallet = publicKey?.toBase58() ?? null;
  const mine = useLoader(() => (wallet ? fetchWalletView(wallet).catch(() => null) : Promise.resolve(null)), [wallet]);

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
  const myPoints = mine.data?.season?.points ?? (wallet && season ? season.wallets[wallet] ?? 0 : null);
  const myRank = mine.data?.season?.rank ?? null;

  return (
    <main className="page season">
      <section className="season-hero" data-reveal>
        <span className="season-hero__tag">
          <span className="season-bar__dot" aria-hidden="true" />
          {over ? "Ended" : live ? "Live now" : "Starts soon"} · {NETWORK_LABEL || "Solana"}
        </span>
        <h1 className="season-hero__title">
          {SEASON.name}: <em>test Veiling, earn points.</em>
        </h1>
        <p className="season-hero__lede">
          Veiling is running on Solana's test network before it goes live. Bid, launch and invite friends with free test
          SOL, help us find what to fix, and climb the {SEASON.name} leaderboard.
        </p>
        <dl className="season-hero__facts">
          <div>
            <dt>Runs</dt>
            <dd>{seasonDates(SEASON)}</dd>
          </div>
          <div>
            <dt>{over ? "Ended" : live ? "Ends in" : "Starts in"}</dt>
            <dd>{over ? "Thanks for playing" : formatDuration(Math.max(0, (live ? SEASON.end : SEASON.start) - now))}</dd>
          </div>
          <div>
            <dt>Players</dt>
            <dd>{season ? formatCount(season.players) : "…"}</dd>
          </div>
          <div>
            <dt>Your points</dt>
            <dd>
              {wallet ? (
                <>
                  {myPoints === null ? "…" : formatCount(myPoints)}
                  {myRank ? <span className="muted"> · #{formatCount(myRank)}</span> : null}
                </>
              ) : (
                <button type="button" className="linkish" onClick={requestConnect}>
                  Connect wallet
                </button>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="section" aria-labelledby="season-how">
        <div className="section__head">
          <h2 id="season-how" className="section__title">
            How to take part
          </h2>
        </div>
        <ol className="season-steps">
          {STEPS.map((step, i) => (
            <li key={step.title} className="season-step" data-reveal style={{ "--i": i } as CSSProperties}>
              <span className="season-step__num">{i + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
              <a
                className="btn btn--secondary"
                href={step.href}
                {...(step.external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
              >
                {step.cta}
              </a>
            </li>
          ))}
        </ol>
      </section>

      {wallet ? (
        <section className="section" aria-label="Your invite link">
          <InviteCard wallet={wallet} view={mine.data ?? null} />
        </section>
      ) : null}

      <section className="section" aria-labelledby="season-points">
        <div className="section__head">
          <h2 id="season-points" className="section__title">
            Points
          </h2>
        </div>
        <div className="points-layout">
          <div className="points-rules">
            <h3>What earns points</h3>
            {p ? (
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
                  <strong>{p.perStep} points</strong> for each finishing step you run.
                </li>
                {p.perInvite ? (
                  <li>
                    <strong>{p.perInvite} points</strong> for each friend you invite who wins in a sale, plus{" "}
                    {Math.round((p.inviteShare ?? 0) * 100)}% of the buying points they earn.
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="muted">Loading…</p>
            )}
            <p className="muted">
              Only what happens from {seasonDates(SEASON)} counts for {SEASON.name}. Points are a record of who helped
              test Veiling: they are not a token, have no cash value and promise no reward. Farming them with many
              wallets breaks the <a href="#/terms">terms</a>, and those points are removed.
            </p>
            {PROJECT_X_URL ? (
              <p className="muted">
                Found a bug or have an idea? Tell us on{" "}
                <a href={PROJECT_X_URL} target="_blank" rel="noreferrer noopener">
                  X
                </a>
                .
              </p>
            ) : null}
          </div>
          <div>
            <h3 className="points-board__title">{SEASON.name} leaderboard</h3>
            {season ? (
              <Leaderboard board={season.leaderboard} size={10} />
            ) : stats.loading ? (
              <p className="muted">Loading…</p>
            ) : (
              <p className="muted">The leaderboard is not available right now.</p>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
