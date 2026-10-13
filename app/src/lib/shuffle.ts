// Which NFT each place of a collection auction becomes, computed exactly as
// the program's `shuffled_items` does: a swap-or-not shuffle keyed by the
// seed Arcium draws once every bid is settled.

/** Must match `SHUFFLE_ROUNDS` in the program. */
export const SHUFFLE_ROUNDS = 64;
const PIVOT_SALT = 0xffff_ffffn;
const M64 = (1n << 64n) - 1n;

/** SplitMix64's finalizer. */
function mix64(value: bigint): bigint {
  let z = value & M64;
  z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & M64;
  return z ^ (z >> 31n);
}

function shuffleWord(seed: bigint, round: number, salt: bigint): bigint {
  const word = (BigInt(round) << 32n) | salt;
  return mix64(mix64(word ^ (seed & M64)) ^ (seed >> 64n));
}

/**
 * The NFT numbers (from 0) that `positions` become among `supply` NFTs. NFT
 * `i` is named "{name} #{i + 1}".
 */
export function shuffledItems(positions: number[], supply: number, seed: bigint): number[] {
  if (!Number.isInteger(supply) || supply <= 0 || positions.some((p) => !Number.isInteger(p) || p < 0 || p >= supply)) {
    throw new Error("Places must be below the supply");
  }
  const n = BigInt(supply);
  const items = positions.map((p) => BigInt(p));
  for (let round = 0; round < SHUFFLE_ROUNDS; round++) {
    const pivot = shuffleWord(seed, round, PIVOT_SALT) % n;
    for (let k = 0; k < items.length; k++) {
      const flip = (pivot + n - items[k]) % n;
      const pair = items[k] > flip ? items[k] : flip;
      if ((shuffleWord(seed, round, pair) & 1n) === 1n) items[k] = flip;
    }
  }
  return items.map((item) => Number(item));
}

/** Checked by the program's tests too (`the_shuffle_matches_the_published_vectors`). */
export const SHUFFLE_VECTORS: { seed: bigint; cases: [number, number, number][] } = {
  seed: 0x9e37_79b9_7f4a_7c15_f39c_c060_5ced_c834n,
  cases: [
    [0, 1, 0],
    [0, 10, 7],
    [9, 10, 5],
    [0, 10_000, 7_090],
    [4_242, 10_000, 4_746],
    [9_999, 10_000, 1_327],
  ],
};
