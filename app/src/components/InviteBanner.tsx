import { useEffect, useState } from "react";
import { KEEPER_URL } from "../config";
import { track } from "../lib/analytics";
import { shortAddress } from "../lib/format";
import { acceptInvite, resolveReferrer, setInviteState, storedInvite, type StoredInvite } from "../lib/keeper";
import { errorMessage } from "../lib/tx";
import { useWallet } from "../lib/wallet";
import { Avatar } from "./Account";
import { pushToast, useLoader } from "./ui";

/**
 * Someone who came through an invite link sees, once their wallet is
 * connected, who invited them and can accept with a free signature.
 */
export function InviteBanner() {
  const { signer, publicKey } = useWallet();
  const [invite, setInvite] = useState<StoredInvite | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setInvite(storedInvite()), [publicKey]);
  const pending = invite?.state === "pending" ? invite.referrer : null;
  // An invite name (an X handle) is looked up to find its wallet.
  const referrer = useLoader(() => (pending && KEEPER_URL ? resolveReferrer(pending) : Promise.resolve(null)), [pending ?? ""]).data ?? null;
  if (!KEEPER_URL || !invite || invite.state !== "pending" || !publicKey || !signer || !referrer) return null;
  if (referrer.wallet === publicKey.toBase58()) return null;
  const finish = (state: StoredInvite["state"]) => {
    setInviteState(state);
    setInvite(storedInvite());
  };
  const accept = async () => {
    setBusy(true);
    try {
      await acceptInvite(signer, referrer.wallet);
      track("Invite accepted");
      pushToast("Invite accepted. Welcome to Veiling!");
      finish("done");
    } catch (e) {
      const message = errorMessage(e);
      pushToast(message);
      // Only a wallet that cannot join this way stops asking; a cancelled signature can try again.
      if (/already used Veiling|yourself/.test(message)) finish("done");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="invite-banner" role="status">
      <Avatar address={referrer.wallet} size={30} />
      <p>
        <strong>{referrer.handle ? `@${referrer.handle}` : shortAddress(referrer.wallet)}</strong> invited you to Veiling.
        Accept to give them credit: it is a free signature, not a transaction.
      </p>
      <div className="invite-banner__actions">
        <button type="button" className="btn btn--primary" onClick={accept} disabled={busy}>
          {busy ? "Waiting for your wallet…" : "Accept invite"}
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => finish("dismissed")}>
          No thanks
        </button>
      </div>
    </div>
  );
}
