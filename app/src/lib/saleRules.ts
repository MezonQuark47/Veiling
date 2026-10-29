import { PublicKey, Transaction } from "@solana/web3.js";
import { saleRulesInstructions } from "./actions";
import { allowlistRoot, MAX_ALLOWLIST, parseWallets, publishAllowlist } from "./allowlist";
import { freeTarget } from "./arweave";
import { formatCount, formatSol, parseDecimal } from "./format";

/** Who may bid in a new sale, as the launch forms ask it. */
export interface BidAccess {
  /** Only the wallets on a list. */
  listed: boolean;
  /** The list as typed or pasted: addresses split by lines, commas or spaces. */
  text: string;
  /** The most one wallet may deposit across its bids, in SOL; empty for no cap. */
  cap: string;
}

export const OPEN_TO_ANYONE: BidAccess = { listed: false, text: "", cap: "" };

/** What a `BidAccess` comes to: the wallets, the cap in lamports and what is wrong. */
export interface AccessPlan {
  wallets: PublicKey[];
  invalid: string[];
  walletCap: bigint;
  problem: string | null;
}

/** `minDeposit`: the smallest bid's deposit, in lamports, which a cap must allow. */
export function accessPlan(access: BidAccess, minDeposit: bigint): AccessPlan {
  if (!access.listed) return { wallets: [], invalid: [], walletCap: 0n, problem: null };
  const { wallets, invalid } = parseWallets(access.text);
  const capText = access.cap.trim();
  const cap = capText === "" ? 0n : parseDecimal(capText, 9);
  let problem: string | null = null;
  if (wallets.length === 0) problem = "Add the wallets that may bid, or let anyone bid.";
  else if (invalid.length > 0)
    problem = `${formatCount(invalid.length)} ${invalid.length === 1 ? "entry is not a" : "entries are not"} Solana address: ${invalid[0]}`;
  else if (wallets.length > MAX_ALLOWLIST) problem = `A list holds at most ${formatCount(MAX_ALLOWLIST)} wallets.`;
  else if (cap === null) problem = "Enter the most per wallet in SOL, or leave it empty.";
  else if (cap > 0n && cap < minDeposit) problem = `The most per wallet must be at least the smallest bid, ${formatSol(minDeposit)} SOL.`;
  return { wallets, invalid, walletCap: cap ?? 0n, problem };
}

/** The largest transaction Solana takes, in bytes. */
const MAX_TX_BYTES = 1232;

function fits(tx: Transaction, payer: PublicKey): boolean {
  const probe = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() });
  probe.add(...tx.instructions);
  try {
    const message = probe.compileMessage();
    const signers = message.header.numRequiredSignatures;
    return 1 + signers * 64 + message.serialize().length <= MAX_TX_BYTES;
  } catch {
    return false;
  }
}

/**
 * Publishes a sale's list and adds the rules to the transaction that opens
 * it, so nobody can bid before they apply. Returns the transactions to send
 * in order: just `open`, or `open` and then the rules when they do not fit
 * in it.
 */
export async function withSaleRules(
  open: Transaction,
  seller: PublicKey,
  auction: PublicKey,
  plan: AccessPlan
): Promise<Transaction[]> {
  if (plan.wallets.length === 0) return [open];
  const uri = await publishAllowlist(plan.wallets, freeTarget());
  const rules = await saleRulesInstructions(seller, auction, {
    walletCap: plan.walletCap,
    root: allowlistRoot(plan.wallets),
    uri,
  });
  const together = new Transaction().add(...open.instructions, ...rules);
  return fits(together, seller) ? [together] : [open, new Transaction().add(...rules)];
}
