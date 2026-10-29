import type { ReactNode } from "react";
import { FEATURE_CONTACT, NETWORK_LABEL, PROJECT_X_URL, RESTRICTED_REGIONS, TERMS_VERSION } from "../config";

export type LegalPage = "terms" | "risks" | "privacy";

const PAGES: [LegalPage, string][] = [
  ["terms", "Terms of Use"],
  ["risks", "Risk disclosure"],
  ["privacy", "Privacy policy"],
];

const updated = new Date(`${TERMS_VERSION}T00:00:00Z`).toLocaleDateString("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="doc">
      <h2 className="doc__title">{title}</h2>
      {children}
    </section>
  );
}

/** A list joined in plain English: "a, b and c". */
export const regionList = (items: string[] = RESTRICTED_REGIONS) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

function Contact() {
  return (
    <p>
      Questions about this page: write to{" "}
      <a href={PROJECT_X_URL ?? FEATURE_CONTACT.href} target="_blank" rel="noreferrer noopener">
        {FEATURE_CONTACT.label} on X
      </a>
      .
    </p>
  );
}

function Terms() {
  return (
    <>
      <Part title="1. These terms">
        <p>
          These terms apply when you use Veiling: this website and the tools on it for sending transactions to the
          Veiling program on Solana ("Veiling", "we", "us"). By connecting a wallet or using the site, you agree to
          them, to the <a href="#/risks">Risk disclosure</a> and to the <a href="#/privacy">Privacy policy</a>. If you
          do not agree, do not use Veiling.
        </p>
      </Part>
      <Part title="2. Who can use Veiling">
        <ul className="doc__bullets">
          <li>You are at least 18 years old and able to agree to these terms.</li>
          <li>
            You are not a resident of, and not located in, any of these places: {regionList()}. You are not on any
            sanctions list, and you do not act for anyone who is.
          </li>
          <li>
            Using Veiling is legal where you are. Rules on tokens differ from country to country; checking yours is
            your responsibility.
          </li>
        </ul>
        <p>We may block access from any place or wallet, at any time, to follow the law.</p>
      </Part>
      <Part title="3. What Veiling is, and is not">
        <ul className="doc__bullets">
          <li>
            Veiling is software. The sales run on an open-source program on Solana that nobody, including us, can use
            to move your funds outside its rules.
          </li>
          <li>
            We never hold your funds or your keys. Your wallet signs every transaction. Transactions on Solana are
            final: we cannot reverse, cancel or refund them.
          </li>
          <li>We are not a broker, an exchange, an investment adviser or a bank.</li>
        </ul>
      </Part>
      <Part title="4. Sales and creators">
        <ul className="doc__bullets">
          <li>
            Anyone can open a sale. We do not check, approve or vouch for any sale, token, NFT or creator. A "Featured"
            sale was picked by hand to show on the front page; it is not advice to buy.
          </li>
          <li>
            A "Verified" badge means only that the creator proved they control the X account shown. It says nothing
            about the project's quality or honesty.
          </li>
          <li>
            Creators are fully responsible for their sales: what they say about them, what they sell, and following
            the laws that apply to them, including securities laws.
          </li>
        </ul>
      </Part>
      <Part title="5. Fees">
        <p>
          The fees are listed in the <a href="#/docs/fees">docs</a> and shown before you sign. Every transaction also
          pays a small Solana network fee. Fees can change for new sales; a sale keeps the fees it opened with.
        </p>
      </Part>
      <Part title="6. What you agree not to do">
        <ul className="doc__bullets">
          <li>Break any law, including rules on money laundering, sanctions, fraud and securities.</li>
          <li>Mislead buyers, copy someone else's project or brand, or manipulate a sale or a market.</li>
          <li>Upload content you have no right to share, or content that is illegal or harmful.</li>
          <li>Attack, overload or try to break the site, the program or other users' wallets.</li>
          <li>Create many wallets to farm points or invites.</li>
        </ul>
      </Part>
      <Part title="7. Points, Season 0 and invites">
        <p>
          Points are a record of how you used Veiling. They are not a token, cannot be sold or transferred, have no
          cash value and are not a promise of any future reward. We can change how points are counted, reset them, or
          remove points earned by breaking these terms.
        </p>
      </Part>
      <Part title="8. Content on Veiling">
        <p>
          Images and details uploaded for a sale are stored for good on Arweave, a public network. We can hide a sale
          from this website, but we cannot delete what is on Solana or Arweave.
        </p>
      </Part>
      <Part title="9. No advice">
        <p>Nothing on Veiling is financial, investment, legal or tax advice. Decide for yourself, and ask a professional if unsure.</p>
      </Part>
      <Part title="10. No warranty">
        <p>
          Veiling is provided "as is" and "as available". The software may have bugs, the program has not had an
          independent security audit yet, and the networks it depends on can fail. To the extent the law allows, we
          give no warranties of any kind.
        </p>
      </Part>
      <Part title="11. Limits on our liability">
        <p>
          To the extent the law allows, we are not liable for any loss of tokens, NFTs, SOL, profits or data, or for
          any indirect loss, that comes from using Veiling. Our total liability for any claim is limited to the fees
          you paid to Veiling in the 12 months before it, or US$100, whichever is more. You will cover our costs if a
          claim against us comes from your breaking these terms or the law.
        </p>
      </Part>
      <Part title="12. Changes">
        <p>
          We may update these terms. The date at the top shows the latest version; when it changes, the site asks you
          to agree again before you connect a wallet.
        </p>
        <Contact />
      </Part>
    </>
  );
}

function Risks() {
  return (
    <>
      <Part title="You can lose everything you put in">
        <p>
          New tokens and NFTs are very risky. Their price can fall to zero, and there may be nobody to sell to. Only
          put in what you can afford to lose completely.
        </p>
      </Part>
      <Part title="Risks of the sale itself">
        <ul className="doc__bullets">
          <li>
            <strong>Bids are final.</strong> While bidding is open you can raise a bid but not lower or withdraw it.
            Your deposit stays locked until your bid is worked out.
          </li>
          <li>
            <strong>Results take time.</strong> After bidding ends, finding the price and sending out tokens can take
            minutes, or hours for large sales.
          </li>
          <li>
            <strong>Deposits are public.</strong> Your bid's price is private, but the deposit it holds is visible on
            Solana and hints at how much you could spend.
          </li>
          <li>
            <strong>Privacy depends on Arcium.</strong> Bids are worked out by Arcium's encrypted compute network.
            They stay private as long as at least one of its nodes is honest; if the network stops, a sale waits, and
            after a delay every deposit can be refunded.
          </li>
        </ul>
      </Part>
      <Part title="Risks of the software">
        <ul className="doc__bullets">
          <li>
            The Veiling program has not had an independent security audit yet. A bug could lock or lose funds.
          </li>
          <li>The program can still be upgraded by its team, which could change how it works.</li>
          <li>Solana can be slow or stop; transactions can fail and still cost a network fee.</li>
        </ul>
      </Part>
      <Part title="Risks after the sale">
        <ul className="doc__bullets">
          <li>
            A new token starts trading in a Meteora pool at the final price. The pool's liquidity is locked for good,
            but the price can still fall fast, and there is a high trading fee for the first ten minutes.
          </li>
          <li>
            Creators can be anonymous and can abandon their project. A Verified badge only proves control of an X
            account.
          </li>
        </ul>
      </Part>
      <Part title="Your wallet and the law">
        <ul className="doc__bullets">
          <li>
            Whoever has your seed phrase controls your funds. Veiling will never message you first or ask for your seed
            phrase; anyone who does is a scammer.
          </li>
          <li>
            Laws on tokens change and differ by country. A token could be treated as a security where you live, and
            you may owe tax on what you buy and sell.
          </li>
          <li>Veiling relies on other services (Solana, Arcium, Meteora, Arweave, wallets); any of them can fail.</li>
        </ul>
      </Part>
      {NETWORK_LABEL ? (
        <Part title={`About ${NETWORK_LABEL}`}>
          <p>
            Veiling is running on Solana {NETWORK_LABEL}, a test network. SOL and tokens there have no value, so
            nothing you do there can lose real money.
          </p>
        </Part>
      ) : null}
      <Part title="Questions">
        <p>
          The <a href="#/docs">docs</a> explain how every step works, and <a href="#/docs/safety">If something gets
          stuck</a> explains how to get your SOL back.
        </p>
        <Contact />
      </Part>
    </>
  );
}

function Privacy() {
  return (
    <>
      <Part title="The short version">
        <p>
          Veiling has no accounts, asks for no names, and uses no tracking cookies. What you do on Solana is public by
          design; everything else we keep to a minimum.
        </p>
      </Part>
      <Part title="Public on Solana and Arweave">
        <p>
          Your wallet address, your transactions, your bids' deposits and what you won are recorded on Solana, which
          anyone can read and which nobody can delete. Images and details uploaded for a sale are public on Arweave.
          Your bids' prices stay encrypted.
        </p>
      </Part>
      <Part title="What this website collects">
        <ul className="doc__bullets">
          <li>
            <strong>Visit counts.</strong> We use Plausible, which counts page views and a few actions (such as "bid
            placed") without cookies and without storing your IP address or anything that identifies you.
          </li>
          <li>
            <strong>Error reports.</strong> When the site breaks, Sentry records the error, the page and your browser
            type, so we can fix it. We turn off its collection of IP addresses and personal data.
          </li>
        </ul>
      </Part>
      <Part title="What you choose to give us">
        <ul className="doc__bullets">
          <li>
            <strong>Email reminders.</strong> If you ask to be emailed about a sale, we keep your email address with
            that sale and use it only for those reminders, sent through our email provider. Every email has a link to
            stop them, and we delete the address once the sale is over.
          </li>
          <li>
            <strong>Browser notifications.</strong> If you turn them on, your browser gives us an address to send them
            to. We delete it once the sale is over.
          </li>
          <li>
            <strong>Invites.</strong> When you accept an invite, we keep your wallet address, the inviting wallet and
            the message you signed, to count invite points.
          </li>
          <li>
            <strong>X verification.</strong> When a creator verifies a sale, we keep the X account and the post's link
            and show them on the sale's page.
          </li>
        </ul>
        <p>We do not sell or rent any of this, and we share it only with the services that deliver it, or when the law requires.</p>
      </Part>
      <Part title="Stored in your browser">
        <p>
          The site keeps a few settings in your own browser: the wallet you used last, that you agreed to the terms,
          an invite you followed, and notes on your bids. Clearing your browser's site data removes them.
        </p>
      </Part>
      <Part title="Other services">
        <p>
          Your browser talks to Solana through an RPC provider, which sees your IP address and requests. Your wallet
          app, Arweave gateways and X have their own privacy policies.
        </p>
      </Part>
      <Part title="Your choices">
        <p>
          You can ask us to delete your email address or invite record at any time. Veiling is not meant for anyone
          under 18. If this policy changes, the date at the top changes too.
        </p>
        <Contact />
      </Part>
    </>
  );
}

export function Legal({ page }: { page: LegalPage }) {
  const title = PAGES.find(([p]) => p === page)?.[1] ?? "Terms of Use";
  return (
    <main className="page legal">
      <h1 className="page__title">{title}</h1>
      <p className="page__lede">Last updated {updated}.</p>
      <nav className="legal__tabs" aria-label="Legal pages">
        {PAGES.map(([p, label]) => (
          <a key={p} href={`#/${p}`} className={`legal__tab${p === page ? " legal__tab--on" : ""}`} aria-current={p === page ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      <div className="docs__body legal__body">{page === "risks" ? <Risks /> : page === "privacy" ? <Privacy /> : <Terms />}</div>
    </main>
  );
}
