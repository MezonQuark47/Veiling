/**
 * The app's pages live in the address's path (/auctions, /auction/<address>).
 * The host answers every path with the app (wrangler.jsonc), and links inside
 * the site change the page without reloading it.
 */

const NAVIGATE = "veiling:navigate";

/** The page a path names: "" for the front page, "auctions", "docs/fees". */
export const routeOf = (path: string) => path.replace(/^\/+|\/+$/g, "");

export const currentRoute = () => routeOf(window.location.pathname);

export type PageKind =
  | "home"
  | "auctions"
  | "auction"
  | "launch"
  | "dashboard"
  | "stats"
  | "season"
  | "docs"
  | "compare"
  | "about"
  | "terms"
  | "risks"
  | "privacy"
  | "notfound";

/** A Solana address: 32 to 44 base58 characters. */
export const SALE_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Which page a route is; anything else is "notfound". The app and the
 * host's worker (worker/index.ts) both use it, so an unknown address is a
 * real "not found" for search engines too.
 */
export function pageKind(route: string): PageKind {
  const [first, ...rest] = route.split("/");
  const more = rest.join("/");
  if (first === "auction") return SALE_ADDRESS.test(more) ? "auction" : "notfound";
  if (first === "docs") return more === "" || /^[a-z-]+$/.test(more) ? "docs" : "notfound";
  if (more !== "") return "notfound";
  switch (first) {
    case "":
      return "home";
    case "auctions":
    case "launch":
    case "stats":
    case "compare":
    case "about":
    case "terms":
    case "risks":
    case "privacy":
      return first;
    case "bids":
    case "dashboard":
      return "dashboard";
    case "season":
    case "invite":
      return "season";
    default:
      return "notfound";
  }
}

/** Opens a page of the site, keeping it in the browser's history. */
export function navigate(path: string, { replace = false } = {}) {
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAVIGATE));
}

/** Calls `onChange` whenever the page changes: a link, `navigate`, or Back and Forward. */
export function onRouteChange(onChange: () => void) {
  window.addEventListener(NAVIGATE, onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener(NAVIGATE, onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** Links shared before the move kept the page after a "#" (/#/auctions): open them at their new address. */
export function upgradeOldLink() {
  const { hash, search } = window.location;
  if (!hash.startsWith("#/")) return;
  const [path, query] = hash.slice(1).split("?");
  const params = new URLSearchParams(search);
  new URLSearchParams(query ?? "").forEach((value, key) => params.set(key, value));
  const rest = params.toString();
  window.history.replaceState(null, "", `${path || "/"}${rest ? `?${rest}` : ""}`);
}

/** Files served as they are (images, robots.txt, llms.txt), which the app must not open as pages. */
const isFile = (path: string) => /\.[a-z0-9]+$/i.test(path);

/**
 * Turns clicks on the site's own links into page changes without a reload.
 * New tabs, downloads and modified clicks are left to the browser.
 */
export function followLinks() {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = (e.target as Element | null)?.closest?.("a");
    if (!link || !link.href || link.hasAttribute("download")) return;
    if (link.target && link.target !== "_self") return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || isFile(url.pathname)) return;
    // A link to a part of this same page ("#fees") scrolls as usual.
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
    e.preventDefault();
    const next = `${url.pathname}${url.search}`;
    if (next !== `${window.location.pathname}${window.location.search}`) navigate(next);
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
