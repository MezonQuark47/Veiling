import type { PublicKey } from "@solana/web3.js";
import { EXPLORER_CLUSTER, NETWORK_LABEL } from "../config";
import { connection } from "../lib/chain";
import { formatCount, formatSol, shortAddress } from "../lib/format";
import { fetchWalletView } from "../lib/stats";
import { CopyButton, useLoader } from "./ui";

/** Two hues and an angle from an address: every wallet gets its own colours. */
function seedOf(address: string): [number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < address.length; i++) h = Math.imul(h ^ address.charCodeAt(i), 16777619);
  const a = (h >>> 0) % 360;
  const b = (a + 40 + ((h >>> 9) % 140)) % 360;
  return [a, b, (h >>> 17) % 360];
}

/** A wallet's mark: a soft gradient with the Veiling plates on it, made from its address. */
export function Avatar({ address, size = 28 }: { address: string; size?: number }) {
  const [a, b, angle] = seedOf(address);
  const id = `av-${address.slice(0, 8)}-${size}`;
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientTransform={`rotate(${angle} 0.5 0.5)`}>
          <stop offset="0" stopColor={`hsl(${a} 78% 66%)`} />
          <stop offset="1" stopColor={`hsl(${b} 70% 42%)`} />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill={`url(#${id})`} />
      <path d="M20 9 31 15.4 20 21.8 9 15.4Z" fill="rgba(255,255,255,0.32)" />
      <path d="M9 21 20 27.4 31 21" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="1.6" />
      <path d="M9 26 20 32.4 31 26" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.6" />
    </svg>
  );
}

/** The SOL a wallet holds, refreshed every half minute. */
const MOCK = import.meta.env.DEV && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("mock");

export function useBalance(publicKey: PublicKey | null) {
  return useLoader(
    () =>
      !publicKey
        ? Promise.resolve(null)
        : MOCK
          ? Promise.resolve(12_345_600_000n)
          : connection.getBalance(publicKey, "confirmed").then(BigInt),
    [publicKey?.toBase58() ?? ""],
    30_000
  );
}

const Icon = {
  grid: "M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z",
  bids: "M10 3 17 7 10 11 3 7Z M3 11l7 4 7-4",
  chart: "M4 16V9M10 16V4M16 16v-5",
  out: "M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3M11 4h5v5M16 4l-7 7",
  off: "M10 3v6M6.2 5.6a6 6 0 1 0 7.6 0",
};

function MenuIcon({ d }: { d: string }) {
  return (
    <svg className="account__icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** The chip in the top bar for a connected wallet. */
export function AccountChip({ publicKey, active }: { publicKey: PublicKey; active: boolean }) {
  const address = publicKey.toBase58();
  const balance = useBalance(publicKey);
  return (
    <span className={`account-chip${active ? " account-chip--active" : ""}`}>
      <Avatar address={address} />
      <span className="account-chip__text">
        <span className="account-chip__address">{shortAddress(address)}</span>
        <span className="account-chip__balance">{balance.data != null ? `${formatSol(balance.data, 2)} SOL` : "…"}</span>
      </span>
      <svg className="account-chip__caret" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M3 4.5 6 7.5 9 4.5" />
      </svg>
    </span>
  );
}

/** The account panel that opens from the chip: who you are, what you hold, your points, where to go. */
export function AccountPanel({
  publicKey,
  walletName,
  onNavigate,
  onDisconnect,
}: {
  publicKey: PublicKey;
  walletName: string | null;
  onNavigate: () => void;
  onDisconnect: () => void;
}) {
  const address = publicKey.toBase58();
  const balance = useBalance(publicKey);
  const view = useLoader(() => fetchWalletView(address).catch(() => null), [address]).data ?? null;
  const t = view?.totals;
  return (
    <div className="account" role="menu" aria-label="Your account">
      <div className="account__head">
        <Avatar address={address} size={48} />
        <div className="account__who">
          <span className="account__address">
            {shortAddress(address, 5)} <CopyButton value={address} />
          </span>
          <span className="account__wallet">
            {walletName ?? "Wallet"}
            {NETWORK_LABEL ? ` · ${NETWORK_LABEL}` : ""}
          </span>
        </div>
      </div>

      <div className="account__balance">
        <span className="account__label">Balance</span>
        <span className="account__sol">{balance.data != null ? formatSol(balance.data, 4) : "…"} SOL</span>
      </div>

      <a className="account__points" href="#/stats" onClick={onNavigate}>
        <span>
          <span className="account__label">Points</span>
          <span className="account__points-value">{view ? formatCount(view.points) : "—"}</span>
        </span>
        <span className="account__rank">{view?.rank ? `#${formatCount(view.rank)}` : "Not ranked yet"}</span>
      </a>

      {t ? (
        <dl className="account__mini">
          <div>
            <dt>Spent</dt>
            <dd>{formatSol(BigInt(t.paid), 2)} SOL</dd>
          </div>
          <div>
            <dt>Sales</dt>
            <dd>{formatCount(t.salesJoined)}</dd>
          </div>
          <div>
            <dt>Won</dt>
            <dd>{formatCount(t.salesWon)}</dd>
          </div>
        </dl>
      ) : null}

      <nav className="account__links">
        <a className="account__link account__link--main" role="menuitem" href="#/bids" onClick={onNavigate}>
          <MenuIcon d={Icon.grid} />
          Dashboard
        </a>
        <a className="account__link" role="menuitem" href="#/stats" onClick={onNavigate}>
          <MenuIcon d={Icon.chart} />
          Stats and leaderboard
        </a>
        <a
          className="account__link"
          role="menuitem"
          href={`https://explorer.solana.com/address/${address}${EXPLORER_CLUSTER}`}
          target="_blank"
          rel="noreferrer noopener"
          onClick={onNavigate}
        >
          <MenuIcon d={Icon.out} />
          View on Explorer
        </a>
        <button className="account__link account__link--quiet" role="menuitem" onClick={onDisconnect}>
          <MenuIcon d={Icon.off} />
          Disconnect
        </button>
      </nav>
    </div>
  );
}
