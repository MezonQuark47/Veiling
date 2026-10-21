import { type CSSProperties, useEffect, useState } from "react";

/**
 * Small 3D scenes drawn with CSS transforms: every box is six faces in a
 * preserve-3d stack, so it needs no canvas or WebGL. Boxes are sealed
 * (periwinkle glass), lit (a winning bid), out (refunded), glass (the seal
 * itself) or a plane (the clearing price).
 */

export type BoxLook = "" | "lit" | "out" | "glass" | "plane";

export interface Box {
  x?: number;
  y: number;
  z?: number;
  /** Width (x), height (y) and depth (z), in px. */
  w: number;
  h: number;
  d: number;
  look?: BoxLook;
}

function Faces({ w, h, d }: { w: number; h: number; d: number }) {
  const face = (width: number, height: number, transform: string, top = false) => (
    <span
      className={`cube__face${top ? " cube__face--top" : ""}`}
      style={{ width, height, transform: `translate(-50%, -50%) ${transform}` }}
    />
  );
  return (
    <>
      {face(w, d, `rotateX(90deg) translateZ(${h / 2}px)`, true)}
      {face(w, d, `rotateX(-90deg) translateZ(${h / 2}px)`)}
      {face(w, h, `translateZ(${d / 2}px)`)}
      {face(w, h, `rotateY(180deg) translateZ(${d / 2}px)`)}
      {face(d, h, `rotateY(90deg) translateZ(${w / 2}px)`)}
      {face(d, h, `rotateY(-90deg) translateZ(${w / 2}px)`)}
    </>
  );
}

/** A still scene that turns a little when its card is hovered. */
export function Scene({ boxes, height = 210, className = "" }: { boxes: Box[]; height?: number; className?: string }) {
  return (
    <div className={`scene ${className}`} style={{ height }} aria-hidden="true">
      <div className="scene__anchor">
        <div className="scene__tilt">
          <div className="scene__rig">
            {boxes.map((b, i) => (
              <div
                key={i}
                className={`cube${b.look ? ` cube--${b.look}` : ""}`}
                style={{ transform: `translate3d(${b.x ?? 0}px, ${b.y}px, ${b.z ?? 0}px)` }}
              >
                <Faces w={b.w} h={b.h} d={b.d} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Bid sizes in the tower, highest price first; the first `WINNERS` win. */
const SIZES = [160, 220, 140, 250, 180, 200, 170, 230, 150, 190];
const WINNERS = 5;
const PITCH = 26;

type Phase = "away" | "sealed" | "price" | "reveal";

const STEPS: [Phase, number][] = [
  ["away", 700],
  ["sealed", 1900],
  ["price", 1700],
  ["reveal", 4600],
];

const CAPTIONS: Record<Phase, string> = {
  away: "Bids arrive. Each one is sealed in the bidder’s browser.",
  sealed: "Bids arrive. Each one is sealed in the bidder’s browser.",
  price: "Bidding closes. One price is found without opening a bid.",
  reveal: "Bids above the price win and all pay it. The rest are refunded.",
};

/**
 * The front page's tower: ten sealed bids stacked by price, then the clearing
 * price comes down through them, the bids above it light up and the ones
 * below drop away. It starts on the finished picture and loops.
 */
export function BidTower() {
  const [phase, setPhase] = useState<Phase>("reveal");

  useEffect(() => {
    let step = 0;
    let timer: number;
    const next = () => {
      const [p, wait] = STEPS[step % STEPS.length];
      setPhase(p);
      step++;
      timer = window.setTimeout(next, wait);
    };
    timer = window.setTimeout(next, 2600);
    return () => window.clearTimeout(timer);
  }, []);

  const priceOn = phase === "price" || phase === "reveal";
  return (
    <figure className="tower">
      <div className="scene scene--tower" aria-hidden="true">
        <div className="tower__scale">
          <div className="scene__anchor">
            <div className="scene__rig tower__rig">
              {SIZES.map((s, i) => {
                const won = i < WINNERS;
                let state = "";
                let delay = 0;
                if (phase === "away") state = "is-away";
                else if (phase === "reveal") {
                  state = won ? "is-lit" : "is-out";
                  delay = won ? i * 70 : (i - WINNERS) * 60;
                } else delay = (SIZES.length - 1 - i) * 70;
                return (
                  <div key={i} className="cube" style={{ transform: `translate3d(0, ${i * PITCH - ((SIZES.length - 1) * PITCH) / 2}px, 0)` }}>
                    <div className={`cube__move ${state}`} style={{ "--d": `${delay}ms` } as CSSProperties}>
                      <Faces w={s} h={15} d={s} />
                    </div>
                  </div>
                );
              })}
              <div className={`tower__plane${priceOn ? " is-on" : ""}`} />
            </div>
          </div>
        </div>
      </div>
      <figcaption className="tower__caption">
        <span className="tower__stage" aria-hidden="true">
          {CAPTIONS[phase]}
        </span>
        <span className="tower__legend" aria-hidden="true">
          <span>
            <i className="key key--sealed" />
            Sealed bid
          </span>
          <span className={priceOn ? "" : "is-dim"}>
            <i className="key key--price" />
            Clearing price
          </span>
          <span className={phase === "reveal" ? "" : "is-dim"}>
            <i className="key key--won" />
            Wins, pays that price
          </span>
          <span className={phase === "reveal" ? "" : "is-dim"}>
            <i className="key key--out" />
            Refunded
          </span>
        </span>
        <span className="sr-only">
          Sealed bids are stacked by price. One clearing price cuts through them: the bids above it win and all
          pay that price, and the bids below it are refunded.
        </span>
      </figcaption>
    </figure>
  );
}
