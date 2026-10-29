import { PublicKey } from "@solana/web3.js";
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

/** Keeps the inviting wallet from a link like https://veiling.xyz/?ref=<wallet>, and tidies the address bar. */
export function captureInvite() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const ref = url.searchParams.get("ref");
  if (!ref) return;
  try {
    const key = new PublicKey(ref);
    if (key.toBase58() === ref) localStorage.setItem(REF_KEY, JSON.stringify({ referrer: ref, state: "pending" }));
  } catch {
    // Not a wallet, or no storage: the invite is simply not kept.
  }
  url.searchParams.delete("ref");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
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

/** The link that invites people as `wallet`. */
export const inviteLink = (wallet: string) => `${window.location.origin}/?ref=${wallet}`;

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
