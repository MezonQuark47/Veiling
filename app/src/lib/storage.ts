// Paid storage on Arweave through ArDrive Turbo.
//
// Turbo sells storage as credit. A seller buys it with SOL: one transfer from
// their wallet to Turbo's address, with a memo naming the account to credit.
// That account is the seller's upload key, made from a message their wallet
// signs, so the same wallet always gets the same key and credit left over is
// there for their next upload. The key can only sign uploads and spend that
// credit; it holds no SOL and cannot touch the wallet.
import { Buffer } from "buffer";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { PAID_STORAGE, STORAGE_PRICE_MARGIN_PERCENT } from "../config";
import { connection } from "./chain";
import { type WalletSigner, sendTransaction, sleep } from "./tx";

const GIB = 1n << 30n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const REQUEST_TIMEOUT_MS = 15_000;
/** How long Turbo gets to count a payment before the seller is told to come back. */
const CREDIT_TIMEOUT_MS = 180_000;
/** A payment not yet counted blocks another one for this long, so nobody pays twice. */
const PENDING_PAYMENT_MS = 60 * 60 * 1000;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Turbo's prices: credit per GiB and per file, and what SOL and dollars buy. */
export type StorageRates = {
  /** Credit (winc) to store one GiB. */
  wincPerGiB: bigint;
  /** Credit charged per file on top of its size. */
  wincPerItem: bigint;
  /** What one GiB costs in US dollars, Turbo's fee included; NaN if not given. */
  usdPerGiB: number;
  /** Credit one SOL buys, Turbo's fee included. */
  wincPerSol: bigint;
  /** When the prices were read (ms since 1970). */
  at: number;
};

/** What storing a set of files costs: the credit it takes, and what a seller with no credit pays for it. */
export type Quote = {
  /** Credit the files take. */
  winc: bigint;
  /** What buying that credit costs, with the margin for price moves. */
  lamports: bigint;
  /** The same in US dollars, or null if Turbo gave no dollar price. */
  usd: number | null;
  bytes: number;
  files: number;
};

const request = (path: string, init: RequestInit = {}) =>
  fetch(`${PAID_STORAGE.paymentUrl}${path}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init,
  });

async function getJson(path: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await request(path);
  } catch {
    throw new Error("The storage service could not be reached. Check your connection and try again.");
  }
  if (!response.ok) throw new Error(`The storage service answered ${response.status}. Try again in a minute.`);
  return (await response.json()) as Record<string, unknown>;
}

function credit(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,40}$/.test(value)) {
    throw new Error("The storage service sent a price this app cannot read.");
  }
  return BigInt(value);
}

/** Reads Turbo's current prices. */
export async function fetchStorageRates(): Promise<StorageRates> {
  const [rates, sol] = await Promise.all([getJson("/v1/rates"), getJson(`/v1/price/solana/${LAMPORTS_PER_SOL}`)]);
  const fiat = rates.fiat as Record<string, unknown> | undefined;
  const result: StorageRates = {
    wincPerGiB: credit(rates.winc),
    wincPerItem: rates.perDataItemFeeWinc === undefined ? 0n : credit(rates.perDataItemFeeWinc),
    usdPerGiB: typeof fiat?.usd === "number" ? fiat.usd : NaN,
    wincPerSol: credit(sol.winc),
    at: Date.now(),
  };
  if (result.wincPerGiB === 0n || result.wincPerSol === 0n) throw new Error("The storage service sent a price this app cannot read.");
  return result;
}

/** `winc` with the margin for price moves added. */
const withMargin = (winc: bigint) => ceilDiv(winc * (100n + STORAGE_PRICE_MARGIN_PERCENT), 100n);

/** Lamports that buy at least `winc` of credit, plus the margin for price moves. */
export function paymentFor(winc: bigint, rates: StorageRates): bigint {
  return ceilDiv(withMargin(winc) * LAMPORTS_PER_SOL, rates.wincPerSol);
}

/** Credit that files of these sizes (signed upload sizes, in bytes) take. */
export function creditFor(sizes: number[], rates: StorageRates): bigint {
  let winc = 0n;
  for (const size of sizes) winc += ceilDiv(BigInt(size) * rates.wincPerGiB, GIB) + rates.wincPerItem;
  return winc;
}

/** Credit that `files` files of `bytes` in all take at most, when their sizes one by one are not known. */
export function creditForTotal(bytes: number, files: number, rates: StorageRates): bigint {
  // Rounding each file up costs at most one winc per file.
  return ceilDiv(BigInt(bytes) * rates.wincPerGiB, GIB) + BigInt(files) * (rates.wincPerItem + 1n);
}

/** What storing files of these sizes costs. */
export function quoteStorage(sizes: number[], rates: StorageRates): Quote {
  const winc = creditFor(sizes, rates);
  const usd = Number.isFinite(rates.usdPerGiB)
    ? (Number(withMargin(winc)) / Number(rates.wincPerGiB)) * rates.usdPerGiB
    : null;
  return { winc, lamports: paymentFor(winc, rates), usd, bytes: sizes.reduce((sum, size) => sum + size, 0), files: sizes.length };
}

/** The message a wallet signs to make its upload key. */
export function uploadKeyMessage(wallet: PublicKey): Uint8Array {
  return utf8ToBytes(
    "Veiling upload key\n\n" +
      "Sign to let this site upload your art to Arweave and pay for it from storage credit you buy. " +
      "Signing costs nothing and cannot move anything from your wallet.\n\n" +
      `Wallet: ${wallet.toBase58()}`
  );
}

const signatures = new Map<string, Uint8Array>();

/**
 * The wallet's signature of the upload-key message. Solana wallets sign
 * deterministically, so it is the same every time, and the keys made from it
 * are too. Asks the wallet once per page.
 */
export async function walletSignature(signer: WalletSigner): Promise<Uint8Array> {
  const id = signer.publicKey.toBase58();
  const known = signatures.get(id);
  if (known) return known;
  if (!signer.signMessage) {
    throw new Error("This wallet cannot sign messages, which this needs. Use another wallet.");
  }
  const { signedMessage, signature } = await signer.signMessage(uploadKeyMessage(signer.publicKey));
  if (!ed25519.verify(signature, signedMessage, signer.publicKey.toBytes())) {
    throw new Error("The wallet's signature did not check out, so no key was made.");
  }
  signatures.set(id, signature);
  return signature;
}

/**
 * The wallet's upload key: an ed25519 seed made from the wallet's signature
 * of a fixed message, so the same wallet always gets the same key.
 */
export async function walletUploadKey(signer: WalletSigner): Promise<Uint8Array> {
  return sha256(concatBytes(utf8ToBytes("veiling/upload-key/v1"), await walletSignature(signer)));
}

/** The Solana-style address Turbo keeps a key's credit under. */
export const keyAddress = (key: Uint8Array): string => new PublicKey(ed25519.getPublicKey(key)).toBase58();

/** Credit an address holds on Turbo. */
export async function fetchCredit(address: string): Promise<bigint> {
  let response: Response;
  try {
    response = await request(`/v1/account/balance/solana?address=${encodeURIComponent(address)}`);
  } catch {
    throw new Error("The storage service could not be reached. Check your connection and try again.");
  }
  if (response.status === 404) return 0n;
  if (!response.ok) throw new Error(`The storage service answered ${response.status}. Try again in a minute.`);
  const body = (await response.json()) as { winc?: unknown; effectiveBalance?: unknown };
  return credit(body.effectiveBalance ?? body.winc);
}

/** Turbo's Solana address, once the service confirms it is the one this app knows. */
async function paymentAddress(): Promise<PublicKey> {
  const info = await getJson("/v1/info");
  const addresses = info.addresses as Record<string, unknown> | undefined;
  if (addresses?.solana !== PAID_STORAGE.paymentAddress) {
    throw new Error("The storage service gave a payment address this app does not know, so nothing was paid.");
  }
  return new PublicKey(PAID_STORAGE.paymentAddress);
}

/** A transfer of `lamports` to Turbo, crediting `creditAddress` (Turbo reads the memo). */
export function buildStoragePayment(payer: PublicKey, to: PublicKey, lamports: bigint, creditAddress: string): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(`turboCreditDestinationAddress=${creditAddress}`, "utf8"),
    })
  );
}

type PaymentState = "credited" | "pending" | "unseen";

/** Tells Turbo about a payment. */
async function registerPayment(signature: string): Promise<PaymentState> {
  let response: Response;
  try {
    response = await fetch(`${PAID_STORAGE.paymentUrl}/v1/account/balance/solana`, {
      method: "POST",
      // Sent as bytes with no content type, as Turbo's own SDK does.
      body: Uint8Array.from(utf8ToBytes(JSON.stringify({ tx_id: signature }))),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return "unseen";
  }
  if (!response.ok) return "unseen";
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && "creditedTransaction" in body) return "credited";
  if (body && "pendingTransaction" in body) return "pending";
  if (body && "failedTransaction" in body) {
    throw new Error("The storage service could not use this payment. Contact Turbo's support with its transaction id: " + signature);
  }
  return "unseen";
}

// Payments sent but not yet counted, kept in this browser so that one sent
// just before the page closed is still counted, and is not paid again.
const PAYMENTS_KEY = "veiling.storage.payments";
type SentPayment = { signature: string; address: string; at: number };

function sentPayments(): SentPayment[] {
  try {
    const list = JSON.parse(localStorage.getItem(PAYMENTS_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? (list as SentPayment[]).filter((p) => typeof p?.signature === "string") : [];
  } catch {
    return [];
  }
}

function keepSentPayments(list: SentPayment[]) {
  try {
    if (list.length > 0) localStorage.setItem(PAYMENTS_KEY, JSON.stringify(list));
    else localStorage.removeItem(PAYMENTS_KEY);
  } catch {
    // Storage can be unavailable (private mode); the payment is still counted while the page stays open.
  }
}

const forgetPayment = (signature: string) => keepSentPayments(sentPayments().filter((p) => p.signature !== signature));

async function waitForFinality(signature: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(`The storage payment failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "finalized") return;
    if (Date.now() > deadline) return;
    await sleep(2_000);
  }
}

export type CreditStep = "pay" | "confirm";

/**
 * Makes sure the upload key holds at least `needed` credit. If it does not,
 * the wallet pays the difference (plus a small margin) to Turbo, and this
 * waits until Turbo counts it.
 */
export async function ensureCredit(
  signer: WalletSigner,
  key: Uint8Array,
  needed: bigint,
  rates: StorageRates,
  onStep: (step: CreditStep) => void
): Promise<void> {
  const address = keyAddress(key);

  // First count anything paid earlier that Turbo has not counted yet.
  let waiting = false;
  for (const sent of sentPayments().filter((p) => p.address === address)) {
    const state = await registerPayment(sent.signature).catch(() => "credited" as const);
    if (state === "credited" || Date.now() - sent.at > PENDING_PAYMENT_MS) forgetPayment(sent.signature);
    else waiting = true;
  }
  let have = await fetchCredit(address);
  if (have >= needed) return;
  if (waiting) {
    throw new Error("Your last storage payment has not been counted yet. Try again in a few minutes; you will not pay twice.");
  }

  const lamports = paymentFor(needed - have, rates);
  const to = await paymentAddress();
  onStep("pay");
  const signature = await sendTransaction(buildStoragePayment(signer.publicKey, to, lamports, address), signer);
  keepSentPayments([...sentPayments(), { signature, address, at: Date.now() }]);

  onStep("confirm");
  await waitForFinality(signature);
  const deadline = Date.now() + CREDIT_TIMEOUT_MS;
  for (;;) {
    const state = await registerPayment(signature);
    have = await fetchCredit(address);
    if (have >= needed) {
      forgetPayment(signature);
      return;
    }
    if (state === "credited") {
      forgetPayment(signature);
      throw new Error("Prices moved while your payment went through, so the credit is a little short. Launch again to add the rest.");
    }
    if (Date.now() > deadline) {
      throw new Error("Turbo has not counted your storage payment yet. Try again in a few minutes; you will not pay twice.");
    }
    await sleep(4_000);
  }
}
