// Runs in front of the built site on Cloudflare (wrangler.jsonc). It does two
// things the static files cannot:
//
// - An address that is no page of the site answers "404 Not Found", so search
//   engines do not keep it as a copy of the front page.
// - A sale's page (/auction/<address>) names the sale in its title,
//   description and link preview, read from the chain, so a sale shared on X
//   or Telegram shows its own name and image.
//
// Everything else goes to the static files as it is.
import "../src/polyfills";
import { useRpc } from "./fetch";
import { PublicKey } from "@solana/web3.js";
import { fetchAuction, fetchCollectionInfo, fetchCollectionMetadata, fetchSaleTokenInfo, phaseOf, type Auction } from "../src/lib/chain";
import { pageKind, routeOf } from "../src/lib/router";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** An RPC that serves Cloudflare's network, such as Helius; a secret, set in Cloudflare's settings. */
  RPC_URL?: string;
}

// Cloudflare's runtime provides these.
declare const HTMLRewriter: new () => {
  on(selector: string, handler: { element(el: RewriterElement): void }): InstanceType<typeof HTMLRewriter>;
  transform(response: Response): Response;
};
interface RewriterElement {
  setAttribute(name: string, value: string): void;
  setInnerContent(content: string): void;
  append(content: string, options: { html: boolean }): void;
  remove(): void;
}
declare const caches: { default: { match(key: Request): Promise<Response | undefined>; put(key: Request, response: Response): Promise<void> } };
interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

/** Files (images, scripts, robots.txt): served as they are. */
const FILE = /\.[a-z0-9]+$/i;
/** How long a sale's preview is kept before it is read from the chain again. */
const CARD_SECONDS = 300;

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const url = new URL(request.url);
    if ((request.method !== "GET" && request.method !== "HEAD") || FILE.test(url.pathname)) return env.ASSETS.fetch(request);
    const route = routeOf(url.pathname);
    const kind = pageKind(route);
    if (kind === "notfound") return notFound(request, env);
    if (kind === "auction") {
      useRpc(env.RPC_URL);
      return saleCard(request, env, ctx, route.slice("auction/".length));
    }
    return env.ASSETS.fetch(request);
  },
};

/** The app's page (index.html), which shows the right page once it starts. */
const appPage = (request: Request, env: Env) => env.ASSETS.fetch(new Request(new URL("/", request.url), request));

async function notFound(request: Request, env: Env): Promise<Response> {
  const page = await appPage(request, env);
  const headers = new Headers(page.headers);
  headers.set("Cache-Control", "no-cache");
  return new HTMLRewriter()
    .on("head", { element: (el) => el.append('<meta name="robots" content="noindex" />', { html: true }) })
    .transform(new Response(page.body, { status: 404, headers }));
}

interface Card {
  title: string;
  description: string;
  image: string | null;
  /** A wide image (a collection's banner) fills a large preview; a square one, a small one. */
  wide: boolean;
}

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const when = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }) + " UTC";

/** Where a sale stands, in a few words, for the preview's description. */
function status(a: Auction): string {
  const phase = phaseOf(a, Math.floor(Date.now() / 1000));
  if (phase === "upcoming") return `Bidding opens ${when(a.startTime)}.`;
  if (phase === "bidding") return `Bidding is open until ${when(a.endTime)}.`;
  if (phase === "cancelled") return "This sale was cancelled.";
  return "Bidding has closed.";
}

/** What a sale's preview shows, read from the chain and its metadata. */
async function loadCard(address: string): Promise<Card | null> {
  const auction = await fetchAuction(new PublicKey(address));
  if (!auction) return null;
  const sealed = "Private bids, one final price that every winner pays.";
  if (auction.kind === "collection") {
    const collection = await fetchCollectionInfo(auction.mint);
    const meta = collection ? await fetchCollectionMetadata(collection.uri) : null;
    const name = collection?.name || auction.itemName || "NFT collection";
    return {
      title: `${name} NFT sale · Veiling`,
      description: shorten(`${meta?.description ? `${meta.description} ` : `A sealed-bid sale of ${name} NFTs on Veiling. `}${status(auction)} ${sealed}`, 300),
      image: meta?.banner ?? meta?.image ?? meta?.preview ?? null,
      wide: Boolean(meta?.banner),
    };
  }
  const token = await fetchSaleTokenInfo(auction);
  const meta = token.uri ? await fetchCollectionMetadata(token.uri) : null;
  const name = token.symbol ?? token.name ?? "Token";
  const full = token.name && token.symbol && token.name !== token.symbol ? `${token.name} (${token.symbol})` : name;
  return {
    title: `${name} token sale · Veiling`,
    description: shorten(
      `${meta?.description ? `${meta.description} ` : `A sealed-bid sale of ${full} on Veiling. `}${status(auction)} ${sealed}`,
      300
    ),
    image: meta?.banner ?? meta?.image ?? null,
    wide: Boolean(meta?.banner),
  };
}

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

async function saleCard(request: Request, env: Env, ctx: Context, address: string): Promise<Response> {
  const url = new URL(request.url);
  const page = await appPage(request, env);
  // A new deploy changes index.html, and with it the kept previews' key.
  const version = page.headers.get("ETag") ?? "";
  const key = new Request(`${url.origin}${url.pathname}?v=${encodeURIComponent(version)}`);
  const kept = await caches.default.match(key);
  if (kept) return forBrowser(kept);

  let card: Card | null | undefined;
  try {
    card = await withTimeout(loadCard(address), 5_000);
  } catch (e) {
    // The chain could not be read in time: the page still works, with the general preview.
    console.error(`sale preview for ${address} not made:`, e instanceof Error ? e.message : e);
    card = undefined;
  }
  if (card === null) return notFound(request, env);
  if (!card) return page;

  const canonical = `${url.origin}${url.pathname}`;
  const { title, description, image, wide } = card;
  let rewriter = new HTMLRewriter()
    .on("title", { element: (el) => el.setInnerContent(title) })
    .on('meta[name="description"]', { element: (el) => el.setAttribute("content", description) })
    .on('meta[property="og:title"]', { element: (el) => el.setAttribute("content", title) })
    .on('meta[property="og:description"]', { element: (el) => el.setAttribute("content", description) })
    .on("head", {
      element: (el) =>
        el.append(
          `<link rel="canonical" href="${escapeAttr(canonical)}" />\n<meta property="og:url" content="${escapeAttr(canonical)}" />`,
          { html: true }
        ),
    });
  if (image) {
    rewriter = rewriter
      .on('meta[property="og:image"]', { element: (el) => el.setAttribute("content", image) })
      .on('meta[name="twitter:image"]', { element: (el) => el.setAttribute("content", image) })
      .on('meta[property="og:image:alt"]', { element: (el) => el.setAttribute("content", title) })
      // The sale's own image has its own size and type.
      .on('meta[property="og:image:width"], meta[property="og:image:height"], meta[property="og:image:type"]', {
        element: (el) => el.remove(),
      });
    if (!wide) rewriter = rewriter.on('meta[name="twitter:card"]', { element: (el) => el.setAttribute("content", "summary") });
  }

  const headers = new Headers(page.headers);
  headers.set("Cache-Control", `public, max-age=${CARD_SECONDS}`);
  const response = rewriter.transform(new Response(page.body, { status: 200, headers }));
  ctx.waitUntil(caches.default.put(key, response.clone()));
  return forBrowser(response);
}

/** Browsers always ask again, so a sale's page is never older than its site. */
function forBrowser(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-cache");
  return new Response(response.body, { status: response.status, headers });
}
