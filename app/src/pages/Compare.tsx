import type { ReactNode } from "react";
import { ANTI_SNIPER_FEE_BPS, ANTI_SNIPER_MINUTES, CONTENT_UPDATED, LAUNCH_HOURS, LAUNCH_MIN_RAISE } from "../config";
import { formatPercent } from "../lib/chain";
import { formatSol } from "../lib/format";
import { updatedOn } from "./Docs";

const hours = LAUNCH_HOURS.join(", ").replace(/, (\d+)$/, " or $1");

/**
 * How launches work elsewhere, side by side with Veiling. Kept to how each
 * kind of launch sets its price, not to any one platform's fees, which change.
 */
const ROWS: [string, string, string, string, string][] = [
  [
    "How the price is set",
    "Sealed bids in one round; one final price",
    "A formula raises the price with every buy",
    "Set by the team or the platform",
    "A fixed mint price",
  ],
  [
    "Who pays the lowest price",
    "Every winner pays the same price",
    "Whoever buys first, often bots",
    "Everyone in a round pays the same",
    "Same price, but the fastest get in",
  ],
  ["Bids or buys seen during the sale", "No, they stay encrypted", "Yes, every buy is public", "Usually seen only by the platform", "Yes, every mint is public"],
  ["Who can launch", "Anyone, in a few minutes", "Anyone", "Projects the platform picks", "Depends on the platform"],
  ["Who can buy", "Anyone with a wallet, or an allowlist the seller sets", "Anyone with a wallet", "Often after sign-up, KYC and an allocation", "Anyone, while supply lasts"],
  ["If demand is low", "No token is made; every deposit comes back", "The token exists anyway, and its price falls", "Depends on the sale's terms", "Depends on the platform"],
  ["Trading after the sale", "A Meteora pool at the final price, locked forever", "A DEX pool once the curve fills", "Wherever the project lists", "NFT marketplaces"],
];

export const COMPARE_FAQ: { question: string; answer: string }[] = [
  {
    question: "Is Veiling a pump.fun alternative?",
    answer:
      "Yes. Like pump.fun, anyone can launch a new token on Solana in a few minutes. Unlike it, the price is set by sealed bids in one round instead of a bonding curve, so buying first gives no advantage and every winner pays the same price.",
  },
  {
    question: "Can bots snipe a Veiling launch?",
    answer: `Not during the sale: bids stay encrypted and every winner pays the same final price, so speed wins nothing. When the token's pool opens, trading starts with a ${formatPercent(ANTI_SNIPER_FEE_BPS)} fee that falls to the pool's normal fee over the first ${ANTI_SNIPER_MINUTES} minutes, which makes sniping the first trades costly.`,
  },
  {
    question: "Do I need an account or KYC to use Veiling?",
    answer:
      "No. You connect a Solana wallet, such as Phantom, Solflare or Backpack, and bid or launch from it. Veiling is not available in some countries; the Terms of Use list them.",
  },
  {
    question: "When is a bonding curve the better choice?",
    answer: `When you want trading to start the moment a token exists, with no minimum. A Veiling sale runs for ${hours} hours and must raise at least ${formatSol(LAUNCH_MIN_RAISE)} SOL and sell out, or no token is made. That is the point: a token that launches has real demand behind it.`,
  },
];

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="doc">
      <h2 className="doc__title">{title}</h2>
      {children}
    </section>
  );
}

export function Compare() {
  return (
    <main className="page legal compare">
      <h1 className="page__title">Veiling vs other launchpads</h1>
      <p className="page__lede">
        Veiling is a Solana launchpad where a new token's price is set by sealed bids in one round, so every buyer
        pays the same final price. On bonding-curve launchpads like pump.fun, the price rises with every buy, so the
        earliest buyers, usually bots and insiders, pay the least.
      </p>
      <p className="docs__updated">
        Updated <time dateTime={CONTENT_UPDATED}>{updatedOn(CONTENT_UPDATED)}</time>.
      </p>

      <div className="docs__body legal__body">
        <Part title="Side by side">
          <div className="table-scroll">
            <table className="doc__table compare__table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Question</span>
                  </th>
                  <th scope="col">Veiling</th>
                  <th scope="col">Bonding curves (pump.fun, LetsBonk and others)</th>
                  <th scope="col">Curated sales (CoinList, Legion and others)</th>
                  <th scope="col">First-come NFT mints</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map(([label, ...cells]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {cells.map((cell, i) => (
                      <td key={i}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Part>

        <Part title="Why do bonding-curve launches favor bots?">
          <p>
            On a bonding curve, every buy raises the price for the next one. The first buyers pay the least, so the
            launch becomes a race measured in milliseconds, and bots and insiders win it. Regular buyers come in at a
            higher price and often sell at a loss to the people who bought before them.
          </p>
        </Part>

        <Part title="What happens on Veiling instead?">
          <p>
            Everyone bids in private for {hours} hours. Bids are encrypted in the bidder's browser and worked on by
            Arcium's encrypted compute network, so no one sees them, Veiling included. When bidding closes, one final
            price is set from all the bids together. Every winner pays it, never more than their own bid, and bids
            below it are refunded in full.
          </p>
          <p>
            A new token is made only if its sale sells out. Then everything raised, less the platform fee, opens a
            Meteora pool at exactly the final price, and that pool is locked forever. The creator gets no free tokens
            and none of the SOL raised; they earn a share of the pool's trading fees. The <a href="/docs/token">docs</a>{" "}
            explain every step.
          </p>
        </Part>

        <Part title="How do NFT launches compare?">
          <p>
            Most NFT mints are first come, first served at a fixed price, so they also turn into a race against bots.
            On Veiling a drop or a collection of up to 10,000 NFTs sells by sealed bid too: every winner pays the same
            price, NFTs are made only for winners and handed out at random, and the art can stay hidden until the sale
            ends.
          </p>
        </Part>

        <Part title="Questions">
          <dl className="doc__list doc__list--faq">
            {COMPARE_FAQ.map(({ question, answer }) => (
              <div key={question}>
                <dt>{question}</dt>
                <dd>{answer}</dd>
              </div>
            ))}
          </dl>
        </Part>

        <p className="doc__fine">
          Other platforms change their rules over time; this page compares how each kind of launch sets its price.
          Veiling is unaudited software; read the <a href="/risks">risks</a> before you bid.
        </p>
      </div>
    </main>
  );
}
