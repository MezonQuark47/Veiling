import { Component, Fragment, type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { Header, Logo } from "./components/Header";
import { AuctionPage } from "./pages/AuctionPage";
import { Docs } from "./pages/Docs";
import { Auctions } from "./pages/Auctions";
import { Home } from "./pages/Home";
import { Launch } from "./pages/Launch";
import { MyBids } from "./pages/MyBids";
import { Stats } from "./pages/Stats";
import { Legal } from "./pages/Legal";
import { Season } from "./pages/Season";
import { Compare } from "./pages/Compare";
import { About } from "./pages/About";
import { FEATURE_CONTACT, GITHUB_URL, PROJECT_X_URL, SEASON } from "./config";
import { Toaster } from "./components/ui";
import { NetworkNotice } from "./components/NetworkNotice";
import { SeasonBar } from "./components/SeasonBar";
import { InviteBanner } from "./components/InviteBanner";
import { reportError } from "./lib/analytics";
import { currentRoute, followLinks, onRouteChange, pageKind } from "./lib/router";
import { applyPageMeta } from "./lib/pageMeta";

/** GitHub's mark. */
function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

/** X's mark. */
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17.75 3h3.07l-6.72 7.68L22 21h-6.19l-4.85-6.34L5.41 21H2.33l7.19-8.21L2 3h6.34l4.38 5.8L17.75 3Zm-1.08 16.18h1.7L7.4 4.72H5.57l11.1 14.46Z" />
    </svg>
  );
}

/** A page that breaks shows a way out instead of a blank screen, and the error is reported. */
class PageBoundary extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  componentDidCatch(error: unknown) {
    reportError(error);
  }
  render() {
    if (!this.state.broken) return this.props.children;
    return (
      <main className="page">
        <h1 className="page__title">Something went wrong</h1>
        <p className="page__lede">This page hit an error. Your funds are safe: nothing is sent without your wallet.</p>
        <button className="btn btn--primary" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </main>
    );
  }
}

/** An address that is no page of the site; the host answers it with "404 Not Found" too. */
function NotFound() {
  return (
    <main className="page notfound">
      <h1 className="page__title">Page not found</h1>
      <p className="page__lede">There is no page at this address. It may have moved, or the link may be mistyped.</p>
      <div className="notfound__links">
        <a className="btn btn--primary" href="/">
          Go to the front page
        </a>
        <a className="btn btn--secondary" href="/auctions">
          See live auctions
        </a>
        <a className="btn btn--secondary" href="/docs">
          Read the docs
        </a>
      </div>
    </main>
  );
}

function Footer() {
  return (
    <footer className="band">
      <div className="band__inner">
        <div className="band__brand">
          <a href="/" className="band__name" aria-label="Veiling home">
            <Logo />
            Veiling
          </a>
          <p>
            Future of launchpads. Private bids, public price: sealed-bid auctions for new tokens and NFT
            collections on Solana, where every winner pays one final price.
          </p>
          <div className="band__social">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener" aria-label="Veiling on GitHub" title="Source code on GitHub">
              <GitHubIcon />
            </a>
            {PROJECT_X_URL ? (
              <a href={PROJECT_X_URL} target="_blank" rel="noreferrer noopener" aria-label="Veiling on X" title="Veiling on X">
                <XIcon />
              </a>
            ) : null}
          </div>
        </div>
        <nav className="band__links" aria-label="Auctions">
          <h2 className="band__heading">Auctions</h2>
          <a href="/auctions">Browse auctions</a>
          <a href="/launch">Launch an auction</a>
          <a href="/bids">Your dashboard</a>
          <a href="/stats">Stats and points</a>
          {SEASON ? <a href="/season">{SEASON.name}</a> : null}
        </nav>
        <nav className="band__links" aria-label="Docs">
          <h2 className="band__heading">Docs</h2>
          <a href="/docs/how">How it works</a>
          <a href="/docs/fees">Fees</a>
          <a href="/docs/launch">Drops and collections</a>
          <a href="/docs/token">New tokens</a>
          <a href="/docs/privacy">What stays private</a>
          <a href="/docs/safety">If something gets stuck</a>
          <a href="/docs/source">Source code</a>
          <a href="/compare">Veiling vs other launchpads</a>
          <a href="/about">About Veiling</a>
        </nav>
        <div className="band__feature">
          <h2 className="band__heading">Get featured</h2>
          <p>Featured auctions lead the front page. They are picked by hand; send your auction's link to</p>
          <a className="band__contact" href={FEATURE_CONTACT.href} target="_blank" rel="noreferrer noopener">
            {FEATURE_CONTACT.label} on X
          </a>
        </div>
      </div>
      <div className="band__fine">
        <p>Running on Solana with Arcium encrypted compute. Unaudited software: read the risks before you bid.</p>
        <nav className="band__legal" aria-label="Legal">
          <a href="/terms">Terms of Use</a>
          <a href="/risks">Risk disclosure</a>
          <a href="/privacy">Privacy policy</a>
        </nav>
      </div>
    </footer>
  );
}

/** The app; `route` fixes the page when it is rendered ahead of time (`prerender.tsx`). */
export function App({ route: fixed }: { route?: string }) {
  const [route, setRoute] = useState(() => fixed ?? currentRoute());

  useEffect(() => {
    // A page made ahead of time for another address waits hidden until the app shows the right one (prerender.mjs).
    document.getElementById("root")?.style.removeProperty("visibility");
    const stopLinks = followLinks();
    const stopRoutes = onRouteChange(() => {
      setRoute(currentRoute());
      window.scrollTo(0, 0);
    });
    return () => {
      stopLinks();
      stopRoutes();
    };
  }, []);

  // Parts of a page marked data-reveal rise into view as they are scrolled to.
  // The static pages (prerender.tsx) show everything: only the app hides them first.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("js-reveal");
    const seen = new WeakSet<Element>();
    const pending = () => [...document.querySelectorAll<HTMLElement>("[data-reveal]:not(.is-in)")].filter((el) => !seen.has(el));
    if (!("IntersectionObserver" in window)) {
      pending().forEach((el) => el.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
    );
    const watch = () =>
      pending().forEach((el) => {
        seen.add(el);
        io.observe(el);
      });
    watch();
    // Parts that appear later, once their data loads, are watched too.
    const mo = new MutationObserver(watch);
    mo.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [route]);

  // Each page's own title, description and address, as the static pages have (scripts/prerender.mjs).
  // Set before the page's own effects, so a page can then name itself (a sale after its token).
  useLayoutEffect(() => applyPageMeta(route), [route]);

  const kind = pageKind(route);
  let page;
  if (kind === "auction") page = <AuctionPage address={route.slice("auction/".length)} />;
  else if (kind === "auctions") page = <Auctions />;
  else if (kind === "launch") page = <Launch />;
  else if (kind === "dashboard") page = <MyBids />;
  else if (kind === "stats") page = <Stats />;
  else if (kind === "season") page = <Season />;
  else if (kind === "terms" || kind === "risks" || kind === "privacy") page = <Legal page={kind} />;
  else if (kind === "docs") page = <Docs section={route.slice("docs/".length)} />;
  else if (kind === "compare") page = <Compare />;
  else if (kind === "about") page = <About />;
  else if (kind === "notfound") page = <NotFound />;
  else page = <Home />;

  return (
    <>
      <Header route={route} />
      <SeasonBar route={route} />
      <NetworkNotice />
      <InviteBanner />
      {/* A new route mounts a new page, which fades in. */}
      <PageBoundary key={route}>
        <Fragment>{page}</Fragment>
      </PageBoundary>
      <Toaster />
      <Footer />
    </>
  );
}
