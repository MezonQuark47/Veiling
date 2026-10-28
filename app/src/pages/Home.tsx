import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { BidTower, type Box, Scene } from "../components/Tower";
import { statusText } from "../components/AuctionTable";
import { Button, Notice, useAction, useAssetInfo, useLoader, useNow } from "../components/ui";
import { buildAcceptAdmin } from "../lib/actions";
import { type Auction, fetchAdminRoles, fetchAuctions, phaseOf } from "../lib/chain";
import { rank } from "./Auctions";
import { sendTransaction } from "../lib/tx";
import { fetchStats } from "../lib/stats";
import { useWallet } from "../lib/wallet";

/** A number that counts up from zero the first time it is scrolled into view. */
function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);
  const started = useRef(false);
  useEffect(() => {
    const el = ref.current;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!el || still || started.current || !("IntersectionObserver" in window)) {
      setShown(value);
      return;
    }
    setShown(0);
    let frame = 0;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      started.current = true;
      const start = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - start) / 1400);
        setShown(value * (1 - Math.pow(1 - k, 3)));
        if (k < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value]);
  return (
    <span ref={ref}>
      {shown.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
    </span>
  );
}

/**
 * Veiling in numbers: all time when the keeper's totals are there
 * (lib/stats.ts), else from the sales on chain right now.
 */
function Stats({ auctions, now }: { auctions: Auction[]; now: number }) {
  const totals = useLoader(fetchStats, []).data?.totals ?? null;
  const listed = auctions.filter((a) => !a.hidden);
  const live = listed.filter((a) => phaseOf(a, now) === "bidding").length;
  const bids = listed.reduce((sum, a) => sum + a.bidCount, 0);
  const deposited = Number(listed.reduce((sum, a) => sum + a.totalDeposited, 0n)) / 1e9;
  const items: [number, number, string][] = totals
    ? [
        [live, 0, "Live now"],
        [totals.sales, 0, "Sales so far"],
        [totals.users, 0, "Users"],
        [totals.volumeSol, totals.volumeSol < 100 ? 1 : 0, "SOL bought"],
      ]
    : [
        [live, 0, "Live now"],
        [listed.length, 0, "Sales so far"],
        [bids, 0, "Bids placed"],
        [deposited, deposited < 100 ? 1 : 0, "SOL deposited"],
      ];
  return (
    <section className="stats" aria-label="Veiling in numbers">
      {items.map(([value, decimals, label], i) => (
        <div key={label} className="stat" data-reveal style={{ "--i": i } as CSSProperties}>
          <span className="stat__value">
            <CountUp value={value} decimals={decimals} />
          </span>
          <span className="stat__label">{label}</span>
        </div>
      ))}
      {totals ? (
        <a className="stats__more" href="#/stats">
          All stats and points
        </a>
      ) : null}
    </section>
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

/** One live sale in the strip under the top bar. */
function TickerItem({ auction, now, hidden }: { auction: Auction; now: number; hidden?: boolean }) {
  const asset = useAssetInfo(auction);
  const live = phaseOf(auction, now) === "bidding";
  return (
    <a
      className="ticker__item"
      href={`#/auction/${auction.address.toBase58()}`}
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden || undefined}
    >
      <span className={`ticker__dot${live ? " ticker__dot--live" : ""}`} />
      <strong>{asset.title}</strong>
      <span className="muted">{statusText(auction, now, asset)}</span>
    </a>
  );
}

/** The sales on now, scrolling; the list is drawn twice so the loop is seamless. */
function Ticker({ auctions, now }: { auctions: Auction[]; now: number }) {
  if (auctions.length === 0) return null;
  const items = auctions.slice(0, 12);
  return (
    <div className="ticker" aria-label="Sales on now">
      <div className={`ticker__track${items.length > 2 ? " ticker__track--moving" : ""}`}>
        {items.map((a) => (
          <TickerItem key={a.address.toBase58()} auction={a} now={now} />
        ))}
        {items.length > 2
          ? items.map((a) => <TickerItem key={`again-${a.address.toBase58()}`} auction={a} now={now} hidden />)
          : null}
      </div>
    </div>
  );
}

const STACK = [70, 110, 90, 125];

function stack(fate: boolean): Box[] {
  return STACK.map((s, i) => ({
    y: i * 20 - 30 + (fate && i >= 2 ? 18 : 0),
    w: s,
    h: 12,
    d: s,
    look: fate ? (i < 2 ? "lit" : "out") : "",
  }));
}

const STEPS: { title: string; text: string; boxes: Box[] }[] = [
  {
    title: "Name your price",
    text: "For a token, set the SOL you want to spend and the most you would pay per token. For an NFT collection, choose how many NFTs and the most you would pay for each. Your deposit covers it.",
    boxes: [{ y: 0, w: 110, h: 16, d: 110 }],
  },
  {
    title: "Your bid is sealed",
    text: "Your price is encrypted in your browser and tied to your bid. Arcium’s network works with the bids without anyone, including us, seeing them one by one.",
    boxes: [
      { y: 6, w: 84, h: 14, d: 84 },
      { y: 0, w: 140, h: 64, d: 140, look: "glass" },
    ],
  },
  {
    title: "One price is found",
    text: "After bidding closes, the final price is the highest price at which the bids cover the supply.",
    boxes: [...stack(false), { y: 0, w: 170, h: 1, d: 170, look: "plane" }],
  },
  {
    title: "Everyone pays the same",
    text: "Bids above it win, bids exactly at it share what is left, and every winner pays that one price. Bids below it stay sealed and are refunded in full.",
    boxes: stack(true),
  },
];

const TOKENS: Box[] = Array.from({ length: 7 }, (_, i) => ({ y: i * 13 - 40, w: 120, h: 9, d: 120, look: i < 3 ? "lit" : "" }));
const NFTS: Box[] = Array.from({ length: 9 }, (_, n) => {
  const won = [0, 4, 8].includes(n);
  return { x: ((n % 3) - 1) * 60, z: (Math.floor(n / 3) - 1) * 60, y: won ? -26 : 0, w: 44, h: 44, d: 44, look: won ? "lit" : "" };
});
const POOL: Box[] = [
  { x: -46, y: 0, w: 76, h: 76, d: 76, look: "lit" },
  { x: 46, y: 0, w: 76, h: 76, d: 76 },
  { y: -39, w: 230, h: 1, d: 170, look: "plane" },
];

export function Home() {
  const now = useNow();
  const { publicKey } = useWallet();
  const auctions = useLoader(fetchAuctions, [], 15_000);
  const roles = useLoader(fetchAdminRoles, []);
  const [accepted, setAccepted] = useState(false);
  const offered = Boolean(publicKey && roles.data?.pendingAdmin?.equals(publicKey));

  // The ticker shows what is on now: featured sales first.
  const onNow = useMemo(
    () =>
      (auctions.data ?? [])
        .filter((a) => !a.hidden && rank(a, now) < 3)
        .sort((x, y) => (x.featured !== y.featured ? (x.featured ? -1 : 1) : rank(x, now) - rank(y, now))),
    [auctions.data, now]
  );

  return (
    <main className="page page--home">
      {offered || accepted ? (
        <AdminOffer
          accepted={accepted}
          onAccepted={() => {
            setAccepted(true);
            roles.reload();
          }}
        />
      ) : null}
      <Ticker auctions={onNow} now={now} />

      <section className="stage">
        <div className="stage__glow" aria-hidden="true" />
        <div className="stage__copy">
          <h1 className="stage__title">
            <span className="stage__line">
              <span>Veiling,</span>
            </span>
            <span className="stage__line stage__line--accent">
              <span>future of launchpads.</span>
            </span>
          </h1>
          <p className="stage__tagline">Private bids. Public price.</p>
          <p className="stage__lede">
            Veiling sells new tokens and NFT collections on Solana by sealed bid. Your price stays encrypted from
            the moment you bid. When bidding closes, one final price is found, every winner pays it, and
            whatever you did not spend comes back.
          </p>
          <div className="stage__actions">
            <a className="btn btn--primary btn--large cta cta--primary" href="#/launch">
              Launch an auction
              <svg className="cta__arrow" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 10h11M11 5.5 15.5 10 11 14.5" />
              </svg>
            </a>
            <a className="btn btn--secondary btn--large cta cta--secondary" href="#/auctions">
              <span className="cta__live" aria-hidden="true" />
              See live auctions
            </a>
          </div>
        </div>
        <BidTower />
      </section>

      {auctions.data && auctions.data.length > 0 ? <Stats auctions={auctions.data} now={now} /> : null}

      <section className="section" id="how" aria-labelledby="how-title">
        <h2 id="how-title" className="section__title section__title--wide" data-reveal>
          From your bid to your tokens
        </h2>
        <ol className="steps3d">
          {STEPS.map((s, i) => (
            <li key={s.title} className="card3d" data-reveal style={{ "--i": i } as CSSProperties}>
              <Scene boxes={s.boxes} className="scene--scroll" />
              <h3>
                <span className="card3d__n">{i + 1}</span>
                {s.title}
              </h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
        <p className="how__fine">
          A new token is made only if its sale sells out, and nobody can ever make more of it after that. An NFT
          collection's NFTs are made only for the people who win them. If anything ever gets stuck, bidders can
          take their deposits back: a day after the end for a token, three days for a collection. <a href="#/docs">Read the details</a>.
        </p>
      </section>

      <section className="section" aria-labelledby="private-title">
        <div className="section__intro" data-reveal>
          <h2 id="private-title" className="section__title section__title--wide">
            No one sees your bid. Not the seller, not other bidders, not us.
          </h2>
          <p className="page__lede">
            A deposit only sets the most a bid can spend, so big deposits do not give away real demand. Here is
            exactly what anyone can see.
          </p>
        </div>
        <div className="split">
          <div className="split__card" data-reveal style={{ "--i": 0 } as CSSProperties}>
            <h3 className="split__head">Public, for anyone</h3>
            <p>Who bid, how many bids, and each deposit</p>
            <p>The final price, and how much was bid at it</p>
            <p>What each winner won and paid</p>
          </div>
          <div className="split__card split__card--sealed" data-reveal style={{ "--i": 1 } as CSSProperties}>
            <h3 className="split__head">Hidden, from everyone</h3>
            <p>The price of every bid, winning or not</p>
            <p>The budget of every losing token bid</p>
            <p>The size of every losing collection bid</p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="sellers-title">
        <div className="section__head section__head--end" data-reveal>
          <div className="section__intro">
            <h2 id="sellers-title" className="section__title">
              For sellers
            </h2>
            <p className="page__lede">
              Open a sale in a few minutes. Its rules are fixed before the first bid, and every bidder sees
              them.
            </p>
          </div>
          <a className="btn btn--primary btn--large" href="#/launch">
            Launch an auction
          </a>
        </div>
        <div className="bento">
          <div className="card3d" data-reveal style={{ "--i": 0 } as CSSProperties}>
            <Scene boxes={TOKENS} height={230} className="scene--dots" />
            <h3>New tokens</h3>
            <p>
              50% of the supply, up to 1,024 bids, in 1, 2 or 5 hours. The token is made only if the sale sells
              out; if not, every deposit comes back in full.
            </p>
          </div>
          <div className="card3d" data-reveal style={{ "--i": 1 } as CSSProperties}>
            <Scene boxes={NFTS} height={230} className="scene--dots" />
            <h3>NFT collections</h3>
            <p>
              Up to 10,000 NFTs and 10,240 bids. NFTs are made when winners collect them, handed out at random,
              and the art can stay hidden until the sale ends.
            </p>
          </div>
          <div className="card3d" data-reveal style={{ "--i": 2 } as CSSProperties}>
            <Scene boxes={POOL} height={230} className="scene--dots" />
            <h3>A pool at the price</h3>
            <p>
              Everything a new token raises, less the platform fee, goes into a Meteora trading pool at exactly the
              final price, and nobody can ever take it out. A high fee in the first ten minutes keeps sniping bots
              away.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
