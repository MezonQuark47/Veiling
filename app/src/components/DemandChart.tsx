import { useId } from "react";

/**
 * How a sealed uniform-price auction clears, drawn with example bids: sorted
 * from the highest price down, the bids that fit in the supply win, and all
 * of them pay the price of the bid where demand meets the supply. Bids below
 * that line, or below the minimum price, are refunded.
 */

/** Example bids: price and amount, in arbitrary units, highest price first. */
const BIDS: [number, number][] = [
  [9.2, 1.5],
  [8.1, 1.1],
  [7.0, 1.9],
  [6.2, 1.3],
  [5.4, 2.0],
  [4.3, 1.6],
  [3.6, 1.2],
  [2.4, 0.9],
];
const SUPPLY = 6.8;
const MIN_PRICE = 3.0;

const LEFT = 30;
const RIGHT = 412;
const TOP = 34;
const BASE = 262;
const MAX_AMOUNT = 11.5;
const MAX_PRICE = 10;

const x = (amount: number) => LEFT + (amount / MAX_AMOUNT) * (RIGHT - LEFT);
const y = (price: number) => BASE - (price / MAX_PRICE) * (BASE - TOP);

interface Bar {
  from: number;
  to: number;
  price: number;
  state: "won" | "crossing" | "refunded" | "below";
}

function layout(): { bars: Bar[]; clearing: number } {
  const bars: Bar[] = [];
  let at = 0;
  let clearing = MIN_PRICE;
  for (const [price, amount] of BIDS) {
    const from = at;
    const to = at + amount;
    let state: Bar["state"] = "refunded";
    if (price < MIN_PRICE) state = "below";
    else if (to <= SUPPLY) state = "won";
    else if (from < SUPPLY) {
      state = "crossing";
      clearing = price;
    }
    bars.push({ from, to, price, state });
    at = to;
  }
  return { bars, clearing };
}

export function DemandChart({
  priceLabel = "Price",
  supplyLabel = "Supply",
  minLabel = "Minimum price",
  animate = false,
  className,
}: {
  priceLabel?: string;
  supplyLabel?: string;
  minLabel?: string;
  animate?: boolean;
  className?: string;
}) {
  const hatch = useId();
  const { bars, clearing } = layout();
  const supplyX = x(SUPPLY);
  return (
    <figure className={`demand${animate ? " demand--intro" : ""}${className ? ` ${className}` : ""}`}>
      <svg
        className="demand__svg"
        viewBox="0 0 440 300"
        role="img"
        aria-label="Example of how the price is found: bids sorted from the highest price down. The ones that fit in the supply win, and every winner pays the price where demand meets the supply. The rest are refunded."
      >
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="demand__hatch" />
          </pattern>
        </defs>

        <text className="demand__axis" x={LEFT} y={TOP - 16}>
          {priceLabel}
        </text>
        <line className="demand__base" x1={LEFT} y1={BASE} x2={RIGHT} y2={BASE} />
        <line className="demand__base" x1={LEFT} y1={TOP - 8} x2={LEFT} y2={BASE} />
        <text className="demand__axis" x={RIGHT} y={BASE + 22} textAnchor="end">
          Amount, highest bids first
        </text>

        {bars.map((bar, i) => {
          const top = y(bar.price);
          const height = BASE - top;
          const style = { animationDelay: `${120 + i * 70}ms` };
          if (bar.state === "crossing") {
            return (
              <g key={i} className="demand__bar" style={style}>
                <rect className="demand__fill" x={x(bar.from)} y={top} width={supplyX - x(bar.from)} height={height} />
                <rect
                  className="demand__open"
                  x={supplyX}
                  y={top}
                  width={x(bar.to) - supplyX}
                  height={height}
                  fill={`url(#${hatch})`}
                />
              </g>
            );
          }
          return (
            <rect
              key={i}
              className={`demand__bar ${bar.state === "won" ? "demand__fill" : bar.state === "below" ? "demand__below" : "demand__open"}`}
              style={style}
              x={x(bar.from) + 0.5}
              y={top}
              width={x(bar.to) - x(bar.from) - 1}
              height={height}
              fill={bar.state === "refunded" ? `url(#${hatch})` : undefined}
            />
          );
        })}

        <line className="demand__min" x1={LEFT} y1={y(MIN_PRICE)} x2={RIGHT} y2={y(MIN_PRICE)} />
        <text className="demand__note" x={RIGHT} y={y(MIN_PRICE) - 6} textAnchor="end">
          {minLabel}
        </text>

        <line className="demand__supply" x1={supplyX} y1={TOP - 8} x2={supplyX} y2={BASE} />
        <text className="demand__note demand__note--strong" x={supplyX + 6} y={TOP + 4}>
          {supplyLabel}
        </text>

        <line className="demand__clearing" x1={LEFT} y1={y(clearing)} x2={RIGHT} y2={y(clearing)} pathLength={1} />
        <text className="demand__price" x={RIGHT} y={y(clearing) - 8} textAnchor="end">
          Clearing price
        </text>
      </svg>
      <figcaption className="demand__legend">
        <span className="demand__key">
          <span className="demand__swatch demand__swatch--won" aria-hidden="true" />
          Wins, pays the clearing price
        </span>
        <span className="demand__key">
          <span className="demand__swatch demand__swatch--open" aria-hidden="true" />
          Refunded in full
        </span>
      </figcaption>
    </figure>
  );
}
