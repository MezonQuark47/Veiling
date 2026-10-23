import { useEffect, useState } from "react";
import { Header, Logo } from "./components/Header";
import { AuctionPage } from "./pages/AuctionPage";
import { Docs } from "./pages/Docs";
import { Home } from "./pages/Home";
import { Launch } from "./pages/Launch";
import { MyBids } from "./pages/MyBids";
import { FEATURE_CONTACT } from "./config";

function currentRoute(): string {
  return window.location.hash.replace(/^#\/?/, "");
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
            Sealed-bid auctions for tokens and NFT collections on Solana. Bids stay encrypted until one clearing
            price is found, and every winner pays it.
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

export function App() {
  const [route, setRoute] = useState(currentRoute());

  useEffect(() => {
    const onHash = () => {
      setRoute(currentRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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
