import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { PublicKey } from "@solana/web3.js";
import {
  type Auction,
  type CollectionInfo,
  type TokenInfo,
  fetchCollectionInfo,
  fetchMetadataImage,
  fetchSaleTokenInfo,
  fetchTokenInfo,
} from "../lib/chain";
import { EXPLORER_CLUSTER } from "../config";
import { formatTokens, nowSecs, plural, shortAddress } from "../lib/format";
import { errorMessage } from "../lib/tx";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(nowSecs());
  useEffect(() => {
    const id = setInterval(() => setNow(nowSecs()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Loads data, reloads on demand and, optionally, on an interval. */
/**
 * Data rendered into the static pages at build time (`prerender.tsx`), by
 * loader. Empty in the browser, where every loader fetches as usual.
 */
const seeds = new Map<unknown, unknown>();

/** Gives a loader its data up front, so the static pages show real values. */
export function seedLoader<T>(load: () => Promise<T>, data: T) {
  seeds.set(load, data);
}

export function useLoader<T>(load: () => Promise<T>, deps: unknown[], pollMs?: number): Loaded<T> {
  const seeded = seeds.get(load) as T | undefined;
  const [data, setData] = useState<T | undefined>(seeded);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(seeded === undefined);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadRef
      .current()
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => setTick((t) => t + 1), pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/**
 * What a token sale sells. For a fair launch that is the token once made,
 * or the name and symbol it will be made with (`fetchSaleTokenInfo`); the
 * key changes once the launch's token exists, so it reloads then.
 */
export function useSaleTokenInfo(auction: Auction | null | undefined): TokenInfo | null {
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const key = auction ? `${auction.address.toBase58()}:${auction.liquidity}` : undefined;
  useEffect(() => {
    if (!auction) return;
    let cancelled = false;
    fetchSaleTokenInfo(auction)
      .then((t) => !cancelled && setInfo(t))
      .catch(() => !cancelled && setInfo(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return info;
}

export function useTokenInfo(mint: PublicKey | null | undefined): TokenInfo | null {
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const key = mint?.toBase58();
  useEffect(() => {
    if (!mint) return;
    let cancelled = false;
    fetchTokenInfo(mint)
      .then((t) => !cancelled && setInfo(t))
      .catch(() => !cancelled && setInfo(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return info;
}

export function tokenLabel(info: TokenInfo | null, mint: PublicKey): { title: string; sub: string } {
  if (info?.symbol || info?.name) {
    return { title: info.symbol ?? info.name ?? "", sub: info.name ?? shortAddress(mint.toBase58()) };
  }
  return { title: shortAddress(mint.toBase58()), sub: "Token" };
}

/** What an auction sells: a token's details, or a collection's. */
export interface AssetInfo {
  token: TokenInfo | null;
  collection: CollectionInfo | null;
  title: string;
  sub: string;
  /** What one price is for: "token" or "NFT". */
  unit: string;
  /** What a winner receives, in words: the token's symbol, or "NFTs". */
  goods: string;
  /** The token's decimals once loaded; 0 for a collection. */
  decimals: number | null;
}

export function useAssetInfo(auction: Auction | null | undefined): AssetInfo {
  const isCollection = auction?.kind === "collection";
  const token = useSaleTokenInfo(isCollection ? null : auction);
  const [collection, setCollection] = useState<CollectionInfo | null>(null);
  const key = isCollection ? auction?.mint.toBase58() : undefined;
  useEffect(() => {
    setCollection(null);
    if (!isCollection || !auction) return;
    let cancelled = false;
    fetchCollectionInfo(auction.mint)
      .then((c) => !cancelled && setCollection(c))
      .catch(() => !cancelled && setCollection(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!auction) return { token: null, collection: null, title: "", sub: "", unit: "token", goods: "tokens", decimals: null };
  if (isCollection) {
    return {
      token: null,
      collection,
      title: collection?.name || auction.itemName || shortAddress(auction.mint.toBase58()),
      sub: "NFT collection",
      unit: "NFT",
      goods: "NFTs",
      decimals: 0,
    };
  }
  const label = tokenLabel(token, auction.mint);
  return {
    token,
    collection: null,
    title: label.title,
    sub: label.sub,
    unit: "token",
    goods: token?.symbol ?? "tokens",
    decimals: token ? token.decimals : null,
  };
}

/** An amount of what an auction sells: "1,250 TULIP" or "3 NFTs". */
export function goodsAmount(amount: bigint, asset: AssetInfo, maxDecimals = 4): string {
  if (asset.unit === "NFT") return plural(Number(amount), "NFT");
  if (asset.decimals === null) return "…";
  return `${formatTokens(amount, asset.decimals, maxDecimals)} ${asset.goods}`;
}

/** The image a metadata file points to, loaded lazily and only over https. */
export function useMetadataImage(uri: string | null | undefined): string | null {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    setImage(null);
    if (!uri) return;
    let cancelled = false;
    fetchMetadataImage(uri).then((url) => !cancelled && setImage(url));
    return () => {
      cancelled = true;
    };
  }, [uri]);
  return image;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet";
  busy?: boolean;
};

export function Button({ variant = "secondary", busy = false, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={`btn btn--${variant}${busy ? " btn--busy" : ""}${className ? ` ${className}` : ""}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "success"; children: ReactNode }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/** Copies a value, and says so for a moment. */
export function CopyButton({ value, label = "Copy address" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copy${copied ? " copy--done" : ""}`}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access can be refused; the address is still selectable.
        }
      }}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        {copied ? (
          <path d="M4.5 10.5 8.5 14.5 15.5 6" />
        ) : (
          <>
            <rect x="7" y="7" width="9" height="9" rx="2" />
            <path d="M13 4.5H6a1.5 1.5 0 0 0-1.5 1.5v7" />
          </>
        )}
      </svg>
    </button>
  );
}

export function AddressLink({ address, label, copy = false }: { address: PublicKey; label?: string; copy?: boolean }) {
  const value = address.toBase58();
  const link = (
    <a
      className="address"
      href={`https://explorer.solana.com/address/${value}${EXPLORER_CLUSTER}`}
      target="_blank"
      rel="noreferrer noopener"
      title={value}
    >
      {label ?? shortAddress(value)}
    </a>
  );
  if (!copy) return link;
  return (
    <span className="address-copy">
      {link}
      <CopyButton value={value} />
    </span>
  );
}

export function TxLink({ signature }: { signature: string }) {
  return (
    <a
      className="address"
      href={`https://explorer.solana.com/tx/${signature}${EXPLORER_CLUSTER}`}
      target="_blank"
      rel="noreferrer noopener"
    >
      View transaction
    </a>
  );
}

/** Runs an async action with busy state, error capture and a success note. */
// ---------------------------------------------------------------------------
// Toasts: what an action did, in the corner of the screen.

interface Toast {
  id: number;
  body: ReactNode;
}

let toasts: Toast[] = [];
let nextToast = 1;
const toastListeners = new Set<(list: Toast[]) => void>();
const setToasts = (list: Toast[]) => {
  toasts = list;
  toastListeners.forEach((listener) => listener(toasts));
};

/** Shows a message in the corner for a few seconds. */
export function pushToast(body: ReactNode) {
  const id = nextToast++;
  setToasts([...toasts.slice(-2), { id, body }]);
  window.setTimeout(() => dismissToast(id), 8_000);
}

function dismissToast(id: number) {
  setToasts(toasts.filter((t) => t.id !== id));
}

/** The corner where toasts appear; rendered once, by the app. */
export function Toaster() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    toastListeners.add(setList);
    return () => {
      toastListeners.delete(setList);
    };
  }, []);
  return (
    <div className="toaster" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span className="toast__icon" aria-hidden="true" />
          <div className="toast__body">{t.body}</div>
          <button className="toast__close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Runs one action at a time and keeps its error. What a successful action
 * returns shows as a toast, or, with `toast: false`, stays in `done` for the
 * caller to show in place.
 */
export function useAction({ toast = true }: { toast?: boolean } = {}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReactNode | null>(null);

  const run = useCallback(
    async (key: string, action: () => Promise<ReactNode | void>) => {
      setBusy(key);
      setError(null);
      setDone(null);
      try {
        const result = await action();
        if (result) {
          if (toast) pushToast(result);
          else setDone(result);
        }
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [toast]
  );

  return { busy, error, done, run, clear: () => (setError(null), setDone(null)) };
}
