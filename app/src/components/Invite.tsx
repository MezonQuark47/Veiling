import { KEEPER_URL, PROJECT_X_HANDLE } from "../config";
import { track } from "../lib/analytics";
import { formatCount } from "../lib/format";
import { inviteLink } from "../lib/keeper";
import type { WalletView } from "../lib/stats";
import { pushToast } from "./ui";

/** A wallet's invite link, with what its invites have earned so far. */
export function InviteCard({ wallet, view }: { wallet: string; view: WalletView | null }) {
  if (!KEEPER_URL) return null;
  const link = inviteLink(wallet);
  const invites = view?.invites ?? { joined: 0, active: 0, points: 0 };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      pushToast("Invite link copied");
      track("Invite link copied");
    } catch {
      pushToast("Could not copy. Select the link and copy it.");
    }
  };
  const text = `I'm testing @${PROJECT_X_HANDLE}: sealed-bid launches on Solana where every winner pays one fair price. Join with my invite:`;
  const post = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
  return (
    <div className="invite-card">
      <div className="invite-card__text">
        <h2 className="invite-card__title">Invite friends</h2>
        <p className="muted">
          When someone joins with your link and wins in a sale, you earn points, plus a share of the points they earn
          buying.
        </p>
        <div className="invite-card__link">
          <input readOnly value={link} aria-label="Your invite link" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn btn--primary" onClick={copy}>
            Copy link
          </button>
          <a className="btn btn--secondary" href={post} target="_blank" rel="noreferrer noopener">
            Post on X
          </a>
        </div>
      </div>
      <dl className="invite-card__stats">
        <div>
          <dt>Joined</dt>
          <dd>{formatCount(invites.joined)}</dd>
        </div>
        <div>
          <dt>Won a sale</dt>
          <dd>{formatCount(invites.active)}</dd>
        </div>
        <div>
          <dt>Points earned</dt>
          <dd>{formatCount(invites.points)}</dd>
        </div>
      </dl>
    </div>
  );
}
