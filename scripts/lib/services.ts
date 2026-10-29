/**
 * What the keeper does for the site besides finishing sales: invites, the X
 * check behind a sale's Verified badge, and reminders by browser
 * notification and email. Each keeps a small JSON file in the keeper's data
 * folder.
 *
 *   POST /invite      a wallet accepts an invite, with a signed message
 *   POST /verify      a seller links an X account to their sale: a signed
 *                     message from the seller, and a public post from the
 *                     account that names the sale
 *   GET  /verified.json
 *   GET  /notify.json what reminders the keeper can send
 *   POST /remind      a reminder for one sale, by browser push or email
 *   GET  /unsubscribe?id=…
 *
 * Settings (keeper.env):
 *   SITE_URL          the site's address, for links in reminders
 *   PUBLIC_URL        the keeper's own public address, for unsubscribe links
 *   RESEND_API_KEY    Resend key; without it there are no email reminders
 *   MAIL_FROM         the sender, e.g. "Veiling <reminders@veiling.xyz>"
 *   VAPID_SUBJECT     contact for browser push, e.g. mailto:team@veiling.xyz
 */
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { join } from "path";
import webpush from "web-push";
import type { Invite, StatsState } from "./stats";

// ---------------------------------------------------------------------------
// Files

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 1));
  renameSync(`${path}.tmp`, path);
}

// ---------------------------------------------------------------------------
// Messages the site asks wallets to sign. Must match app/src/lib/keeper.ts.

export const inviteMessage = (wallet: string, referrer: string) =>
  `Veiling invite\n\nI joined Veiling through the invite of ${referrer}.\n\nWallet: ${wallet}`;

export const verifyMessage = (auction: string, post: string) =>
  `Veiling X verification\n\nI opened sale ${auction} and link it to this X post:\n${post}`;

const isAddress = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
};

/** Checks that `wallet` signed exactly `text`. */
function signedBy(wallet: string, text: string, message: unknown, signature: unknown): boolean {
  if (typeof message !== "string" || typeof signature !== "string") return false;
  try {
    const bytes = Buffer.from(message, "base64");
    if (bytes.toString("utf8") !== text) return false;
    return ed25519.verify(Buffer.from(signature, "base64"), bytes, new PublicKey(wallet).toBytes());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Requests

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, "Too much data.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Send JSON.");
  }
}

/** A few posts per address per minute; the rest wait. */
const hits = new Map<string, number[]>();
function limit(req: IncomingMessage, perMinute: number) {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) throw new HttpError(429, "Too many requests. Try again in a minute.");
  recent.push(now);
  hits.set(ip, recent);
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}

// ---------------------------------------------------------------------------

/** What the services need from the keeper. */
export interface ServiceContext {
  dataDir: string;
  /** The indexer's state: who has used Veiling already. */
  state: () => StatsState;
  /** A sale as the program has it, or null when there is none. */
  fetchAuction: (address: string) => Promise<{ seller: string; status: string; endTime: number } | null>;
  log: (line: string) => void;
}

/** A sale's state, as the reminders need it. */
export interface SaleNow {
  status: string;
  endTime: number;
  /** Every bid is worked out and every token or refund sent. */
  done: boolean;
  /** It missed its minimum raise: every bid is refunded. */
  failed: boolean;
}

interface Verified {
  handle: string;
  name: string;
  post: string;
  at: number;
}

interface Reminder {
  id: string;
  auction: string;
  /** A browser push subscription, or an email address. */
  push?: webpush.PushSubscription;
  email?: string;
  created: number;
  sentEnding?: boolean;
}

const ENDING_SOON_SECS = 30 * 60;

export function createServices(ctx: ServiceContext) {
  const paths = {
    invites: join(ctx.dataDir, "invites.json"),
    verified: join(ctx.dataDir, "verified.json"),
    reminders: join(ctx.dataDir, "reminders.json"),
    vapid: join(ctx.dataDir, "vapid.json"),
  };
  const invites = readJson<Record<string, Invite>>(paths.invites, {});
  const verified = readJson<Record<string, Verified>>(paths.verified, {});
  let reminders = readJson<Reminder[]>(paths.reminders, []);

  const SITE_URL = (process.env.SITE_URL ?? "http://localhost:5173").replace(/\/$/, "");
  const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, "");
  const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
  const MAIL_FROM = process.env.MAIL_FROM ?? "";
  const emailOn = Boolean(RESEND_API_KEY && MAIL_FROM);

  // Browser push needs a key pair of its own, made once and kept.
  let vapid = readJson<{ publicKey: string; privateKey: string } | null>(paths.vapid, null);
  if (!vapid) {
    vapid = webpush.generateVAPIDKeys();
    writeJson(paths.vapid, vapid);
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:hello@veiling.xyz", vapid.publicKey, vapid.privateKey);

  // ---------------------------------------------------------------- invites

  async function acceptInvite(input: any) {
    const { wallet, referrer, message, signature } = input ?? {};
    if (!isAddress(wallet) || !isAddress(referrer)) throw new HttpError(400, "Those are not wallet addresses.");
    if (wallet === referrer) throw new HttpError(400, "You cannot invite yourself.");
    if (!signedBy(wallet, inviteMessage(wallet, referrer), message, signature))
      throw new HttpError(400, "The signature does not match.");
    if (invites[wallet]) return { ok: true, referrer: invites[wallet].referrer, already: true };
    const row = ctx.state().wallets[wallet];
    if (row && (row.bids > 0 || row.sales > 0))
      throw new HttpError(409, "This wallet already used Veiling before, so it cannot join through an invite.");
    invites[wallet] = { referrer, at: Math.floor(Date.now() / 1000), signature };
    writeJson(paths.invites, invites);
    ctx.log(`invite: ${wallet.slice(0, 4)}… joined through ${referrer.slice(0, 4)}…`);
    return { ok: true, referrer };
  }

  // --------------------------------------------------------- X verification

  async function verifySale(input: any) {
    const { auction, post, message, signature } = input ?? {};
    if (!isAddress(auction)) throw new HttpError(400, "That is not a sale address.");
    const m = typeof post === "string" ? /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/.exec(post.trim()) : null;
    if (!m) throw new HttpError(400, "Paste the link to your post on X (https://x.com/…/status/…).");
    const sale = await ctx.fetchAuction(auction);
    if (!sale) throw new HttpError(404, "No sale at this address.");
    if (!signedBy(sale.seller, verifyMessage(auction, post.trim()), message, signature))
      throw new HttpError(403, "Only the wallet that opened the sale can verify it.");
    const url = `https://twitter.com/${m[1]}/status/${m[2]}`;
    const res = await fetch(`https://publish.x.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new HttpError(422, "X did not show that post. Check it is public and try again.");
    const embed = (await res.json()) as { author_name?: string; author_url?: string; html?: string };
    const handle = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/.exec(embed.author_url ?? "")?.[1];
    if (!handle) throw new HttpError(422, "X did not say who wrote that post.");
    if (!(embed.html ?? "").includes(auction))
      throw new HttpError(422, "The post must include the sale's address, written out in full.");
    verified[auction] = {
      handle,
      name: String(embed.author_name ?? handle).slice(0, 60),
      post: `https://x.com/${handle}/status/${m[2]}`,
      at: Math.floor(Date.now() / 1000),
    };
    writeJson(paths.verified, verified);
    ctx.log(`verified: ${auction.slice(0, 4)}… is @${handle}`);
    return { ok: true, ...verified[auction] };
  }

  // ------------------------------------------------------------- reminders

  async function remind(input: any) {
    const { auction, push, email } = input ?? {};
    if (!isAddress(auction)) throw new HttpError(400, "That is not a sale address.");
    const sale = await ctx.fetchAuction(auction);
    if (!sale) throw new HttpError(404, "No sale at this address.");
    if (sale.status === "cancelled") throw new HttpError(409, "This sale was cancelled.");
    const reminder: Reminder = { id: randomBytes(16).toString("hex"), auction, created: Math.floor(Date.now() / 1000) };
    if (push && typeof push === "object" && typeof push.endpoint === "string" && /^https:\/\//.test(push.endpoint) && push.keys) {
      reminder.push = { endpoint: push.endpoint, keys: { p256dh: String(push.keys.p256dh), auth: String(push.keys.auth) } };
      if (reminders.some((r) => r.auction === auction && r.push?.endpoint === push.endpoint)) return { ok: true };
    } else if (typeof email === "string" && /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i.test(email.trim())) {
      if (!emailOn) throw new HttpError(503, "Email reminders are not set up yet.");
      reminder.email = email.trim().toLowerCase();
      if (reminders.some((r) => r.auction === auction && r.email === reminder.email)) return { ok: true };
      if (reminders.filter((r) => r.email === reminder.email).length >= 20)
        throw new HttpError(429, "This address already has many reminders.");
    } else {
      throw new HttpError(400, "Give an email address or allow notifications.");
    }
    reminders.push(reminder);
    writeJson(paths.reminders, reminders);
    if (reminder.email) {
      await sendEmail(
        reminder,
        "You will get a reminder",
        `We will email you when this sale is about to end, and again when it is over.\n\n${saleLink(auction)}`
      ).catch((e) => ctx.log(`reminders: could not send a confirmation (${e?.message ?? e})`));
    }
    return { ok: true, id: reminder.id };
  }

  const saleLink = (auction: string) => `${SITE_URL}/#/auction/${auction}`;

  async function sendEmail(r: Reminder, subject: string, text: string) {
    const unsubscribe = `${PUBLIC_URL}/unsubscribe?id=${r.id}`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [r.email],
        subject: `Veiling: ${subject}`,
        text: `${text}\n\n---\nYou asked for reminders about this sale on Veiling. Stop them: ${unsubscribe}`,
        headers: { "List-Unsubscribe": `<${unsubscribe}>` },
      }),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
  }

  async function notify(r: Reminder, title: string, text: string): Promise<boolean> {
    try {
      if (r.push) {
        await webpush.sendNotification(r.push, JSON.stringify({ title, body: text, url: saleLink(r.auction) }), { TTL: 3600 });
      } else if (r.email) {
        await sendEmail(r, title, `${text}\n\n${saleLink(r.auction)}`);
      }
      return true;
    } catch (e: any) {
      // A browser that turned notifications off answers 404 or 410: forget it.
      if (e?.statusCode === 404 || e?.statusCode === 410) return true;
      ctx.log(`reminders: could not send (${e?.message ?? e})`);
      return false;
    }
  }

  /**
   * Sends what is due, given every sale's state now (missing: closed). Called
   * by the keeper each time it looks at the sales.
   */
  async function sendReminders(sales: Map<string, SaleNow>, nameOf: (auction: string) => string) {
    if (reminders.length === 0) return;
    const now = Date.now() / 1000;
    const keep: Reminder[] = [];
    let changed = false;
    for (const r of reminders) {
      const sale = sales.get(r.auction);
      const name = nameOf(r.auction);
      const Name = name.charAt(0).toUpperCase() + name.slice(1);
      if (!sale || sale.done || sale.status === "cancelled") {
        const text = !sale || sale.done
          ? sale?.failed
            ? `${Name} did not reach its target, so it did not go ahead. Every deposit has come back in full.`
            : `${Name} is over. If you won, what you bought is in your wallet; any unused deposit has come back.`
          : `${Name} was cancelled by its seller.`;
        if (await notify(r, sale?.failed ? "Sale did not go ahead" : "Sale finished", text)) {
          changed = true;
          continue;
        }
      } else if (!r.sentEnding && sale.status === "open" && sale.endTime - now <= ENDING_SOON_SECS && sale.endTime > now) {
        const minutes = Math.max(1, Math.round((sale.endTime - now) / 60));
        if (await notify(r, "Bidding ends soon", `Bidding on ${name} ends in ${minutes} minutes. Bids are sealed until then.`)) {
          r.sentEnding = true;
          changed = true;
        }
      } else if (now - r.created > 60 * 86_400) {
        changed = true;
        continue;
      }
      keep.push(r);
    }
    if (changed) {
      reminders = keep;
      writeJson(paths.reminders, reminders);
    }
  }

  function unsubscribe(id: string | null): boolean {
    const before = reminders.length;
    reminders = reminders.filter((r) => r.id !== id);
    if (reminders.length !== before) writeJson(paths.reminders, reminders);
    return reminders.length !== before;
  }

  // ---------------------------------------------------------------- routes

  /** Answers the request if it is one of these; returns whether it did. */
  async function handle(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
    try {
      if (req.method === "OPTIONS") {
        res
          .writeHead(204, { "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" })
          .end();
        return true;
      }
      if (req.method === "POST" && path === "/invite") {
        limit(req, 10);
        send(res, 200, await acceptInvite(await body(req)));
      } else if (req.method === "POST" && path === "/verify") {
        limit(req, 5);
        send(res, 200, await verifySale(await body(req)));
      } else if (req.method === "POST" && path === "/remind") {
        limit(req, 10);
        send(res, 200, await remind(await body(req)));
      } else if (path === "/verified.json") {
        send(res, 200, verified);
      } else if (path === "/notify.json") {
        send(res, 200, { push: vapid!.publicKey, email: emailOn });
      } else if (path === "/unsubscribe") {
        const done = unsubscribe(query.get("id"));
        res
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(
            `<!doctype html><meta name="viewport" content="width=device-width"><title>Veiling</title><body style="font:16px system-ui;background:#0b0c10;color:#f5f5f7;display:grid;place-items:center;height:90vh"><p>${
              done ? "Done. You will get no more emails about this sale." : "This reminder was already stopped."
            }</p></body>`
          );
      } else {
        return false;
      }
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) ctx.log(`services: ${e?.message ?? e}`);
      send(res, status, { error: status === 500 ? "Something went wrong. Try again later." : e.message });
    }
    return true;
  }

  return { invites, verified, handle, sendReminders };
}
