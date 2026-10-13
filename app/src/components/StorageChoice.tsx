import { useEffect, useId, useRef, useState } from "react";
import { FREE_UPLOAD_TOTAL_BYTES, MAX_IMAGE_BYTES } from "../config";
import { formatCount, formatSol } from "../lib/format";
import { type PreparedImage, formatKb, formatMb, formatSize } from "../lib/images";
import type { Quote } from "../lib/storage";
import type { Quality } from "../lib/uploads";

/** One way to store a launch's files, as the seller is shown it. */
export type StorageOption = {
  /** Everything that would be stored, in bytes; null before images are chosen. */
  bytes: number | null;
  /** Whether it fits Turbo's free allowance. */
  free: boolean;
  /** What it costs, once prices are in; null when free. */
  quote: Quote | null;
  /** Why this option cannot be used, if it cannot. */
  problem: string | null;
  /** The sample image as this option stores it. */
  sample: { width: number; height: number; bytes: number } | null;
};

/** Original pixels across the loupe, which shows them at twice their size. */
const LOUPE_PIXELS = 48;

const usd = (amount: number) =>
  amount < 0.01
    ? "under 1¢"
    : amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: amount < 10 ? 2 : 0 });

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Where each image is busiest, as fractions of its width and height, so the
// loupe lands on detail rather than a plain patch of sky.
const busiest = new WeakMap<PreparedImage, Promise<{ x: number; y: number }>>();

function busiestPoint(image: PreparedImage): Promise<{ x: number; y: number }> {
  let found = busiest.get(image);
  if (!found) {
    found = (async () => {
      const grid = 64;
      const block = 8;
      const bitmap = await createImageBitmap(new Blob([image.bytes], { type: image.type }));
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = grid;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return { x: 0.5, y: 0.5 };
      context.drawImage(bitmap, 0, 0, grid, grid);
      bitmap.close();
      const { data } = context.getImageData(0, 0, grid, grid);
      const light = (x: number, y: number) => {
        const i = (y * grid + x) * 4;
        return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      };
      let best = { x: 0.5, y: 0.5 };
      let bestScore = -1;
      for (let top = 0; top + block <= grid; top += block / 2) {
        for (let left = 0; left + block <= grid; left += block / 2) {
          let score = 0;
          for (let y = top; y < top + block; y++) {
            for (let x = left; x < left + block; x++) {
              if (x + 1 < left + block) score += Math.abs(light(x + 1, y) - light(x, y));
              if (y + 1 < top + block) score += Math.abs(light(x, y + 1) - light(x, y));
            }
          }
          const x = (left + block / 2) / grid;
          const y = (top + block / 2) / grid;
          // A little preference for the middle, where the subject usually is.
          score *= 1 - 0.6 * Math.hypot(x - 0.5, y - 0.5);
          if (score > bestScore) {
            bestScore = score;
            best = { x, y };
          }
        }
      }
      return best;
    })().catch(() => ({ x: 0.5, y: 0.5 }));
    busiest.set(image, found);
  }
  return found;
}

/** The same small square of an image in both options, enlarged with its pixels kept sharp. */
function Loupe({ image, quality, label }: { image: PreparedImage | null; quality: Quality; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState(false);
  const usable = Boolean(image && (quality === "compressed" || image.original.ok));

  useEffect(() => {
    setShown(false);
    const canvas = ref.current;
    if (!canvas || !image || !usable) return;
    let cancelled = false;
    (async () => {
      const point = await busiestPoint(image);
      const source = quality === "original" ? image.file : new Blob([image.bytes], { type: image.type });
      const bitmap = await createImageBitmap(source);
      try {
        if (cancelled) return;
        const { originalWidth: width, originalHeight: height } = image;
        const side = Math.min(LOUPE_PIXELS, width, height);
        const left = Math.min(Math.max(point.x * width - side / 2, 0), width - side);
        const top = Math.min(Math.max(point.y * height - side / 2, 0), height - side);
        // The compressed image may be smaller, so the same square is fewer of its pixels.
        const scaleX = bitmap.width / width;
        const scaleY = bitmap.height / height;
        const size = Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)));
        canvas.width = canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.imageSmoothingEnabled = false;
        context.drawImage(bitmap, left * scaleX, top * scaleY, side * scaleX, side * scaleY, 0, 0, size, size);
        setShown(true);
      } finally {
        bitmap.close();
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [image, quality, usable]);

  return (
    <span className={`storage__loupe${shown ? "" : " storage__loupe--empty"}`}>
      <canvas ref={ref} role="img" aria-label={label} hidden={!usable} />
    </span>
  );
}

/** The choice between compressed images, stored free, and original files, paid for. */
export function StorageChoice({
  value,
  onChange,
  options,
  nfts,
  sample,
  sampleLabel,
  sampleKey,
  labelledBy,
  prices,
}: {
  value: Quality;
  onChange: (quality: Quality) => void;
  options: Record<Quality, StorageOption>;
  /** NFTs with an image each, to show a price per NFT. */
  nfts: number | null;
  /** The image the loupes show, what to call it in a sentence, and its row label. */
  sample: PreparedImage | null;
  sampleLabel: string;
  sampleKey: string;
  /** The id of the heading that names the choice. */
  labelledBy: string;
  prices: { loading: boolean; error: string | null; at: number | null; retry: () => void };
}) {
  const id = useId();
  const choices: [Quality, string, string][] = [
    ["compressed", "Compressed", `Each image fitted under ${formatKb(MAX_IMAGE_BYTES)}.`],
    ["original", "Original", "Your files exactly as chosen, minus hidden details such as where a photo was taken."],
  ];
  const priced = choices.some(([quality]) => {
    const option = options[quality];
    return option.bytes !== null && !option.free && !option.problem;
  });

  return (
    <>
      <div className="storage" role="radiogroup" aria-labelledby={labelledBy}>
        {choices.map(([quality, title, about]) => {
          const option = options[quality];
          const ready = option.bytes !== null && !option.problem;
          const each =
            option.quote && nfts && nfts > 0 ? (option.quote.lamports + BigInt(nfts) - 1n) / BigInt(nfts) : null;
          let price = "–";
          let note = "Choose images to see the price.";
          let priceClass = " storage__price--muted";
          if (option.problem) {
            price = "Not available";
            note = `${option.problem}.`;
          } else if (option.bytes !== null && option.free) {
            price = "Free";
            note = `Fits in the free ${formatMb(FREE_UPLOAD_TOTAL_BYTES)}.`;
            priceClass = " storage__price--free";
          } else if (option.quote) {
            price = `${formatSol(option.quote.lamports)} SOL`;
            note = option.quote.usd !== null ? `About ${usd(option.quote.usd)}.` : "";
            priceClass = "";
          } else if (option.bytes !== null) {
            note = prices.loading ? "Checking the price…" : "The price could not be loaded.";
          }
          const ids = (...parts: string[]) => parts.map((part) => `${id}-${quality}-${part}`).join(" ");
          return (
            <label key={quality} className={`storage__option${value === quality ? " storage__option--on" : ""}`}>
              <input
                className="storage__radio"
                type="radio"
                name="storage"
                value={quality}
                checked={value === quality}
                onChange={() => onChange(quality)}
                aria-labelledby={ids("name")}
                aria-describedby={ids("cost", "specs", "about")}
              />
              <span className="storage__name" id={ids("name")}>
                {title}
              </span>
              <span className="storage__about" id={ids("about")}>
                {about}
              </span>
              <span className="storage__head">
                <Loupe image={sample} quality={quality} label={`Detail of ${sampleLabel}, ${title.toLowerCase()}`} />
                <span className="storage__cost" id={ids("cost")}>
                  <span className={`storage__price${priceClass}`}>{price}</span>
                  {note ? (
                    <span className={`storage__note${option.problem ? " storage__note--problem" : ""}`}>{note}</span>
                  ) : null}
                </span>
              </span>
              <span className="storage__specs" id={ids("specs")}>
                {ready ? (
                  <>
                    {option.sample ? (
                      <span className="storage__spec">
                        <span className="storage__key">{sampleKey}</span>
                        <span>
                          {formatCount(option.sample.width)} × {formatCount(option.sample.height)},{" "}
                          {formatSize(option.sample.bytes)}
                        </span>
                      </span>
                    ) : null}
                    <span className="storage__spec">
                      <span className="storage__key">In all</span>
                      <span>{formatSize(option.bytes!)}</span>
                    </span>
                    {nfts ? (
                      <span className="storage__spec">
                        <span className="storage__key">Per NFT</span>
                        <span>{option.free ? "Free" : each !== null ? `${formatSol(each)} SOL` : "–"}</span>
                      </span>
                    ) : null}
                  </>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      <p className="hint">
        {sample ? `The squares show the same detail of ${sampleLabel}, enlarged. ` : ""}
        Storage is paid once, from your wallet, when you launch; bidders never pay for it.
        {priced && prices.at !== null ? ` Prices from Turbo, the storage service, at ${time(prices.at)}.` : ""}
        {priced && prices.at === null && prices.error ? (
          <>
            {" "}
            <button type="button" className="storage__retry" onClick={prices.retry}>
              Load the prices again
            </button>
          </>
        ) : null}
      </p>
    </>
  );
}
