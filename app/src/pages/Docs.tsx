import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  EMERGENCY_DELAY_SECS,
  EVICTION_PREMIUM_PERCENT,
  FEATURE_CONTACT,
  GITHUB_URL,
  FREE_UPLOAD_TOTAL_BYTES,
  MAX_COLLECTION_BIDS,
  MAX_COLLECTION_SIZE,
  MAX_IMAGE_BYTES,
  MAX_ITEMS,
  MAX_NFTS_PER_CLAIM,
  MAX_ORIGINAL_BYTES,
  MAX_TOKEN_BIDS,
  MAX_ROYALTY_BPS,
  MAX_UPLOADED_ITEMS,
  NFT_MINT_COST_LAMPORTS,
  PAGE_BIDS,
  REVEAL_DELAY_SECS,
  MAX_SOFT_CLOSE_EXTENSION_SECS,
  SOFT_CLOSE_SECS,
  ANTI_SNIPER_FEE_BPS,
  ANTI_SNIPER_MINUTES,
  DAMM_PROTOCOL_FEE_PERCENT,
  POOL_FEE_TIERS,
  SELLER_POOL_FEE_BPS,
  LAUNCH_DECIMALS,
  LAUNCH_HOURS,
  LAUNCH_MIN_BID,
  LAUNCH_MIN_RAISE,
  LAUNCH_SALE_SUPPLY,
  LAUNCH_SUPPLY,
} from "../config";
import { useLoader } from "../components/ui";
import { type FeeConfig, bidCrankFee, fetchCrankRewards, fetchFeeConfig, formatPercent, sellerCrankFee, supplyShare } from "../lib/chain";
import { formatCount, formatSol, formatTokens } from "../lib/format";
import { formatKb, formatMb } from "../lib/images";

/** Hard caps compiled into the program; no admin can charge more. */
const MAX_LISTING_FEE_LAMPORTS = 500_000_000n;
const MAX_SALE_FEE_BPS = 500;

export const DOC_SECTIONS: [string, string][] = [
  ["how", "How an auction works"],
  ["bidding", "Bidding"],
  ["price", "The final price"],
  ["launch", "Drops and collections"],
  ["nfts", "NFT collections"],
  ["token", "New tokens"],
  ["liquidity", "The token's pool"],
  ["fees", "Fees"],
  ["privacy", "What stays private"],
  ["safety", "If something gets stuck"],
  ["points", "Stats and points"],
  ["faq", "Questions"],
  ["source", "Source code"],
  ["featured", "Getting featured"],
];

/**
 * Short answers to what people ask most, shown at the end of the docs and
 * given to search engines as FAQ structured data (`prerender.tsx`).
 */
export function FAQ(fees: FeeConfig | null | undefined): { question: string; answer: string }[] {
  const listing = fees ? (fees.listingFee > 0n ? `a ${formatSol(fees.listingFee)} SOL listing fee` : "no listing fee") : "a small listing fee";
  const sale = fees ? `${formatPercent(fees.saleFeeBps)} of what the sale raises` : "a small share of what the sale raises";
  const share = supplyShare(LAUNCH_SALE_SUPPLY);
  return [
    {
      question: "What is Veiling?",
      answer:
        "Veiling is a launchpad on Solana that sells new tokens and NFT collections by sealed-bid auction. Buyers bid in private, and when bidding closes one final price is found that every winner pays.",
    },
    {
      question: "How does a sealed bid stay private?",
      answer:
        "Your price is encrypted in your browser before it leaves it. Arcium's network checks and settles the bids without anyone, Veiling included, seeing them. Only the final price is made public.",
    },
    {
      question: "Does every winner pay the same price?",
      answer:
        "Yes. Every winner pays the final price, which is never above their own bid. Bids below it win nothing and get their whole deposit back.",
    },
    {
      question: "How does a new token launch work?",
      answer: `${share} of the supply is sold by sealed bid over ${LAUNCH_HOURS.join(", ").replace(/, (\d+)$/, " or $1")} hours. If it sells out, the token is made and everything raised, less the platform fee, opens a Meteora pool at the final price, locked for good. If not, no token is ever made and every deposit comes back in full.`,
    },
    {
      question: "What does FDV mean on Veiling?",
      answer:
        "A new token's prices are shown and bid as its fully diluted value (FDV): the price per token times its whole supply of 1,000,000,000 tokens. A bid names the highest FDV it would pay, and the token starts trading at the final FDV.",
    },
    {
      question: "Can a token's creator sell into the market or mint more?",
      answer:
        "No. The creator gets no tokens and none of the SOL raised, the pool's liquidity is locked forever, and the token's mint is closed for good right after it is made.",
    },
    {
      question: "What does it cost?",
      answer: `Sellers pay ${listing} and ${sale}. Each bid pays a small processing fee for the private steps that finish the sale. Deposits that are not spent come back in full.`,
    },
    {
      question: "What happens if a sale gets stuck?",
      answer:
        "Nothing stays locked. If Arcium's network stops answering, anyone can return every unsettled bid's whole deposit to its owner one day after bidding ends for a new token, or three days for an NFT collection.",
    },
    {
      question: "Which wallets work with Veiling?",
      answer: "Phantom, Solflare, Backpack and other Solana wallets that support the Wallet Standard.",
    },
  ];
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="doc" id={id} aria-labelledby={`${id}-title`} data-reveal>
      <h2 id={`${id}-title`} className="doc__title">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Docs({ section }: { section: string }) {
  const fees = useLoader(fetchFeeConfig, []);
  const listingFee = fees.data ? (fees.data.listingFee > 0n ? `${formatSol(fees.data.listingFee)} SOL` : "free") : "…";
  const saleFee = fees.data ? formatPercent(fees.data.saleFeeBps) : "…";
  const crank = useLoader(fetchCrankRewards, []);
  const sellerFund = crank.data ? `${formatSol(sellerCrankFee(crank.data, "token"))} SOL` : "…";
  const drawReward = crank.data ? `${formatSol(crank.data.seedDraw)} SOL` : "…";
  const bidFee = crank.data ? `${formatSol(bidCrankFee(crank.data))} SOL` : "…";
  const days = EMERGENCY_DELAY_SECS / 86_400;
  const revealDays = REVEAL_DELAY_SECS / 86_400;
  const saleShare = supplyShare(LAUNCH_SALE_SUPPLY);

  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ block: "start" });
  }, [section]);

  // The section being read: the last one whose top has passed under the top bar.
  const [active, setActive] = useState(section || DOC_SECTIONS[0][0]);
  const root = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const bar = (document.querySelector(".topbar") as HTMLElement | null)?.offsetHeight ?? 64;
      root.current?.style.setProperty("--topbar-h", `${bar}px`);
      const line = bar + (menu.current?.offsetHeight ?? 0) + 24;
      let current = DOC_SECTIONS[0][0];
      for (const [id] of DOC_SECTIONS) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) current = id;
      }
      // At the very bottom the last sections can never reach the line.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        current = DOC_SECTIONS[DOC_SECTIONS.length - 1][0];
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  const activeTitle = DOC_SECTIONS.find(([id]) => id === active)?.[1] ?? DOC_SECTIONS[0][1];
  const links = (
    <ul>
      {DOC_SECTIONS.map(([id, title]) => (
        <li key={id}>
          <a
            href={`#/docs/${id}`}
            aria-current={active === id ? "true" : undefined}
            onClick={() => menu.current?.removeAttribute("open")}
          >
            {title}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <main className="page docs" ref={root}>
      <header className="docs__head">
        <h1 className="page__title">How Veiling works</h1>
        <p className="page__lede">
          Veiling sells new tokens and NFT collections through sealed bids and a single final price. This page
          explains what happens to your bid, your deposit and your sale, and what everyone else can see.
        </p>
      </header>
      <div className="docs__layout">
        <nav className="docs__nav" aria-label="On this page">
          {links}
        </nav>
        <details className="docs__menu" ref={menu}>
          <summary>
            <span className="docs__menu-label">On this page</span>
            <span className="docs__menu-current">{activeTitle}</span>
          </summary>
          <nav aria-label="On this page, compact">{links}</nav>
        </details>
        <div className="docs__body">
          <Section id="how" title="How an auction works">
            <ol className="timeline">
              <li>
                <h3>The seller opens it</h3>
                <p>
                  A new token's sale names the token and sets a target, which fixes its minimum price; nothing is
                  minted yet. A collection sale creates the collection and sets how many NFTs are for sale, a minimum
                  price and the most NFTs one bid may ask for.
                </p>
              </li>
              <li>
                <h3>Buyers place sealed bids</h3>
                <p>
                  A token bid is a SOL budget and the most it would pay per token. A collection bid is a number of
                  NFTs and the most it would pay for each. Both are encrypted in the buyer's browser; SOL that covers
                  them goes into the bid as its deposit.
                </p>
              </li>
              <li>
                <h3>The bids are checked in private</h3>
                <p>
                  After bidding closes, Arcium's network checks each bid against the terms and its deposit, four
                  at a time. No single machine ever sees a bid.
                </p>
              </li>
              <li>
                <h3>The final price is revealed</h3>
                <p>
                  The highest price at which the bids cover the supply. Only that price and the demand at and above
                  it are revealed.
                </p>
              </li>
              <li>
                <h3>Each bid is settled</h3>
                <p>
                  Every winner pays the final price. Payments move to the auction; the rest of each deposit waits
                  for its owner. The bids checked together, four at a time, are settled together too.
                </p>
              </li>
              <li>
                <h3>Everyone collects</h3>
                <p>
                  Winners receive their tokens or NFTs and every bidder gets the unused part of their deposit back.
                  A new token is made first and its pool opened with what the sale raised; a collection's seller
                  claims the proceeds. The seller then closes the auction to get its rent back.
                </p>
              </li>
            </ol>
            <p className="doc__note">
              Anyone can take any of the settlement steps for anyone else. Funds and tokens only ever go to their
              owner, so nobody depends on the seller or the platform to finish an auction.
            </p>
          </Section>

          <Section id="bidding" title="Bidding">
            <p>
              A new token's bidding opens right away and runs for {LAUNCH_HOURS.join(", ").replace(/, (\d+)$/, " or $1")}{" "}
              hours. A collection's seller can open bidding right away or schedule it up to 30 days ahead. A scheduled auction is listed
              as upcoming, with its terms public and its tokens already held by the program; bids are taken only from
              its start, for its full bidding time. Until the first bid, the seller can still cancel it.
            </p>
            <p>
              Set the most you would really pay. Every winner pays the final price, which is never above their
              own, so bidding your true limit is the simple strategy.
            </p>
            <dl className="doc__list">
              <div>
                <dt>Tokens</dt>
                <dd>
                  Set the SOL you want to spend and your highest price per token, which for a new token is the
                  highest FDV you would pay. If you win above the final
                  price, your whole budget buys tokens at that price, so the lower it ends, the more you get. Both
                  are sealed. Your deposit only has to cover the budget, so it does not show it, and a large deposit
                  says nothing about real demand.
                </dd>
              </div>
              <div>
                <dt>NFTs</dt>
                <dd>
                  Choose how many NFTs, up to the auction's limit per bid, and your highest price for each. The
                  deposit must cover both.
                </dd>
              </div>
            </dl>
            <p>The deposit only has to cover the bid, and it can be set three ways:</p>
            <dl className="doc__list">
              <div>
                <dt>Private</dt>
                <dd>
                  Rounds up to 1, 2, 5, 10 and so on: a token budget, or a collection bid's size and price. It shows
                  neither exactly.
                </dd>
              </div>
              <div>
                <dt>Exact</dt>
                <dd>
                  Exactly the budget, or price × NFTs. Cheapest to lock up, but anyone can work out your bid from it.
                </dd>
              </div>
              <div>
                <dt>Custom</dt>
                <dd>Any amount above what it covers. The further from it, the less it reveals.</dd>
              </div>
            </dl>
            <p>
              Until bidding closes you can raise a bid: a higher price or a larger size, sealed again, with more
              deposit if it needs it. A bid can never be lowered or withdrawn, and a deposit never shrinks, so
              nobody can show demand and then pull it. An auction starts with room for {formatCount(PAGE_BIDS)} bids and
              grows on its own, {formatCount(PAGE_BIDS)} at a time, up to {formatCount(MAX_TOKEN_BIDS)} for a token sale
              and {formatCount(MAX_COLLECTION_BIDS)} for a collection, so even a{" "}
              {formatCount(MAX_COLLECTION_SIZE)}-NFT collection can sell out at one NFT a bid. However far it grows, it
              stays one auction with one final price. The bids that land on the extra room pay for it (see
              Fees). After that, a new bid can replace the one with the smallest deposit by depositing {EVICTION_PREMIUM_PERCENT.toString()}% more, and the replaced bid gets
              its whole deposit back. A replacement in the last {SOFT_CLOSE_SECS / 60} minutes keeps bidding open{" "}
              {SOFT_CLOSE_SECS / 60} more minutes, up to {MAX_SOFT_CLOSE_EXTENSION_SECS / 3600} hours past the original
              end, so nobody can be pushed out at the last second without time to answer.
            </p>
          </Section>

          <Section id="price" title="The final price">
            <p>
              Bids are lined up from the highest price down. The final price (in auction terms, the clearing price) is the highest price at which the
              bids at or above it cover everything for sale: for tokens, what their budgets buy at that price; for
              NFTs, how many they ask for.
            </p>
            <ul className="doc__bullets">
              <li>
                Bids above the final price win. A token bid spends its whole budget at that price; a collection
                bid gets every NFT it asked for.
              </li>
              <li>
                Bids exactly at the final price share what is left: token bids by budget, collection bids by
                size. Shares are rounded down. Tokens lost to rounding are never made; NFTs lost to rounding
                go to the earliest of those bids, one each, so every NFT is sold. Three NFTs and four bids of one
                each at that price: the first three bids win.
              </li>
              <li>Bids below it win nothing and get their whole deposit back.</li>
              <li>
                If the bids never cover the supply, a new token's sale does not go ahead: no token is made and every
                bid is refunded in full. In a collection sale every valid bid then wins at the minimum price, and the
                NFTs nobody won are never minted.
              </li>
            </ul>
            <p>
              A bid below the minimum price counts as no bid, and so does a collection bid that asks for too many
              NFTs or whose deposit does not cover them. It is refunded in full.
            </p>
            <p>
              With more than {formatCount(PAGE_BIDS)} bids, Arcium finds the same price a page of{" "}
              {formatCount(PAGE_BIDS)} bids at a time, four bits of the price per pass over the pages: 9 steps for 2
              pages, 25 for 4, 313 for a collection's full 40 (about an hour). Each pass reveals only the next four bits
              of the final price, which becomes public anyway; the demand added up in between stays encrypted.
              Bids are still checked and settled four at a time, so the more bids, the longer settling takes after
              bidding ends.
            </p>
          </Section>

          <Section id="launch" title="Drops and collections">
            <p>
              NFTs can be launched two ways, as on OpenSea. Either way they sell through the same sealed auction:
              buyers bid for a number of NFTs, everyone who wins pays one price, and which NFTs each winner gets is
              drawn at random after the sale.
            </p>
            <dl className="doc__list">
              <div>
                <dt>Drop</dt>
                <dd>
                  A whole collection at once. Upload one image per NFT, up to {formatCount(MAX_UPLOADED_ITEMS)}, or one
                  image every NFT shares, or link to metadata you host. A metadata sheet can give every NFT its own
                  name, description, link and traits. The art can stay hidden until the sale ends.
                </dd>
              </div>
              <div>
                <dt>Collection</dt>
                <dd>
                  Built item by item, up to {formatCount(MAX_ITEMS)} items. Each item has its own image, name,
                  description, link and traits, and a number of editions: an item with three editions is three NFTs,
                  named Name #1 to Name #3; an item with one is named just Name.
                </dd>
              </div>
            </dl>
            <h3 className="doc__subtitle">The metadata sheet</h3>
            <p>
              A CSV file in the format OpenSea uses for drops, one row per NFT. Every column is optional, and
              spreadsheets saved with semicolons work too. The launch page offers a template with your files already
              listed.
            </p>
            <table className="doc__table">
              <thead>
                <tr>
                  <th scope="col">Column</th>
                  <th scope="col">What it holds</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">tokenID</th>
                  <td>The NFT's number, from 1 (or from 0) with none missing. Without it, rows are numbered in order.</td>
                </tr>
                <tr>
                  <th scope="row">name</th>
                  <td>
                    The NFT's name, up to 24 bytes, for drops of up to {formatCount(MAX_ITEMS)} NFTs. Leave it empty to
                    name them Name #1, Name #2 and so on.
                  </td>
                </tr>
                <tr>
                  <th scope="row">description</th>
                  <td>The NFT's own description; without one, the collection's.</td>
                </tr>
                <tr>
                  <th scope="row">file_name</th>
                  <td>Which of the chosen images the NFT shows. Without it, images go in file-name order.</td>
                </tr>
                <tr>
                  <th scope="row">external_url</th>
                  <td>A link to the NFT's page on your site (https).</td>
                </tr>
                <tr>
                  <th scope="row">attributes[Trait]</th>
                  <td>One column per trait, such as attributes[Background]; an empty cell leaves the trait out.</td>
                </tr>
              </tbody>
            </table>
            <h3 className="doc__subtitle">Hidden art</h3>
            <ul className="doc__bullets">
              <li>
                A drop can keep its art hidden until bidding ends, as OpenSea's drops do before their reveal. Bidders
                see the collection's name, logo, description and a preview image.
              </li>
              <li>
                The link to the art is fixed on chain when the auction opens, so the seller cannot swap the art after
                seeing the bids. Art uploaded here is signed at launch and stored encrypted, under a key that only the
                seller's wallet can make again; the reveal publishes exactly those files at that link. Art the seller
                hosts must be online at that link when they reveal.
              </li>
              <li>
                The seller has {revealDays} days after bidding ends to reveal. Until then no NFT can be minted and the
                seller is not paid. If they do not reveal in time, every winner takes their payment back and no NFT
                is ever minted.
              </li>
              <li>
                Hidden art is stored twice, sealed at launch and in the open at the reveal, so it costs about twice
                as much to store. Hidden drops are numbered rather than named, as names would show before the
                reveal.
              </li>
            </ul>
          </Section>

          <Section id="nfts" title="NFT collections">
            <p>
              A collection sale creates a new Metaplex Core collection when the auction opens, of up to{" "}
              {formatCount(MAX_COLLECTION_SIZE)} NFTs. While the sale runs, only the auction can add NFTs to it.
            </p>
            <ul className="doc__bullets">
              <li>
                NFTs are minted only when a winner collects them, straight to the winner. NFTs nobody wins are never
                minted.
              </li>
              <li>
                The NFTs are Name #1, Name #2 and so on, or named per item: a collection's item list, stored with its
                auction, gives every NFT its item's name and edition. With one metadata file per NFT, #1 shows the
                first (0.json in the folder), #2 the second.
              </li>
              <li>
                Which NFTs each winner gets is random. As each winning bid settles it takes the next places in line,
                one per NFT it won. Once every bid is settled, Arcium's network draws a random seed together, so no
                single node picks it, and the seed shuffles places into NFT numbers. Nobody knows the seed while
                places are handed out, so nobody can pick an NFT, not even by timing their bid or their claim. If the
                draw has still not happened when the safety net opens, each place keeps its own number so winners
                can always collect.
              </li>
              <li>
                Sellers can upload the art when they launch: a collection image, and one image for every NFT or one
                per NFT. The app stores the images and their metadata on Arweave through ArDrive Turbo, where they
                are public and permanent. Sellers pick how: compressed, with each image made{" "}
                {formatKb(MAX_IMAGE_BYTES)} or smaller, which is free up to {formatMb(FREE_UPLOAD_TOTAL_BYTES)} in all;
                or their original files, up to {formatMb(MAX_ORIGINAL_BYTES)} each. Either way, hidden details such as
                where a photo was taken are removed first.
              </li>
              <li>
                Storage beyond the free allowance is paid by the seller, once, in SOL, before the auction opens; the
                price comes from Turbo when they launch, and bidders never pay for storage. The seller's wallet signs
                a message that makes their upload key, then sends the SOL to Turbo's address with a note crediting
                that key. The key can only upload and spend that credit, and credit left over stays for the seller's
                next upload.
              </li>
              <li>
                Minting costs about {formatSol(NFT_MINT_COST_LAMPORTS)} SOL per NFT in rent and Metaplex fees,
                paid by whoever collects. Up to {MAX_NFTS_PER_CLAIM} NFTs are minted per transaction.
              </li>
              <li>
                A seller can add a royalty of up to {MAX_ROYALTY_BPS / 100}% on resales, paid to them by
                marketplaces that honour it.
              </li>
              <li>
                When the sale is closed, the seller becomes the collection's update authority. Like any creator,
                they can then change the collection's and its NFTs' metadata.
              </li>
            </ul>
          </Section>

          <Section id="token" title="New tokens">
            <p>
              A new token is sold before it exists, and only comes into being if its sale succeeds. The creator gives
              it a name, a symbol and an image, and picks a target of at least {formatSol(LAUNCH_MIN_RAISE)} SOL.
            </p>
            <ul className="doc__bullets">
              <li>
                <strong>{saleShare} of the supply for sale.</strong> Every new token has a total supply of at most{" "}
                {formatTokens(LAUNCH_SUPPLY, LAUNCH_DECIMALS, 0)}. {saleShare} of it is sold by sealed bid, from{" "}
                {formatSol(LAUNCH_MIN_BID)} SOL a bid. The minimum price is the target divided by that share, so the
                token is made only if the sale sells out.
              </li>
              <li>
                <strong>Priced as FDV.</strong> A new token's prices are shown, and bid, as its fully diluted value:
                the price per token times its whole supply of {formatTokens(LAUNCH_SUPPLY, LAUNCH_DECIMALS, 0)}. A
                bid names the highest FDV it would pay. The minimum FDV is twice the target, and the token starts
                trading at the final FDV.
              </li>
              <li>
                <strong>Born with its pool.</strong> If it sells out, anyone can make the token: exactly the share
                that was sold and the share its pool takes are minted, and nobody can ever make more. Every SOL raised,
                less the sale fee, opens a Meteora pool at the final price with up to the other {saleShare} of the
                supply. What the pool does not take is never made. Winners collect their tokens once the pool is
                open, so nobody holds any before it.
              </li>
              <li>
                <strong>Or never at all.</strong> If it misses the target, no token is ever made and every bid's
                deposit comes back in full (the small processing fee each bid paid does not). The creator closes the
                sale and gets their deposit and rents back; only the listing fee and what settlement used are spent.
              </li>
              <li>
                <strong>No creator allocation.</strong> The creator holds none of the supply and takes no SOL from the
                sale. They earn {formatPercent(SELLER_POOL_FEE_BPS)} of the pool's trading fees after Meteora's share,
                for good.
              </li>
            </ul>
          </Section>

          <Section id="liquidity" title="The token's pool">
            <p>
              A new token's pool opens on Meteora as soon as its sale settles, at exactly the final price. Winners
              can trade right away, and the market starts from the price everyone paid.
            </p>
            <ul className="doc__bullets">
              <li>
                <strong>Every SOL raised.</strong> All of the proceeds after the platform fee go into the pool, with
                the share of the supply that SOL buys at the final price. The creator picks the pool's trading fee (
                {POOL_FEE_TIERS.map((bps) => formatPercent(bps)).join(", ")}) before any bid, and it cannot change.
              </li>
              <li>
                <strong>Locked forever.</strong> The pool belongs to the program, which has no way to withdraw it.
                Nobody, the creator included, can pull the liquidity.
              </li>
              <li>
                <strong>No snipers.</strong> Trading opens with a {formatPercent(ANTI_SNIPER_FEE_BPS)} fee that falls
                to the pool's fee over {ANTI_SNIPER_MINUTES} minutes, so bots gain nothing by buying first. Nobody
                holds the token before the pool opens, so nobody can open a pool of their own first.
              </li>
              <li>
                <strong>Fees for as long as it trades.</strong> Meteora keeps {DAMM_PROTOCOL_FEE_PERCENT}% of every
                trading fee. Anyone can pay out the rest, in SOL: {formatPercent(SELLER_POOL_FEE_BPS)} to the creator
                and {formatPercent(10_000 - SELLER_POOL_FEE_BPS)} to Veiling.
              </li>
            </ul>
          </Section>

          <Section id="fees" title="Fees">
            <table className="doc__table">
              <thead>
                <tr>
                  <th scope="col">Fee</th>
                  <th scope="col">Now</th>
                  <th scope="col">Who pays, and when</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Listing</th>
                  <td>{listingFee}</td>
                  <td>The seller, when the auction opens. Not refunded if the auction is cancelled.</td>
                </tr>
                <tr>
                  <th scope="row">Sale</th>
                  <td>{saleFee} of the proceeds</td>
                  <td>
                    Out of the proceeds: when a collection's seller claims them, or when a new token's pool opens.
                    Buyers pay nothing extra.
                  </td>
                </tr>
                <tr>
                  <th scope="row">Processing fund</th>
                  <td>
                    {sellerFund} per auction ({drawReward} more for a collection), {bidFee} per bid
                  </td>
                  <td>
                    The seller when the auction opens, and each bidder when bidding. It pays whoever runs the private
                    steps that settle the sale. Not refunded to bidders; what is left goes back to the seller. If
                    more than {formatCount(PAGE_BIDS)} bids come, it also pays for the extra room and for finding the
                    price across it: each bid that lands there adds a room fee, its share of that room (about 0.0011
                    SOL), so full room pays for itself, and what partly filled room leaves short comes out of the
                    proceeds.
                  </td>
                </tr>
                <tr>
                  <th scope="row">NFT minting</th>
                  <td>about {formatSol(NFT_MINT_COST_LAMPORTS)} SOL each</td>
                  <td>Whoever collects the NFT. This is rent and Metaplex's fee, not a platform fee.</td>
                </tr>
              </tbody>
            </table>
            <p>
              The program caps the platform's fees at {formatSol(MAX_LISTING_FEE_LAMPORTS)} SOL to list and{" "}
              {formatPercent(MAX_SALE_FEE_BPS)} of a sale. A seller opens an auction only at the fees shown when
              signing, and each auction keeps the sale fee it opened with. Account rent for the auction and every
              bid comes back when they are closed.
            </p>
            <p>
              The private steps after bidding (checking the bids, finding the price, settling each bid and, for a
              collection, the shuffle) each cost a network fee to start. Anyone can start them, and each pays whoever
              did it a fixed reward from the auction's processing fund once it succeeds, a little above that fee. So
              a sale does not depend on the seller, the bidders or us being online, and running the steps never costs anyone
              money.
            </p>
          </Section>

          <Section id="privacy" title="What stays private">
            <table className="doc__table">
              <thead>
                <tr>
                  <th scope="col">Public</th>
                  <th scope="col">Private</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>How many bids there are, each deposit and the total deposited</td>
                  <td>The price of every bid, winning or not</td>
                </tr>
                <tr>
                  <td>The final price and the demand at and above it</td>
                  <td>The budget of every losing token bid and the size of every losing collection bid</td>
                </tr>
                <tr>
                  <td>What each winner received and paid</td>
                  <td>Every bid while the bids are checked</td>
                </tr>
                <tr>
                  <td>A hidden drop's details, and the link its art will be at</td>
                  <td>A hidden drop's art, until its seller reveals it</td>
                </tr>
              </tbody>
            </table>
            <p>
              Deposits are public, but a deposit only covers a bid: a token bid's budget and a collection bid's
              price times size are sealed, and a deposit can be larger to hide them. A winning bid's budget or size
              becomes known when it is settled, because its payment is public. Veiling shows only the total
              deposited and never lists who bid. Solana itself is public, though: each deposit and the wallet that
              made it can be read from the chain by anyone who looks. Bids exactly at the final price are known to
              be at it once settled.
            </p>
            <p>
              Your own bids' prices and sizes are saved on chain next to each bid, encrypted under a key that only
              your wallet can make by signing a message. That is how you see them on another device: sign once and
              they show. Nobody else, including us, can read them. The small rent each note holds comes back when you
              collect the bid.
            </p>
          </Section>

          <Section id="safety" title="If something gets stuck">
            <p>
              If Arcium's network stops answering, nothing stays locked. {days} days after bidding ends, or one day
              for a new token, anyone can return an unsettled bid's whole deposit to its owner. Settled bids can
              always be collected: a collection's seller can claim what they paid, and a new token is made with
              what its settled bids bought.
            </p>
            <p>
              A hidden drop that its seller does not reveal within {revealDays} days of the end of bidding pays
              every winner back in full instead of minting anything; anyone can send those refunds.
            </p>
          </Section>

          <Section id="points" title="Stats and points">
            <p>
              Every step after bidding is public and paid from the sale itself, so a keeper bot run by Veiling takes
              each sale to its end as soon as bidding closes: checking the bids, finding the final price, working
              out every bid, making a new token and its pool, and sending out tokens, NFTs and refunds. If it is ever
              slow, anyone can press <strong>Finish the sale</strong> on the sale page: you add a little SOL for
              network fees to a one-time wallet in your browser, it runs the remaining steps, and what is left
              comes back to you along with the steps' rewards.
            </p>
            <p>
              The <a href="#/stats">Stats</a> page counts everything since the first sale, read from the program's
              transaction history, and ranks wallets by points:
            </p>
            <ul className="doc__bullets">
              <li>100 points for every SOL you pay for what you win;</li>
              <li>50 points for every SOL your sales raise;</li>
              <li>5 points per bid, up to 3 bids in each sale;</li>
              <li>5 points for each finishing step you run.</li>
            </ul>
            <p>Points have no cash value, and the rules may change.</p>
          </Section>

          <Section id="faq" title="Questions">
            <dl className="doc__list">
              {FAQ(fees.data).map(({ question, answer }) => (
                <div key={question}>
                  <dt>{question}</dt>
                  <dd>{answer}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section id="source" title="Source code">
            <p>
              Veiling is open source: the Solana program, the Arcium circuits that work with the sealed bids, and
              this app are all on{" "}
              <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
                GitHub
              </a>
              . Anyone can read how bids are sealed, how the price is found and where every lamport goes, and check
              them against the program on chain.
            </p>
          </Section>

          <Section id="featured" title="Getting featured">
            <p>
              Featured auctions are shown first and on the front page. They are picked by hand: send{" "}
              <a href={FEATURE_CONTACT.href} target="_blank" rel="noreferrer noopener">
                {FEATURE_CONTACT.label}
              </a>{" "}
              a direct message on X with your auction's link. Featuring changes only where an auction is listed,
              never its terms or funds.
            </p>
          </Section>

          <p className="doc__fine">
            Like any software, Veiling's program and circuits may contain bugs. Bid only what you can afford to
            lose.
          </p>
        </div>
      </div>
    </main>
  );
}
