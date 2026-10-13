// Must be imported before anything else: @solana/web3.js and Anchor expect
// Node's Buffer and a `process` object to exist at module load time.
import { Buffer } from "buffer";

const g = globalThis as unknown as Record<string, unknown>;
if (!g.Buffer) g.Buffer = Buffer;
if (!g.process) g.process = { env: {} };
