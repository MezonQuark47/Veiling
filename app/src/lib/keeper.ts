import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { KEEPER_URL } from "../config";
import type { WalletSigner } from "./tx";

/**
 * The keeper's services for the site (scripts/lib/services.ts): invites,
 * the X check behind a sale's Verified badge, and reminders. Each needs
 * KEEPER_URL; without it they stay hidden.
 */

// Messages the wallet signs; they must match scripts/lib/services.ts.
export const inviteMessage = (wallet: string, referrer: string) =>
  `Veiling invite\n\nI joined Veiling through the invite of ${referrer}.\n\nWallet: ${wallet}`;
export const verifyMessage = (auction: string, post: string) =>
  `Veiling X verification\n\nI opened sale ${auction} and link it to this X post:\n${post}`;
export const handleMessage = (wallet: string, handle: string, post: string) =>
  `Veiling invite name\n\nLink my wallet ${wallet} to the X account @${handle}.\nPost: ${post}`;
/** The code a post carries to prove the X account and the wallet belong together. */
export const handleCode = (wallet: string, handle: string) =>
  `VEIL-${bytesToHex(sha256(new TextEncoder().encode(`veiling:${wallet}:${handle.toLowerCase()}`))).slice(0, 8).toUpperCase()}`;

/** An X handle: letters, digits and underscores, up to 15. */
export const isHandle = (text: string) => /^[A-Za-z0-9_]{1,15}$/.test(text);
const isWallet = (text: string) => {
  try {
    return new PublicKey(text).toBase58() === text;
  } catch {
    return false;
  }
};

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function post<T>(path: string, body: unknown): Promise<T> {
  if (!KEEPER_URL) throw new Error("This is not available here yet.");
  let res: Response;
  try {
    res = await fetch(`${KEEPER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Veiling's server could not be reached. Try again in a moment.");
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? "Something went wrong. Try again later.");
  return json as T;
}

async function get<T>(path: string): Promise<T | null> {
  if (!KEEPER_URL) return null;
  const res = await fetch(`${KEEPER_URL}${path}`, { cache: "no-cache" });
  return res.ok ? ((await res.json()) as T) : null;
}

async function sign(signer: WalletSigner, text: string) {
  if (!signer.signMessage) throw new Error("This wallet cannot sign messages. Try another wallet.");
  const { signedMessage, signature } = await signer.signMessage(new TextEncoder().encode(text));
  return { message: toBase64(signedMessage), signature: toBase64(signature) };
}

// ---------------------------------------------------------------- invites

const REF_KEY = "veiling:invite";

/**
 * Keeps who invited this visitor from a link like
 * https://veiling.xyz/invite/?ref=mezonquark47 (an X name) or ?ref=<wallet>,
 * and tidies the address bar. An invite link opens on the Season 0 page.
 */
export function captureInvite() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const ref = url.searchParams.get("ref");
  const invitePage = /^\/invite\/?$/.test(url.pathname);
  if (!ref && !invitePage) return;
  if (ref && (isWallet(ref) || isHandle(ref))) {
    try {
      localStorage.setItem(REF_KEY, JSON.stringify({ referrer: ref, state: "pending" }));
    } catch {
      // No storage: the invite is simply not kept.
    }
  }
  url.searchParams.delete("ref");
  const path = invitePage ? "/" : url.pathname;
  const hash = invitePage && !url.hash ? "#/season" : url.hash;
  window.history.replaceState(null, "", `${path}${url.search}${hash}`);
}

/** The wallet an invite name (an X handle) belongs to; a wallet stays as it is. */
export async function resolveReferrer(ref: string): Promise<{ wallet: string; handle: string | null } | null> {
  if (isWallet(ref)) return { wallet: ref, handle: null };
  if (!isHandle(ref)) return null;
  const found = await get<{ wallet: string; handle: string }>(`/handle/${ref.toLowerCase()}.json`).catch(() => null);
  return found ? { wallet: found.wallet, handle: found.handle } : null;
}

export interface StoredInvite {
  referrer: string;
  /** pending: not answered yet; done: accepted or not possible; dismissed: the visitor said no. */
  state: "pending" | "done" | "dismissed";
}

export function storedInvite(): StoredInvite | null {
  try {
    const raw = localStorage.getItem(REF_KEY);
    return raw ? (JSON.parse(raw) as StoredInvite) : null;
  } catch {
    return null;
  }
}

export function setInviteState(state: StoredInvite["state"]) {
  const invite = storedInvite();
  if (!invite) return;
  try {
    localStorage.setItem(REF_KEY, JSON.stringify({ ...invite, state }));
  } catch {
    // Without storage the banner shows again next visit; nothing breaks.
  }
}

/** The link that invites people as `name`: an X handle once linked, else the wallet. */
export const inviteLink = (name: string) => `${window.location.origin}/invite/?ref=${name}`;

/** Links the wallet to the X account that wrote `postUrl`, so its invite link can use that name. */
export async function claimHandle(signer: WalletSigner, postUrl: string) {
  const link = postUrl.trim();
  const handle = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/\d+/.exec(link)?.[1];
  if (!handle) throw new Error("Paste the link to your post on X (https://x.com/…/status/…).");
  const wallet = signer.publicKey.toBase58();
  const signed = await sign(signer, handleMessage(wallet, handle, link));
  return post<{ ok: true; handle: string }>("/handle", { wallet, post: link, ...signed });
}

export async function acceptInvite(signer: WalletSigner, referrer: string) {
  const wallet = signer.publicKey.toBase58();
  const signed = await sign(signer, inviteMessage(wallet, referrer));
  return post<{ ok: true; already?: boolean }>("/invite", { wallet, referrer, ...signed });
}

// --------------------------------------------------------- X verification

export interface Verified {
  handle: string;
  name: string;
  post: string;
  at: number;
}

let verifiedCache: Promise<Record<string, Verified>> | null = null;

/** Every verified sale, by address; loaded once a minute at most. */
export function fetchVerified(): Promise<Record<string, Verified>> {
  if (!verifiedCache) {
    verifiedCache = get<Record<string, Verified>>("/verified.json").then((v) => v ?? {}).catch(() => ({}));
    setTimeout(() => (verifiedCache = null), 60_000);
  }
  return verifiedCache;
}

export async function verifySale(signer: WalletSigner, auction: string, postUrl: string) {
  const link = postUrl.trim();
  const signed = await sign(signer, verifyMessage(auction, link));
  const result = await post<Verified & { ok: true }>("/verify", { auction, post: link, ...signed });
  verifiedCache = null;
  return result;
}

// ------------------------------------------------------------- reminders

export async function fetchNotifyInfo(): Promise<{ push: string | null; email: boolean } | null> {
  return get<{ push: string | null; email: boolean }>("/notify.json").catch(() => null);
}

export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const keyBytes = (base64url: string) => {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** Asks the browser for notifications and signs this sale up for them. */
export async function remindByPush(auction: string, publicKey: string) {
  if (!pushSupported()) throw new Error("This browser cannot show notifications from websites.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site. Allow them in your browser's settings.");
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await post("/remind", { auction, push: subscription.toJSON() });
}

export async function remindByEmail(auction: string, email: string) {
  await post("/remind", { auction, email });
}
