import { useState } from "react";
import { KEEPER_URL, PROJECT_X_HANDLE, SEASON } from "../config";
import { track } from "../lib/analytics";
import { formatCount } from "../lib/format";
import { claimHandle, handleCode, inviteLink, isHandle } from "../lib/keeper";
import type { WalletView } from "../lib/stats";
import { useWallet } from "../lib/wallet";
import { Button, Notice, pushToast, useAction } from "./ui";

/** What an invite post says; the link carries the inviter's X name or wallet. */
const inviteText = (link: string, code?: string) =>
  [
    `I'm playing ${SEASON?.name ?? "on"} ${SEASON ? "on " : ""}@${PROJECT_X_HANDLE}: sealed-bid launches on Solana where every winner pays one fair price.`,
    "",
    `Join with my invite: ${link}`,
    ...(code ? ["", code] : []),
  ].join("\n");

const intent = (text: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

/**
 * Makes the invite link end in the wallet's X name: one post from the
 * account (which is also the first invite) carries a code only this wallet
 * and account give, then a free signature links them.
 */
function XName({ wallet, onLinked }: { wallet: string; onLinked: () => void }) {
  const { signer } = useWallet();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [postUrl, setPostUrl] = useState("");
  const handle = name.trim().replace(/^@/, "");
  const valid = isHandle(handle);
  const code = valid ? handleCode(wallet, handle) : null;
  const postValid = /^https:\/\/(www\.)?(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/.test(postUrl.trim());
  const link = () =>
    action.run("handle", async () => {
      if (!signer) throw new Error("Connect your wallet first.");
      const result = await claimHandle(signer, postUrl);
      onLinked();
      return <>Done. Your invite link now ends in {result.handle}.</>;
    });
  if (!open) {
    return (
      <button type="button" className="linkish invite-card__claim" onClick={() => setOpen(true)}>
        Put your X name in the link instead
      </button>
    );
  }
  return (
    <ol className="invite-name">
      <li>
        <label htmlFor="invite-handle">Your X username</label>
        <div className="invite-name__row">
          <span className="invite-name__at">@</span>
          <input
            id="invite-handle"
            value={name}
            onChange={(e) => setName(e.target.value.replace(/\s/g, ""))}
            placeholder="yourname"
            maxLength={16}
            aria-invalid={name !== "" && !valid}
          />
        </div>
      </li>
      <li>
        <span>
          <strong>Post your invite from that account.</strong> It carries your code{code ? <> (<code>{code}</code>)</> : null},
          which proves the account is yours.
        </span>
        <a
          className={`btn btn--secondary${valid ? "" : " is-disabled"}`}
          href={valid ? intent(inviteText(inviteLink(handle), code!)) : undefined}
          aria-disabled={!valid}
          target="_blank"
          rel="noreferrer noopener"
        >
          Post my invite on X
        </a>
      </li>
      <li>
        <label htmlFor="invite-post">Paste the post's link, and sign</label>
        <input
          id="invite-post"
          value={postUrl}
          onChange={(e) => setPostUrl(e.target.value)}
          placeholder="https://x.com/yourname/status/…"
          aria-invalid={postUrl !== "" && !postValid}
        />
        <Button variant="primary" onClick={link} busy={action.busy === "handle"} disabled={!postValid || !signer}>
          Link my X account
        </Button>
        <span className="hint">A free signature, not a transaction.</span>
      </li>
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      {action.done ? <Notice tone="success">{action.done}</Notice> : null}
    </ol>
  );
}

/** A wallet's invite link, with what its invites have earned so far. */
export function InviteCard({ wallet, view, onChanged }: { wallet: string; view: WalletView | null; onChanged?: () => void }) {
  if (!KEEPER_URL) return null;
  const handle = view?.handle ?? null;
  const link = inviteLink(handle ?? wallet);
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
  return (
    <div className="invite-card">
      <div className="invite-card__text">
        <h2 className="invite-card__title">Invite friends</h2>
        <p className="muted">
          When someone joins with your link and wins in a sale, you earn points, plus a share of the points they earn
          buying. Shared on X, the link shows a Veiling card.
        </p>
        <div className="invite-card__link">
          <input readOnly value={link} aria-label="Your invite link" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn btn--primary" onClick={copy}>
            Copy link
          </button>
          <a className="btn btn--secondary" href={intent(inviteText(link))} target="_blank" rel="noreferrer noopener">
            Post on X
          </a>
        </div>
        {handle ? (
          <p className="hint invite-card__named">Your link uses your X name, @{handle}.</p>
        ) : (
          <XName wallet={wallet} onLinked={() => onChanged?.()} />
        )}
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
