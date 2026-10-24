import { useState } from "react";
import { NETWORK_LABEL } from "../config";
import { connection } from "../lib/chain";
import { useWallet } from "../lib/wallet";
import { useLoader } from "./ui";

/**
 * A connected wallet with no SOL here is usually set to another network (or
 * new): say so before its first transaction fails.
 */
export function NetworkNotice() {
  const { publicKey } = useWallet();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = publicKey?.toBase58() ?? "";
  const balance = useLoader(
    () => (publicKey ? connection.getBalance(publicKey, "confirmed") : Promise.resolve(null)),
    [key],
    60_000
  );
  if (!publicKey || balance.data !== 0 || dismissed === key) return null;
  return (
    <div className="netnotice" role="status">
      <p>
        {NETWORK_LABEL ? (
          <>
            This wallet has no SOL on {NETWORK_LABEL}. If your wallet is set to another network, switch it to{" "}
            {NETWORK_LABEL}; free test SOL is at{" "}
            <a href="https://faucet.solana.com" target="_blank" rel="noreferrer noopener">
              faucet.solana.com
            </a>
            .
          </>
        ) : (
          "This wallet has no SOL. Add some to bid or launch: every transaction needs a little for its fee."
        )}
      </p>
      <button className="netnotice__close" onClick={() => setDismissed(key)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
