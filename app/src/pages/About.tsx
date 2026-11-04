import type { ReactNode } from "react";
import { FEATURE_CONTACT, FOUNDER, GITHUB_URL, PROJECT_X_URL } from "../config";

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="doc">
      <h2 className="doc__title">{title}</h2>
      {children}
    </section>
  );
}

/** Who builds Veiling and why, for people deciding whether to trust it. */
export function About() {
  return (
    <main className="page legal about">
      <h1 className="page__title">About Veiling</h1>
      <p className="page__lede">
        Veiling is a launchpad on Solana that sells new tokens and NFT collections by sealed-bid auction, so every buyer
        pays one fair price and no one can buy ahead of anyone else.
      </p>

      <div className="docs__body legal__body">
        <Part title="Why Veiling exists">
          <p>
            Most token launches are a race. On a bonding curve the price rises with every buy, so bots and insiders buy in
            the first seconds and regular buyers come in at the top. NFT mints turn into the same race. Veiling replaces
            the race with one sealed round: everyone bids in private, one final price is set from all the bids, and
            every winner pays it.
          </p>
          <p>
            A new token is made only if its sale sells out, its trading pool is locked forever, and its creator gets no
            free tokens. Creators earn from trading fees, so they do well when the token lasts. The{" "}
            <a href="/compare">comparison with other launchpads</a> shows the difference side by side.
          </p>
        </Part>

        <Part title="Who builds it">
          <div className="about__person">
            <p className="about__name">
              {FOUNDER.name}
              <span className="about__role">
                {FOUNDER.role}
                {FOUNDER.location ? `, ${FOUNDER.location}` : ""}
              </span>
            </p>
            <p>
              {FOUNDER.name} has worked in crypto for years on NFT collections, community partnerships and privacy
              projects, and started Veiling to make launches fair for the people who buy them.
            </p>
            {FOUNDER.x || FOUNDER.linkedin ? (
              <p className="about__links">
                {FOUNDER.x ? (
                  <a href={FOUNDER.x} target="_blank" rel="noreferrer noopener me">
                    X
                  </a>
                ) : null}
                {FOUNDER.linkedin ? (
                  <a href={FOUNDER.linkedin} target="_blank" rel="noreferrer noopener me">
                    LinkedIn
                  </a>
                ) : null}
              </p>
            ) : null}
          </div>
        </Part>

        <Part title="Open source, with its rules on chain">
          <p>
            Everything is open source under the MIT license on{" "}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
              GitHub
            </a>
            : the Solana program, the Arcium circuits that work with the sealed bids, this website and the bot that
            finishes sales. A sale's rules and fees are fixed on chain before the first bid, and no one, Veiling
            included, can change them or take a bidder's deposit.
          </p>
        </Part>

        <Part title="Security">
          <p>
            Veiling has not been audited yet. An independent security audit of the program is planned before mainnet.
            Until then, bid only what you can afford to lose, and read the <a href="/risks">risk disclosure</a>. If a
            sale ever stalls, its bidders can take their deposits back on their own; the{" "}
            <a href="/docs/safety">docs</a> explain how.
          </p>
        </Part>

        <Part title="Built with">
          <p>
            Solana for the sales and the tokens, Arcium's encrypted compute for the sealed bids, Meteora for each new
            token's locked pool, and Arweave for NFT art and metadata.
          </p>
        </Part>

        <Part title="Contact">
          <p>
            Write to{" "}
            <a href={PROJECT_X_URL ?? FEATURE_CONTACT.href} target="_blank" rel="noreferrer noopener">
              {FEATURE_CONTACT.label} on X
            </a>
            . Questions about how Veiling works are answered in the <a href="/docs">docs</a>.
          </p>
        </Part>
      </div>
    </main>
  );
}
