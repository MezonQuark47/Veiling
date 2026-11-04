// The app's code asks fetch for browser-only options (no cookies, no
// referrer). Cloudflare's runtime sends neither anyway and rejects some of
// these options, so they are dropped here, before the app's code loads.
//
// The public Solana RPC turns away requests from Cloudflare's network, so
// the app's requests to it go to the worker's own RPC (the RPC_URL secret)
// when one is set.
//
// It imports nothing, so it runs before @solana/web3.js keeps its own copy of fetch.

/** Solana's public RPC, the app's default. */
const PUBLIC_RPC = /^https:\/\/api\.(devnet|testnet|mainnet-beta)\.solana\.com\/?$/;

const original = globalThis.fetch.bind(globalThis);
let rpc: string | null = null;

/** The RPC the worker reads the chain from; null keeps the app's own. */
export function useRpc(url: string | undefined) {
  rpc = url?.trim() || null;
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const target = rpc && typeof input === "string" && PUBLIC_RPC.test(input) ? rpc : input;
  if (!init) return original(target);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { credentials, referrerPolicy, mode, ...rest } = init;
  return original(target, rest);
}) as typeof fetch;
