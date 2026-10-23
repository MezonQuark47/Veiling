import { Transaction } from "@solana/web3.js";
import { closeNoteInstruction, fetchBidNotes, fetchLeftoverNotes, restoreNotes } from "../lib/bidNotes";
import type { Bid } from "../lib/chain";
import { formatSol, plural } from "../lib/format";
import { readNote } from "../lib/notes";
import { sendTransactions } from "../lib/tx";
import { useWallet } from "../lib/wallet";
import { Button, Notice, useAction, useLoader } from "./ui";

/** Notes closed per transaction when giving back leftover rent. */
const CLOSES_PER_TX = 8;

/**
 * Offers to show the details of the wallet's bids that this browser has no
 * note for but that have one stored on chain, for example when bidding
 * happened on another device. The wallet signs once to make the key.
 */
export function NoteUnlock({ bids, onOpened }: { bids: Bid[]; onOpened: () => void }) {
  const { publicKey, signer } = useWallet();
  // Its one message explains a failure, so it stays in place.
  const action = useAction({ toast: false });
  const mine = publicKey ? bids.filter((b) => b.bidder.equals(publicKey)) : [];
  const missing = mine.filter((b) => !readNote(b.address));
  const ids = missing.map((b) => b.address.toBase58()).join(",");
  const stored = useLoader(
    async () => (missing.length > 0 ? (await fetchBidNotes(missing.map((b) => b.address))).size : 0),
    [ids]
  );
  if (!publicKey || missing.length === 0 || !stored.data) {
    return action.done ? <Notice tone="info">{action.done}</Notice> : null;
  }
  const open = () =>
    action.run("open-notes", async () => {
      if (!signer) throw new Error("Connect a wallet first");
      const opened = await restoreNotes(signer, missing);
      onOpened();
      if (opened === 0) {
        return "These notes do not open with this wallet's signature. Wallets that sign differently each time cannot read them back.";
      }
    });
  return (
    <div className="notes-unlock">
      <p>
        {plural(stored.data, "bid")} of yours {stored.data === 1 ? "has its" : "have their"} price and size saved on
        chain, encrypted so that only this wallet can read {stored.data === 1 ? "it" : "them"}. Sign with your wallet
        to show {stored.data === 1 ? "it" : "them"} here. Signing costs nothing.
      </p>
      <Button onClick={open} busy={action.busy === "open-notes"} disabled={!signer}>
        Show my bid details
      </Button>
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
    </div>
  );
}

/**
 * Notes of bids that are gone, such as bids replaced in a full auction, still
 * hold a little rent. This gives it back to the wallet.
 */
export function LeftoverNotes() {
  const { publicKey, signer } = useWallet();
  const action = useAction();
  const left = useLoader(async () => (publicKey ? fetchLeftoverNotes(publicKey) : []), [publicKey?.toBase58()]);
  const notes = left.data ?? [];
  if (!publicKey || notes.length === 0) return null;
  const lamports = BigInt(notes.reduce((sum, n) => sum + n.lamports, 0));
  const reclaim = () =>
    action.run("reclaim-notes", async () => {
      if (!signer) throw new Error("Connect a wallet first");
      const txs: Transaction[] = [];
      for (let i = 0; i < notes.length; i += CLOSES_PER_TX) {
        const tx = new Transaction();
        for (const n of notes.slice(i, i + CLOSES_PER_TX)) {
          tx.add(await closeNoteInstruction(signer.publicKey, signer.publicKey, n.bid));
        }
        txs.push(tx);
      }
      await sendTransactions(txs, signer);
      left.reload();
      return `${formatSol(lamports)} SOL came back from the notes of closed bids.`;
    });
  return (
    <div className="notes-unlock">
      <p>
        {plural(notes.length, "note")} of bids that are closed still {notes.length === 1 ? "holds" : "hold"}{" "}
        {formatSol(lamports)} SOL of rent.
      </p>
      <Button onClick={reclaim} busy={action.busy === "reclaim-notes"} disabled={!signer}>
        Get it back
      </Button>
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
    </div>
  );
}
