// Browser stand-in for the parts of Node's `crypto` that @arcium-hq/client
// uses: secure random bytes and SHA-256 (via @noble/hashes, audited).
// AES helpers from that package are not used by this app and stay disabled.
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { sha3_256 } from "@noble/hashes/sha3";

export function randomBytes(size: number): Buffer {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes);
}

type Hasher = { update(data: Uint8Array): unknown; digest(): Uint8Array };

export function createHash(algorithm: string) {
  let hasher: Hasher;
  if (algorithm === "sha256") hasher = sha256.create();
  else if (algorithm === "sha3-256") hasher = sha3_256.create();
  else throw new Error(`Hash ${algorithm} is not available in the browser`);
  return {
    update(data: Uint8Array | string) {
      hasher.update(typeof data === "string" ? new TextEncoder().encode(data) : data);
      return this;
    },
    digest(encoding?: "hex") {
      const out = Buffer.from(hasher.digest());
      return encoding === "hex" ? out.toString("hex") : out;
    },
  };
}

export function createCipheriv(): never {
  throw new Error("AES is not available in the browser build");
}

export const createDecipheriv = createCipheriv;

export default { randomBytes, createHash, createCipheriv, createDecipheriv };
