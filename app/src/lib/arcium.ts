import { BN } from "@anchor-lang/core";
import type { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";
import {
  RescueCipher,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  getMempoolAccAddress,
  x25519,
} from "@arcium-hq/client";
import { BID_NONCE_DOMAIN, CLUSTER_OFFSET, MXE_X25519_PUBLIC_KEY, PROGRAM_ID } from "../config";
import { provider } from "./chain";

/** The circuits this program runs; see `encrypted-ixs`. */
export type Circuit = "check_bids_v2" | "clear_price_v2" | "award_bid_v2" | "draw_seed";

/** Accounts every instruction that queues an MPC computation needs. */
export function computationAccounts(circuit: Circuit, computationOffset: BN) {
  return {
    computationAccount: getComputationAccAddress(CLUSTER_OFFSET, computationOffset),
    clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
    mxeAccount: getMXEAccAddress(PROGRAM_ID),
    mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
    executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
    compDefAccount: getCompDefAccAddress(PROGRAM_ID, compDefOffset(circuit)),
  };
}

function compDefOffset(circuit: Circuit): number {
  const bytes = getCompDefAccOffset(circuit);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

export function newComputationOffset(): BN {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return new BN(bytes, "le");
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

let mxeKey: Promise<Uint8Array> | null = null;

/**
 * The MXE's x25519 public key, which bids are encrypted to. It must match the
 * pinned key in config.ts; otherwise bidding stops rather than encrypting to
 * a key nobody vetted.
 */
export function getMxeKey(): Promise<Uint8Array> {
  if (!mxeKey) {
    mxeKey = getMXEPublicKey(provider, PROGRAM_ID)
      .then((key) => {
        if (!key) throw new Error("The private compute network for this program is not ready yet");
        if (MXE_X25519_PUBLIC_KEY && toHex(key) !== MXE_X25519_PUBLIC_KEY.toLowerCase()) {
          throw new Error(
            "The network's encryption key does not match the one this app trusts, so bidding is paused. " +
              "Try another RPC or check back later."
          );
        }
        if (!MXE_X25519_PUBLIC_KEY) console.warn("MXE_X25519_PUBLIC_KEY is not pinned in config.ts");
        return key;
      })
      .catch((e) => {
        mxeKey = null;
        throw e;
      });
  }
  return mxeKey;
}

/**
 * The nonce the program requires for a bid stored at `bid`: the first 16 bytes
 * of sha256(domain || bid address). Binding the nonce to the address means a
 * copied ciphertext decrypts to noise anywhere else.
 */
export function bidNonce(bid: PublicKey): Uint8Array {
  const domain = new TextEncoder().encode(BID_NONCE_DOMAIN);
  const input = new Uint8Array(domain.length + 32);
  input.set(domain, 0);
  input.set(bid.toBytes(), domain.length);
  return sha256(input).slice(0, 16);
}

const FIELD_MODULUS = (1n << 255n) - 19n;

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function bigIntToBytesLE(value: bigint): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    out.push(Number(value & 0xffn));
    value >>= 8n;
  }
  return out;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  base %= modulus;
  for (; exponent > 0n; exponent >>= 1n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
  }
  return result;
}

/**
 * The Edwards y-coordinate (u - 1) / (u + 1) of an x25519 public key. The
 * program uses it to check the key exactly as Arcium's nodes do, without
 * computing an inverse on chain.
 */
export function edwardsY(publicKey: Uint8Array): number[] {
  const p = FIELD_MODULUS;
  const u = bytesToBigIntLE(publicKey) % p;
  const inverse = modPow((u + 1n) % p, p - 2n, p);
  return bigIntToBytesLE((((u - 1n + p) % p) * inverse) % p);
}

export interface EncryptedBid {
  priceCiphertext: number[];
  quantityCiphertext: number[];
  clientPublicKey: number[];
  clientPublicKeyEdwardsY: number[];
  nonce: BN;
}

/**
 * Encrypts `{ price, quantity }` in the browser so that only Arcium's MPC
 * cluster, working together, can read it. `price` is in the auction's price
 * ticks; `quantity` is a token bid's budget in lamports, or a collection
 * bid's number of NFTs. A fresh key pair is used for every bid and the secret
 * never leaves this function.
 */
export async function encryptBid(price: bigint, quantity: bigint, bid: PublicKey): Promise<EncryptedBid> {
  if (price < 1n || price > 0xffff_ffffn) throw new Error("The price is out of range");
  if (quantity < 1n || quantity > 0xffff_ffff_ffff_ffffn) throw new Error("The size is out of range");
  const mxePublicKey = await getMxeKey();
  const secret = x25519.utils.randomSecretKey();
  const clientPublicKey = x25519.getPublicKey(secret);
  const cipher = new RescueCipher(x25519.getSharedSecret(secret, mxePublicKey));
  const nonceBytes = bidNonce(bid);
  const [priceCiphertext, quantityCiphertext] = cipher.encrypt([price, quantity], nonceBytes);
  secret.fill(0);
  return {
    priceCiphertext: Array.from(priceCiphertext),
    quantityCiphertext: Array.from(quantityCiphertext),
    clientPublicKey: Array.from(clientPublicKey),
    clientPublicKeyEdwardsY: edwardsY(clientPublicKey),
    nonce: new BN(nonceBytes, "le"),
  };
}
