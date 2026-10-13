// Collections named per item: each item has its own name and a number of
// NFTs, its editions. Mirrors the program's item list (`ItemList`) and how it
// names NFTs (`item_nft_name`, `nft_name`).

/** An item as the program's `add_items` takes it. */
export type ListedItem = { name: string; supply: number };

/** An item list entry as stored on chain: the item's name and where its NFT numbers end. */
export type ItemEntry = { name: string; end: number };

/** Name of NFT `number` (from 0) without an item list: `"{base} #{number + 1}"`. */
export const numberedName = (base: string, number: number) => `${base} #${number + 1}`;

/** The entries an item list stores for these items. */
export function entriesOf(items: ListedItem[]): ItemEntry[] {
  let end = 0;
  return items.map((item) => {
    end += item.supply;
    return { name: item.name, end };
  });
}

/** Which item NFT `number` (from 0) belongs to, by binary search over the entries' ends. */
export function itemIndexOf(entries: ItemEntry[], number: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (entries[middle].end > number) high = middle;
    else low = middle + 1;
  }
  if (low >= entries.length) throw new Error("That NFT is not in the item list");
  return low;
}

/** Where item `index`'s NFT numbers start. */
export const itemStart = (entries: ItemEntry[], index: number) => (index === 0 ? 0 : entries[index - 1].end);

/**
 * Name of NFT `number` (from 0): its item's name, followed by `" #{edition}"`
 * when the item has more than one NFT.
 */
export function itemNftName(entries: ItemEntry[], number: number): string {
  const index = itemIndexOf(entries, number);
  const start = itemStart(entries, index);
  const editions = entries[index].end - start;
  return editions === 1 ? entries[index].name : numberedName(entries[index].name, number - start);
}

/** Every NFT's name, in NFT-number order. */
export function itemNftNames(items: ListedItem[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    for (let edition = 0; edition < item.supply; edition++) {
      names.push(item.supply === 1 ? item.name : numberedName(item.name, edition));
    }
  }
  return names;
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * Splits items into batches small enough for one `add_items` transaction
 * each, keeping their order. Each item takes its name's bytes plus 8.
 */
export function itemBatches(items: ListedItem[], budget = 840): ListedItem[][] {
  const batches: ListedItem[][] = [];
  let current: ListedItem[] = [];
  let used = 0;
  for (const item of items) {
    const size = 8 + utf8Length(item.name);
    if (current.length > 0 && used + size > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
