import { useEffect, useState } from "react";
import { Header, Logo } from "./components/Header";
import { AuctionPage } from "./pages/AuctionPage";
import { Docs } from "./pages/Docs";
import { Home } from "./pages/Home";
import { Launch } from "./pages/Launch";
import { MyBids } from "./pages/MyBids";
import { FEATURE_CONTACT } from "./config";

function currentRoute(): string {
  // The app's pages live in the hash (#/launch); "#/" is the front page.
  if (window.location.hash) return window.location.hash.replace(/^#\/?/, "");
  // Without one, the path decides: the docs also live at /docs/, a real page
  // that search engines can read (scripts/prerender.mjs).
  return window.location.pathname.replace(/^\/+|\/+$/g, "");
}

function Footer() {
  return (
    <footer className="band">
      <div className="band__inner">
        <div className="band__brand">
          <a href="#/" className="band__name" aria-label="Veiling home">
            <Logo />
            Veiling
          </a>
          <p>
            Sealed-bid auctions for new tokens and NFT collections on Solana. Bids are never opened: only one
            clearing price is made public, and every winner pays it.
          </p>
        </div>
        <nav className="band__links" aria-label="Auctions">
          <h2 className="band__heading">Auctions</h2>
          <a href="#/">Browse auctions</a>
          <a href="#/launch">Launch an auction</a>
          <a href="#/bids">My bids</a>
        </nav>
        <nav className="band__links" aria-label="Docs">
          <h2 className="band__heading">Docs</h2>
          <a href="#/docs/how">How it works</a>
          <a href="#/docs/fees">Fees</a>
          <a href="#/docs/launch">Drops and collections</a>
          <a href="#/docs/token">New tokens</a>
          <a href="#/docs/privacy">What stays private</a>
          <a href="#/docs/safety">If settlement stalls</a>
        </nav>
        <div className="band__feature">
          <h2 className="band__heading">Get featured</h2>
          <p>Featured auctions lead the front page. They are picked by hand; send your auction's link to</p>
          <a className="band__contact" href={FEATURE_CONTACT.href} target="_blank" rel="noreferrer noopener">
            {FEATURE_CONTACT.label} on X
          </a>
        </div>
      </div>
      <p className="band__fine">
        Running on Solana with Arcium encrypted compute.
      </p>
    </footer>
  );
}

/** The app; `route` fixes the page when it is rendered ahead of time (`prerender.tsx`). */
export function App({ route: fixed }: { route?: string }) {
  const [route, setRoute] = useState(() => fixed ?? currentRoute());

  useEffect(() => {
    const onHash = () => {
      setRoute(currentRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Each page's own title, as the static pages have (scripts/prerender.mjs).
  useEffect(() => {
    document.title = route.startsWith("docs")
      ? "How Veiling works · Sealed-bid auctions on Solana"
      : route.startsWith("launch")
        ? "Launch a sale · Veiling"
        : route.startsWith("bids")
          ? "My bids · Veiling"
          : route.startsWith("auction/")
            ? "Auction · Veiling"
            : "Veiling · Sealed-bid launches for new tokens and NFTs on Solana";
  }, [route]);

  let page;
  if (route.startsWith("auction/")) page = <AuctionPage address={route.slice("auction/".length)} />;
  else if (route.startsWith("launch")) page = <Launch />;
  else if (route.startsWith("bids")) page = <MyBids />;
  else if (route.startsWith("docs")) page = <Docs section={route.slice("docs/".length)} />;
  else page = <Home />;

  return (
    <>
      <Header route={route} />
      {page}
      <Footer />
    </>
  );
}
