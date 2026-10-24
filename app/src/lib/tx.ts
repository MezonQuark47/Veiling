import { SendTransactionError, Transaction, type Keypair, type PublicKey } from "@solana/web3.js";
import idl from "../idl/sealed_auction.json";
import { NETWORK_LABEL } from "../config";
import { connection } from "./chain";

/** What the app needs from a connected wallet. */
export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
  /** Signs several transactions with one approval, for wallets that can. */
  signTransactions?(txs: Transaction[]): Promise<Transaction[]>;
  /** Signs a message, for wallets that can: returns what was signed and the signature. */
  signMessage?(message: Uint8Array): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }>;
}

/**
 * Signs with the wallet first, then with any extra signers (such as a fresh
 * mint keypair), sends, and waits for confirmation.
 */
export async function sendTransaction(
  tx: Transaction,
  wallet: WalletSigner,
  extraSigners: Keypair[] = []
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = blockhash;

  // Simulate before asking for a signature so obvious failures surface here
  // with a readable reason instead of in the wallet.
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) {
    throw new Error(explainLogs(simulation.value.logs) ?? `Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  const signed = await wallet.signTransaction(tx);
  if (extraSigners.length > 0) signed.partialSign(...extraSigners);

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(signed.serialize(), {
      preflightCommitment: "confirmed",
    });
  } catch (e) {
    if (e instanceof SendTransactionError) {
      const logs = await e.getLogs(connection).catch(() => null);
      throw new Error(explainLogs(logs ?? undefined) ?? e.message);
    }
    throw e;
  }
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  return signature;
}

const EXPIRED = /blockhash not found|block height exceeded|expired/i;

async function sendSigned(signed: Transaction, blockhash: string, lastValidBlockHeight: number): Promise<string> {
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
  } catch (e) {
    if (e instanceof SendTransactionError) {
      const logs = await e.getLogs(connection).catch(() => null);
      throw new Error(explainLogs(logs ?? undefined) ?? e.message);
    }
    throw e;
  }
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  return signature;
}

/**
 * Sends transactions that must land in order, each confirmed before the
 * next, such as an item list and then the auction that seals it. A wallet
 * that can approves them all at once; only the first is simulated, since the
 * others depend on the ones before them. Should the batch outlive its
 * blockhash, the rest is signed again. Returns the signatures.
 */
export async function sendTransactions(
  txs: Transaction[],
  wallet: WalletSigner,
  onSent?: (done: number, total: number) => void
): Promise<string[]> {
  const signatures: string[] = [];
  const report = () => onSent?.(signatures.length, txs.length);
  if (!wallet.signTransactions || txs.length === 1) {
    for (const tx of txs) {
      signatures.push(await sendTransaction(tx, wallet));
      report();
    }
    return signatures;
  }
  let retried = false;
  while (signatures.length < txs.length) {
    const rest = txs.slice(signatures.length);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    for (const tx of rest) {
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = blockhash;
      tx.signatures = [];
    }
    const simulation = await connection.simulateTransaction(rest[0]);
    if (simulation.value.err) {
      throw new Error(explainLogs(simulation.value.logs) ?? `Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    let signed: Transaction[];
    try {
      signed = await wallet.signTransactions(rest);
      if (signed.length !== rest.length) throw new Error("The wallet did not sign every transaction.");
    } catch (e) {
      // A cancelled prompt stops here; a wallet that cannot sign several at
      // once gets them one at a time instead.
      if (/User rejected|rejected the request|cancel/i.test(errorMessage(e))) throw e;
      for (const tx of rest) {
        signatures.push(await sendTransaction(tx, wallet));
        report();
      }
      return signatures;
    }
    try {
      for (const tx of signed) {
        signatures.push(await sendSigned(tx, blockhash, lastValidBlockHeight));
        report();
      }
    } catch (e) {
      if (retried || !(e instanceof Error) || !EXPIRED.test(e.message)) throw e;
      retried = true;
    }
  }
  return signatures;
}

const programErrors = new Map<number, string>(
  (idl as { errors?: { code: number; msg?: string; name: string }[] }).errors?.map((e) => [
    e.code,
    e.msg ?? e.name,
  ]) ?? []
);

/** Turns program logs into the most useful single-line reason. */
export function explainLogs(logs: string[] | null | undefined): string | null {
  if (!logs) return null;
  for (const line of logs) {
    const anchor = line.match(/Error Message: (.*?)\.?$/);
    if (anchor) return anchor[1];
  }
  // A transfer the wallet cannot cover fails in the system program, whose
  // error codes are not the program's.
  for (const line of logs) {
    if (/insufficient (funds|lamports)/i.test(line)) return NOT_ENOUGH_SOL;
  }
  for (const line of logs) {
    const custom = line.match(/custom program error: 0x([0-9a-f]+)/i);
    if (custom) {
      const code = parseInt(custom[1], 16);
      return programErrors.get(code) ?? `Program error ${code}`;
    }
  }
  return null;
}

/** The usual reason a wallet cannot pay, with the test network's way out. */
const NOT_ENOUGH_SOL = NETWORK_LABEL
  ? `Your wallet does not have enough SOL on ${NETWORK_LABEL} for this. Make sure your wallet is set to ${NETWORK_LABEL}; free test SOL is at faucet.solana.com.`
  : "Your wallet does not have enough SOL for this. Add SOL and try again.";

/** Plain English for the failures people meet most; anything else as it came. */
const FRIENDLY: [RegExp, string][] = [
  [/User rejected|rejected the request|user denied/i, "You cancelled the request in your wallet."],
  [/AccountNotFound|InsufficientFundsFor(Fee|Rent)|insufficient (funds|lamports)|no record of a prior credit/i, NOT_ENOUGH_SOL],
  [/BlockhashNotFound|Blockhash not found|block height exceeded|has expired/i, "The transaction took too long and expired. Please try again."],
  [
    /Failed to fetch|NetworkError|fetch failed|ECONNREFUSED|429|Too Many Requests|timed? ?out/i,
    "The Solana network could not be reached. Check your connection and try again in a moment.",
  ],
];

export function errorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  for (const [pattern, text] of FRIENDLY) if (pattern.test(message)) return text;
  return message;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls `read` until `done` holds, for MPC results that arrive by callback. */
export async function waitUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 240_000,
  intervalMs = 3_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error("Arcium has not answered yet. It may still finish; refresh in a few minutes.");
    }
    await sleep(intervalMs);
  }
}
