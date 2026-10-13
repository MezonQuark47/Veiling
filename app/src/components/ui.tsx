import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { PublicKey } from "@solana/web3.js";
import {
  type Auction,
  type CollectionInfo,
  type TokenInfo,
  fetchCollectionInfo,
  fetchMetadataImage,
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
export function useLoader<T>(load: () => Promise<T>, deps: unknown[], pollMs?: number): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
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
  const token = useTokenInfo(isCollection ? null : auction?.mint);
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

export function AddressLink({ address, label }: { address: PublicKey; label?: string }) {
  const value = address.toBase58();
  return (
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
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReactNode | null>(null);

  const run = useCallback(async (key: string, action: () => Promise<ReactNode | void>) => {
    setBusy(key);
    setError(null);
    setDone(null);
    try {
      const result = await action();
      if (result) setDone(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, []);

  return { busy, error, done, run, clear: () => (setError(null), setDone(null)) };
}
