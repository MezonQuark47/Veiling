import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { PublicKey, Transaction } from "@solana/web3.js";
import { WALLET_CHAIN } from "../config";
import type { WalletSigner } from "./tx";

/**
 * Design work only: `npm run dev` with `?mock&as=<address>` shows pages as
 * that wallet would see them, without signing anything. Production builds
 * drop it.
 */
const VIEW_AS: PublicKey | null = (() => {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const as = params.has("mock") ? params.get("as") : null;
  try {
    return as ? new PublicKey(as) : null;
  } catch {
    return null;
  }
})();

// Wallet Standard feature shapes used here (kept local to avoid extra packages).
type ConnectFeature = {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
};
type DisconnectFeature = { disconnect(): Promise<void> };
type EventsFeature = {
  on(event: "change", listener: (props: { accounts?: readonly WalletAccount[] }) => void): () => void;
};
type SignTransactionFeature = {
  signTransaction(
    ...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]
  ): Promise<readonly { signedTransaction: Uint8Array }[]>;
};
type SignMessageFeature = {
  signMessage(
    ...inputs: { account: WalletAccount; message: Uint8Array }[]
  ): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
};

const STORAGE_KEY = "veiling.wallet";

function isUsable(wallet: Wallet): boolean {
  return (
    "standard:connect" in wallet.features &&
    "solana:signTransaction" in wallet.features &&
    wallet.chains.some((c) => c.startsWith("solana:"))
  );
}

function remember(name: string | null) {
  try {
    if (name) localStorage.setItem(STORAGE_KEY, name);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); remembering is optional.
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

interface WalletState {
  wallets: Wallet[];
  wallet: Wallet | null;
  publicKey: PublicKey | null;
  connecting: boolean;
  connect(wallet: Wallet): Promise<void>;
  disconnect(): Promise<void>;
  signer: WalletSigner | null;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const api = getWallets();
    const refresh = () => setWallets(api.get().filter(isUsable));
    refresh();
    const offRegister = api.on("register", refresh);
    const offUnregister = api.on("unregister", refresh);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);

  const connectWith = useCallback(async (target: Wallet, silent: boolean) => {
    const feature = target.features["standard:connect"] as ConnectFeature;
    const { accounts } = await feature.connect(silent ? { silent: true } : undefined);
    const first = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
    if (!first) throw new Error("The wallet did not share an account");
    setWallet(target);
    setAccount(first);
    remember(target.name);
  }, []);

  // Reconnect quietly to the wallet used last time, if it allows that.
  useEffect(() => {
    if (wallet) return;
    const name = remembered();
    const target = name ? wallets.find((w) => w.name === name) : undefined;
    if (target) connectWith(target, true).catch(() => undefined);
  }, [wallets, wallet, connectWith]);

  // Follow account switches inside the wallet.
  useEffect(() => {
    if (!wallet || !("standard:events" in wallet.features)) return;
    const events = wallet.features["standard:events"] as EventsFeature;
    return events.on("change", ({ accounts }) => {
      if (!accounts) return;
      setAccount(accounts[0] ?? null);
      if (accounts.length === 0) setWallet(null);
    });
  }, [wallet]);

  const connect = useCallback(
    async (target: Wallet) => {
      setConnecting(true);
      try {
        await connectWith(target, false);
      } finally {
        setConnecting(false);
      }
    },
    [connectWith]
  );

  const disconnect = useCallback(async () => {
    const current = wallet;
    setWallet(null);
    setAccount(null);
    remember(null);
    if (current && "standard:disconnect" in current.features) {
      await (current.features["standard:disconnect"] as DisconnectFeature).disconnect().catch(() => undefined);
    }
  }, [wallet]);

  const publicKey = useMemo(() => (account ? new PublicKey(account.publicKey) : null), [account]);

  const signer = useMemo<WalletSigner | null>(() => {
    if (!wallet || !account || !publicKey) return null;
    const feature = wallet.features["solana:signTransaction"] as SignTransactionFeature;
    const messages =
      "solana:signMessage" in wallet.features ? (wallet.features["solana:signMessage"] as SignMessageFeature) : null;
    const chain = account.chains.includes(WALLET_CHAIN as `${string}:${string}`) ? WALLET_CHAIN : undefined;
    return {
      publicKey,
      async signTransaction(tx: Transaction) {
        const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const [result] = await feature.signTransaction({ account, transaction: bytes, chain });
        return Transaction.from(result.signedTransaction);
      },
      async signTransactions(txs: Transaction[]) {
        const inputs = txs.map((tx) => ({
          account,
          transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
          chain,
        }));
        const results = await feature.signTransaction(...inputs);
        return results.map((result) => Transaction.from(result.signedTransaction));
      },
      ...(messages
        ? {
            async signMessage(message: Uint8Array) {
              const [result] = await messages.signMessage({ account, message });
              return { signedMessage: result.signedMessage, signature: result.signature };
            },
          }
        : {}),
    };
  }, [wallet, account, publicKey]);

  const value = useMemo<WalletState>(
    () => ({ wallets, wallet, publicKey: publicKey ?? VIEW_AS, connecting, connect, disconnect, signer }),
    [wallets, wallet, publicKey, connecting, connect, disconnect, signer]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Opens the wallet menu in the top bar, from anywhere a wallet is needed. */
export const CONNECT_EVENT = "veiling:connect";
export function requestConnect() {
  window.dispatchEvent(new Event(CONNECT_EVENT));
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside WalletProvider");
  return value;
}
