// Exact decimal maths for prices. On chain a price is a whole number of
// "price ticks" (a u32):
// - token auctions: lamports per `priceUnit` base units, where `priceUnit` is
//   a power of ten the app picks when the auction opens;
// - collection auctions: units of 1_000 lamports per NFT.
// People type and read prices in SOL per whole token or per NFT, so the app
// converts both ways without floating point.
import {
  MAX_PRICE_TICKS,
  MAX_PRICE_UNIT_EXPONENT,
  NFT_PRICE_SCALE,
  TARGET_MIN_PRICE_TICKS,
} from "../config";

/** An exact decimal: `mantissa × 10^exponent`. */
export interface Decimal {
  mantissa: bigint;
  exponent: number;
}

const pow10 = (n: number) => 10n ** BigInt(n);

/** Parses a typed amount such as "0.0025" or "1,000.5"; null if it is not one. */
export function parseAmount(input: string): Decimal | null {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (whole.length + frac.length > 40) return null;
  return { mantissa: BigInt((whole || "0") + frac), exponent: -frac.length };
}

/** `mantissa × 10^by` as a whole number, rounded down or up. */
export function shift(mantissa: bigint, by: number, round: "down" | "up"): bigint {
  if (by >= 0) return mantissa * pow10(by);
  const divisor = pow10(-by);
  const quotient = mantissa / divisor;
  return round === "up" && quotient * divisor !== mantissa ? quotient + 1n : quotient;
}

/**
 * Writes `mantissa × 10^exponent` in plain notation with grouped thousands,
 * dropping trailing zeros. With `maxDecimals`, the fraction is cut (rounded
 * down) to that many places, but never to nothing when the value is not zero.
 */
export function decimalString(mantissa: bigint, exponent: number, maxDecimals?: number): string {
  const negative = mantissa < 0n;
  let digits = (negative ? -mantissa : mantissa).toString();
  let whole: string;
  let frac: string;
  if (exponent >= 0) {
    whole = digits + "0".repeat(exponent);
    frac = "";
  } else {
    digits = digits.padStart(-exponent + 1, "0");
    whole = digits.slice(0, digits.length + exponent);
    frac = digits.slice(digits.length + exponent);
  }
  if (maxDecimals !== undefined && frac.length > maxDecimals) {
    // Keep two significant digits of a small value instead of showing 0.
    const firstNonZero = frac.search(/[1-9]/);
    const keep = /^0*$/.test(whole) && firstNonZero >= maxDecimals ? firstNonZero + 2 : maxDecimals;
    frac = frac.slice(0, keep);
  }
  frac = frac.replace(/0+$/, "");
  const grouped = BigInt(whole || "0").toLocaleString("en-US");
  return `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

export function formatDecimal(value: Decimal, maxDecimals?: number): string {
  return decimalString(value.mantissa, value.exponent, maxDecimals);
}

/** Whether two decimals are the same number. */
export function sameDecimal(a: Decimal, b: Decimal): boolean {
  const low = Math.min(a.exponent, b.exponent);
  return a.mantissa * pow10(a.exponent - low) === b.mantissa * pow10(b.exponent - low);
}

/** log10 of a token auction's price unit, a power of ten. */
export function unitExponent(priceUnit: bigint): number {
  let e = 0;
  for (let u = priceUnit; u > 1n; u /= 10n) e++;
  return e;
}

// ---------------------------------------------------------------------------
// Token prices
// ---------------------------------------------------------------------------

/** SOL per whole token that `ticks` stands for, exactly. */
export function tokenPrice(ticks: bigint, priceUnit: bigint, decimals: number): Decimal {
  // ticks lamports per 10^e base units = ticks × 10^(d - e) lamports per token.
  return { mantissa: ticks, exponent: decimals - unitExponent(priceUnit) - 9 };
}

/** The price in ticks of `solPerToken` SOL per whole token, rounded to a whole tick. */
export function tokenPriceToTicks(
  solPerToken: Decimal,
  priceUnit: bigint,
  decimals: number,
  round: "down" | "up"
): bigint {
  return shift(solPerToken.mantissa, solPerToken.exponent + 9 + unitExponent(priceUnit) - decimals, round);
}

/**
 * Picks the price unit of a new token auction: the power of ten of base
 * units that makes the minimum price about `TARGET_MIN_PRICE_TICKS` ticks.
 * Returns the unit and the minimum price in ticks (rounded up), or null when
 * the price cannot be expressed: zero, or too high for the token's decimals.
 */
export function choosePriceUnit(
  minSolPerToken: Decimal,
  decimals: number
): { priceUnit: bigint; minTicks: bigint } | null {
  if (minSolPerToken.mantissa <= 0n) return null;
  const digits = minSolPerToken.mantissa.toString().length;
  const targetDigits = TARGET_MIN_PRICE_TICKS.toString().length;
  // ticks = mantissa × 10^(exponent + 9 + e - d) should have `targetDigits` digits.
  const ideal = targetDigits - digits - minSolPerToken.exponent - 9 + decimals;
  const e = Math.min(MAX_PRICE_UNIT_EXPONENT, Math.max(0, ideal));
  const priceUnit = pow10(e);
  const minTicks = tokenPriceToTicks(minSolPerToken, priceUnit, decimals, "up");
  if (minTicks < 1n || minTicks > MAX_PRICE_TICKS) return null;
  return { priceUnit, minTicks };
}

/** Base units `budget` lamports buy at `ticks`, rounded down as the program does. */
export function tokensForBudget(budget: bigint, priceUnit: bigint, ticks: bigint): bigint {
  return ticks > 0n ? (budget * priceUnit) / ticks : 0n;
}

/** Lamports that `baseUnits` cost at `ticks`, rounded up as the program does. */
export function costOfTokens(baseUnits: bigint, priceUnit: bigint, ticks: bigint): bigint {
  return (baseUnits * ticks + priceUnit - 1n) / priceUnit;
}

// ---------------------------------------------------------------------------
// NFT prices
// ---------------------------------------------------------------------------

const NFT_SCALE_EXPONENT = NFT_PRICE_SCALE.toString().length - 1;

/** SOL per NFT that `ticks` stands for. */
export function nftPrice(ticks: bigint): Decimal {
  return { mantissa: ticks, exponent: NFT_SCALE_EXPONENT - 9 };
}

/** The price in ticks of `solPerNft`, rounded to a whole tick (0.000001 SOL). */
export function nftPriceToTicks(solPerNft: Decimal, round: "down" | "up"): bigint {
  return shift(solPerNft.mantissa, solPerNft.exponent + 9 - NFT_SCALE_EXPONENT, round);
}

/** `n` rounded up to `digits` significant digits: 195_312 -> 200_000 for 2. */
export function roundUpSignificant(n: bigint, digits: number): bigint {
  const length = n.toString().length;
  if (length <= digits) return n;
  const step = pow10(length - digits);
  return ((n + step - 1n) / step) * step;
}

/** The first of 1, 2, 5, 10, 20, 50, ... at or above `n` (n >= 1). */
export function niceCeil(n: bigint): bigint {
  for (let step = 1n; ; step *= 10n) {
    for (const m of [1n, 2n, 5n]) if (m * step >= n) return m * step;
  }
}
