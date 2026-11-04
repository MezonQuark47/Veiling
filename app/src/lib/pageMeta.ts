import { CONTENT_UPDATED, SEASON } from "../config";
import { pageKind } from "./router";

export interface PageMeta {
  title: string;
  description: string;
  /** The page's own address, for search engines: the docs' sections all belong to /docs. */
  path: string;
  /** False for pages that differ per wallet, which search engines should leave out. */
  index: boolean;
}

/** The front page's title in search results and tabs: what Veiling is, in the words people search for. */
export const HOME_TITLE = "Veiling: Sealed-Bid Token & NFT Launchpad on Solana";

const HOME =
  "Veiling sells new tokens and NFT collections on Solana by sealed-bid auction. Bids stay private, every winner pays one final price, and a new token is made only if its sale sells out.";

/**
 * Each page's title and description. The static pages are written with them
 * (scripts/prerender.mjs), and the app sets them as it moves between pages.
 */
export function pageMeta(route: string): PageMeta {
  const season = SEASON?.name ?? "Season";
  const page = (title: string, description: string, path = `/${route}`, index = true): PageMeta => ({ title, description, path, index });
  switch (pageKind(route)) {
    case "docs":
      return page(
        "How Veiling works · Sealed-bid auctions on Solana",
        "How Veiling's sealed-bid auctions work: bidding, the final price, new token launches with a locked Meteora pool, NFT drops and collections, fees, privacy and refunds.",
        "/docs"
      );
    case "launch":
      return page(
        "Launch a sale · Veiling",
        "Launch a new token, an NFT drop or a collection on Solana by sealed-bid auction. A new token is made only if its sale sells out, with its pool locked forever.",
        "/launch"
      );
    case "dashboard":
      return page("Dashboard · Veiling", "Your bids, your sales and your points on Veiling.", "/dashboard", false);
    case "stats":
      return page(
        "Stats and points · Veiling",
        "Everything sold on Veiling since the first sale, and the points leaderboard for bidders and launchers.",
        "/stats"
      );
    case "season":
      return page(
        `${season} · Veiling`,
        `Veiling's ${season}: bid in sealed-bid launches on Solana, launch your own and invite friends to earn points.`,
        "/season"
      );
    case "compare":
      return page(
        `Veiling vs pump.fun and other Solana launchpads (${CONTENT_UPDATED.slice(0, 4)}) · Veiling`,
        "How Veiling's sealed-bid launches compare to bonding-curve launchpads like pump.fun, curated token sales and first-come NFT mints: who gets the best price, what bots can do and what happens if demand is low."
      );
    case "about":
      return page(
        "About Veiling · Who builds the sealed-bid launchpad on Solana",
        "Who builds Veiling, why it exists, and how it is kept honest: open source code, on-chain rules and a security audit planned before mainnet."
      );
    case "terms":
      return page("Terms of Use · Veiling", "The terms for using Veiling, a sealed-bid launchpad on Solana.");
    case "risks":
      return page("Risk disclosure · Veiling", "The risks of bidding in and launching sales on Veiling, unaudited software on Solana.");
    case "privacy":
      return page("Privacy policy · Veiling", "What Veiling collects, what it never collects, and what stays private in a sealed-bid sale.");
    case "auction":
      return page(
        "Auction · Veiling",
        "A sealed-bid sale on Veiling: bids stay private until bidding closes, then every winner pays one final price."
      );
    case "auctions":
      return page(
        "Auctions · Veiling",
        "Live, upcoming and ended sealed-bid sales of new tokens and NFT collections on Solana. Bids stay private and every winner pays one final price.",
        "/auctions"
      );
    case "notfound":
      return page("Page not found · Veiling", "There is no page at this address.", `/${route}`, false);
    default:
      return page(HOME_TITLE, HOME, "/");
  }
}

/** Sets a tag in the page's head, adding it when it is missing. */
function headTag(selector: string, make: () => HTMLElement, attr: string, value: string) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = make();
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}

const meta = (key: "name" | "property", name: string) => () => {
  const el = document.createElement("meta");
  el.setAttribute(key, name);
  return el;
};

/** Gives the page in view its title, description and address, as its static page would have. */
export function applyPageMeta(route: string) {
  const m = pageMeta(route);
  const url = `${window.location.origin}${m.path}`;
  document.title = m.title;
  headTag('meta[name="description"]', meta("name", "description"), "content", m.description);
  headTag('meta[property="og:title"]', meta("property", "og:title"), "content", m.title);
  headTag('meta[property="og:description"]', meta("property", "og:description"), "content", m.description);
  headTag('meta[property="og:url"]', meta("property", "og:url"), "content", url);
  headTag(
    'link[rel="canonical"]',
    () => {
      const el = document.createElement("link");
      el.rel = "canonical";
      return el;
    },
    "href",
    url
  );
  const robots = document.head.querySelector('meta[name="robots"]');
  if (m.index) robots?.remove();
  else headTag('meta[name="robots"]', meta("name", "robots"), "content", "noindex");
}

/** Names a page after what it shows once that has loaded, such as a sale's token. */
export function setPageTitle(title: string, description?: string | null) {
  document.title = title;
  headTag('meta[property="og:title"]', meta("property", "og:title"), "content", title);
  if (description) {
    const text = description.length > 200 ? `${description.slice(0, 197).trimEnd()}…` : description;
    headTag('meta[name="description"]', meta("name", "description"), "content", text);
    headTag('meta[property="og:description"]', meta("property", "og:description"), "content", text);
  }
}
