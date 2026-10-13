export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Lamports to a SOL string with at most `maxDecimals` decimals, trimmed. */
export function formatSol(lamports: bigint, maxDecimals = 4): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = abs % LAMPORTS_PER_SOL;
  let decimals = maxDecimals;
  // Very small amounts keep enough digits to stay non-zero.
  if (whole === 0n && frac > 0n) {
    const digits = frac.toString().padStart(9, "0");
    const firstNonZero = digits.search(/[1-9]/);
    decimals = Math.max(decimals, Math.min(9, firstNonZero + 2));
  }
  const fracStr = frac.toString().padStart(9, "0").slice(0, decimals).replace(/0+$/, "");
  const wholeStr = whole.toLocaleString("en-US");
  const sign = negative ? "-" : "";
  return fracStr ? `${sign}${wholeStr}.${fracStr}` : `${sign}${wholeStr}`;
}

/** Parses a decimal SOL amount into lamports. Returns null for invalid input. */
export function parseSol(input: string): bigint | null {
  return parseDecimal(input, 9);
}

/** Parses a decimal amount with `decimals` places into base units. */
export function parseDecimal(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Base units to a human token amount. */
export function formatTokens(base: bigint, decimals: number, maxDecimals = 4): string {
  const unit = 10n ** BigInt(decimals);
  const whole = base / unit;
  const frac = base % unit;
  const fracStr = frac
    .toString()
    .padStart(decimals, "0")
    .slice(0, Math.min(decimals, maxDecimals))
    .replace(/0+$/, "");
  const wholeStr = whole.toLocaleString("en-US");
  return fracStr ? `${wholeStr}.${fracStr}` : wholeStr;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** "1 lot", "12 lots". */
export function plural(n: number, word: string): string {
  return `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;
}

export function shortAddress(address: string, chars = 4): string {
  return address.length <= chars * 2 + 1 ? address : `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/** Seconds to a compact duration such as "2h 13m" or "45s". */
export function formatDuration(totalSecs: number): string {
  const secs = Math.max(0, Math.floor(totalSecs));
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  const s = secs % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 && m < 10 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export function formatDateTime(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}
