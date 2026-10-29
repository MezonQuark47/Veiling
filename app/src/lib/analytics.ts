import { NETWORK_LABEL, PLAUSIBLE_DOMAIN, PLAUSIBLE_SCRIPT, SENTRY_DSN } from "../config";

/**
 * Privacy-friendly measuring, each part only when it is set up at build time:
 *
 * - Plausible counts page views and a few named actions, with no cookies and
 *   nothing that identifies a visitor (VITE_PLAUSIBLE_DOMAIN).
 * - Sentry reports errors, without IP addresses or personal data
 *   (VITE_SENTRY_DSN). It loads only when set, so it costs nothing otherwise.
 *
 * Neither ever gets a wallet address.
 */

type Plausible = ((event: string, options?: { props?: Record<string, string | number | boolean> }) => void) & {
  q?: unknown[];
};

declare global {
  interface Window {
    plausible?: Plausible;
  }
}

/** The actions Veiling counts. */
export type TrackedEvent =
  | "Wallet connected"
  | "Bid placed"
  | "Bid raised"
  | "Sale launched"
  | "Sale finished by user"
  | "Invite accepted"
  | "Invite link copied"
  | "Reminder set"
  | "Sale verified"
  | "Terms accepted";

export function track(event: TrackedEvent, props?: Record<string, string | number | boolean>) {
  try {
    window.plausible?.(event, props ? { props } : undefined);
  } catch {
    // Counting must never break the page.
  }
}

type Reporter = { captureException: (e: unknown) => void };
let reporter: Reporter | null = null;
const early: unknown[] = [];

/** Reports an error that the page caught itself, such as one shown to the visitor. */
export function reportError(e: unknown) {
  if (!SENTRY_DSN) return;
  if (reporter) reporter.captureException(e);
  else if (early.length < 10) early.push(e);
}

export function initAnalytics() {
  if (typeof window === "undefined") return;
  if (PLAUSIBLE_DOMAIN && !document.querySelector("script[data-domain]")) {
    // Calls made before the script loads wait in a queue.
    window.plausible ??= Object.assign((...args: unknown[]) => (window.plausible!.q ??= []).push(args), {}) as Plausible;
    const script = document.createElement("script");
    script.defer = true;
    script.dataset.domain = PLAUSIBLE_DOMAIN;
    script.src = PLAUSIBLE_SCRIPT;
    document.head.appendChild(script);
  }
  if (SENTRY_DSN) {
    void import("@sentry/browser").then((Sentry) => {
      Sentry.init({
        dsn: SENTRY_DSN!,
        environment: NETWORK_LABEL ? NETWORK_LABEL.toLowerCase() : "mainnet",
        // No user details, cookies, headers or query strings: errors only.
        dataCollection: { userInfo: false, cookies: false, httpHeaders: false, urlQueryParams: false, httpBodies: [] },
        tracesSampleRate: 0,
        // Wallets turning down a request are the visitor's choice, not errors.
        ignoreErrors: [/User rejected/i, /rejected the request/i, /user denied/i],
        beforeSend(event) {
          // No addresses leave the browser: Solana addresses look like long base58 words.
          const scrub = (text?: string) => text?.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "<address>");
          if (event.request?.url) event.request.url = scrub(event.request.url);
          for (const value of event.exception?.values ?? []) value.value = scrub(value.value);
          if (event.message) event.message = scrub(event.message);
          delete event.user;
          return event;
        },
      });
      reporter = Sentry;
      early.splice(0).forEach((e) => Sentry.captureException(e));
    });
  }
}
