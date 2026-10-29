import { useMemo, useState } from "react";
import {
  LAUNCH_DECIMALS,
  LAUNCH_HOURS,
  LAUNCH_MIN_BID,
  LAUNCH_MIN_RAISE,
  LAUNCH_SALE_SUPPLY,
  LAUNCH_SUPPLY,
  MAX_LAUNCH_NAME_LEN,
  MAX_LAUNCH_SYMBOL_LEN,
  MAX_TOKEN_BIDS,
} from "../config";
import { buildCreateLaunch } from "../lib/actions";
import { freeTarget } from "../lib/arweave";
import { fetchCrankRewards, fetchFeeConfig, formatPercent, launchFdv, launchSaleTerms, sellerCrankFee, supplyShare } from "../lib/chain";
import { formatCount, formatSol, formatTokens, parseDecimal } from "../lib/format";
import type { PreparedImage } from "../lib/images";
import { track } from "../lib/analytics";
import { OPEN_TO_ANYONE, accessPlan, withSaleRules, type BidAccess } from "../lib/saleRules";
import { sendTransactions } from "../lib/tx";
import { uploadTokenMetadata } from "../lib/uploads";
import { requestConnect, useWallet } from "../lib/wallet";
import { ImagePicker, isSmallImage, useImageUrl } from "./ImagePicker";
import { BidAccessField, MAX_DESCRIPTION_LEN, isLinkOrEmpty } from "./LaunchParts";
import { Button, Notice, useAction, useLoader } from "./ui";

/** What the creator deposits for the token's accounts and its pool; it comes back. */
const LAUNCH_DEPOSIT = 40_000_000n;
const POOL_FEES: [number, string][] = [
  [25, "0.25%"],
  [100, "1%"],
  [200, "2%"],
];

function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          type="button"
          className={`segmented__item${value === v ? " segmented__item--on" : ""}`}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * A new token, sold before it exists (a fair launch): 50% of its supply is
 * sold by sealed bid; if it sells out, the token is made and every SOL raised
 * opens its pool with up to the other 50%. If not, no token is made and every
 * bid is refunded.
 */
export function TokenLaunchForm() {
  const { signer } = useWallet();
  const action = useAction();
  const fees = useLoader(fetchFeeConfig, []);
  const crank = useLoader(fetchCrankRewards, []);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [description, setDescription] = useState("");
  const [targetInput, setTargetInput] = useState("25");
  const [hours, setHours] = useState<number>(1);
  const [poolFee, setPoolFee] = useState<number>(100);
  const [website, setWebsite] = useState("");
  const [x, setX] = useState("");
  const [access, setAccess] = useState<BidAccess>(OPEN_TO_ANYONE);
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState<"form" | "upload" | "open">("form");
  const art = useImageUrl(image);

  const target = parseDecimal(targetInput, 9);
  const terms = useMemo(() => (target ? launchSaleTerms(target) : null), [target]);
  const ticker = symbol.trim().toUpperCase();

  const problems: string[] = [];
  if (!name.trim()) problems.push("Give the token a name.");
  else if (new TextEncoder().encode(name.trim()).length > MAX_LAUNCH_NAME_LEN) problems.push(`The name is longer than ${MAX_LAUNCH_NAME_LEN} bytes.`);
  if (!ticker) problems.push("Give the token a symbol.");
  else if (new TextEncoder().encode(ticker).length > MAX_LAUNCH_SYMBOL_LEN) problems.push(`The symbol is longer than ${MAX_LAUNCH_SYMBOL_LEN} bytes.`);
  if (!image) problems.push("Choose the token's image.");
  if (description.length > MAX_DESCRIPTION_LEN) problems.push(`The description is longer than ${MAX_DESCRIPTION_LEN} characters.`);
  if (target === null || target < LAUNCH_MIN_RAISE) problems.push(`The target is at least ${formatSol(LAUNCH_MIN_RAISE)} SOL.`);
  else if (!terms) problems.push("That target cannot be priced; try a rounder number.");
  if (!isLinkOrEmpty(website) || !isLinkOrEmpty(x)) problems.push("Links must start with https://.");
  const accessed = accessPlan(access, LAUNCH_MIN_BID);
  if (accessed.problem) problems.push(accessed.problem);
  if (!fees.data) problems.push("The platform's fees are not loaded yet.");

  // Prices of a new token read as its FDV: the price per token × its whole supply.
  const fdv = terms ? `${formatSol(launchFdv(terms.minPrice, terms.priceUnit))} SOL` : null;
  const net = terms && fees.data ? terms.target - (terms.target * BigInt(fees.data.saleFeeBps)) / 10_000n : null;
  const pooledTokens = net && terms ? (net * terms.priceUnit) / terms.minPrice : null;
  const goods = ticker || "tokens";
  const saleShare = supplyShare(LAUNCH_SALE_SUPPLY);

  const launch = () =>
    action
      .run("launch", async () => {
        setTouched(true);
        if (!signer) throw new Error("Connect a wallet first.");
        if (problems.length > 0 || !terms || !fees.data || !image) throw new Error(problems[0] ?? "Check the form.");
        setStep("upload");
        const uri = await uploadTokenMetadata(
          { name: name.trim(), symbol: ticker, description, image, links: { website: website.trim(), x: x.trim() } },
          () => {},
          freeTarget()
        );
        setStep("open");
        const built = await buildCreateLaunch(
          signer.publicKey,
          { name: name.trim(), symbol: ticker, uri },
          { priceUnit: terms.priceUnit, minPrice: terms.minPrice, durationSecs: hours * 3600, startTime: 0, tradeFeeBps: poolFee },
          fees.data
        );
        const txs = await withSaleRules(built.tx, signer.publicKey, built.auction, accessed);
        await sendTransactions(txs, signer);
        track("Sale launched", { kind: "new token", allowlist: access.listed });
        window.location.hash = `#/auction/${built.auction.toBase58()}`;
      })
      .finally(() => setStep("form"));

  return (
    <div className="launch">
      <form
        className="launch__form"
        onSubmit={(e) => {
          e.preventDefault();
          launch();
        }}
      >
        <fieldset className="group">
          <legend className="group__title">Token</legend>
          <p className="hint">
            Nothing is made now. The token is made only if its sale sells out, with a total supply of at most{" "}
            {formatTokens(LAUNCH_SUPPLY, LAUNCH_DECIMALS, 0)}. You hold none: buy at the sale like everyone else.
          </p>
          <div className="field-row">
            <div className="field">
              <label htmlFor="fl-name">Name</label>
              <input id="fl-name" value={name} maxLength={MAX_LAUNCH_NAME_LEN} onChange={(e) => setName(e.target.value)} placeholder="Lantern" />
            </div>
            <div className="field field--narrow">
              <label htmlFor="fl-symbol">Symbol</label>
              <input
                id="fl-symbol"
                value={symbol}
                maxLength={MAX_LAUNCH_SYMBOL_LEN}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="LNTN"
                autoCapitalize="characters"
              />
            </div>
          </div>
          <ImagePicker id="fl-image" label="Token image" value={image} onChange={setImage} />
          <div className="field">
            <label htmlFor="fl-description">Description (optional)</label>
            <textarea id="fl-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="fl-web">Website (optional)</label>
              <input id="fl-web" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" aria-invalid={!isLinkOrEmpty(website)} />
            </div>
            <div className="field">
              <label htmlFor="fl-x">X account (optional)</label>
              <input id="fl-x" value={x} onChange={(e) => setX(e.target.value)} placeholder="https://x.com/…" aria-invalid={!isLinkOrEmpty(x)} />
            </div>
          </div>
          <p className="hint">Once the sale is open you can verify the X account, so bidders see a Verified badge.</p>
        </fieldset>

        <fieldset className="group">
          <legend className="group__title">Sale</legend>
          <div className="field">
            <label htmlFor="fl-target">Target (SOL)</label>
            <input id="fl-target" inputMode="decimal" value={targetInput} onChange={(e) => setTargetInput(e.target.value)} />
            <p className="hint">
              What selling {saleShare} of the supply must raise, at least {formatSol(LAUNCH_MIN_RAISE)} SOL. It sets
              the lowest price, read as the token's whole value (FDV): {fdv ?? "…"}. Bids name the highest FDV they
              would pay; everyone who wins pays the one price where demand meets the supply, and the token starts
              trading there.
            </p>
          </div>
          <div className="field">
            <span className="field__label" id="fl-hours">
              Bidding time
            </span>
            <Choice label="Bidding time" value={hours} options={LAUNCH_HOURS.map((h) => [h, `${h} hour${h > 1 ? "s" : ""}`])} onChange={setHours} />
            <p className="hint">
              Bids start at {formatSol(LAUNCH_MIN_BID)} SOL. Bidding opens as soon as the sale does. Only if all{" "}
              {formatCount(MAX_TOKEN_BIDS)} bid spots fill up and a bid is pushed out near the end does it run a
              little longer, so that bidder can answer.
            </p>
          </div>
          <div className="field">
            <span className="field__label">Pool trading fee</span>
            <Choice label="Pool trading fee" value={poolFee} options={POOL_FEES} onChange={setPoolFee} />
            <p className="hint">
              Trading opens with a 50% fee against snipers that falls to this over ten minutes. You get 80% of the
              pool's fees, for good; the platform gets the rest.
            </p>
          </div>
        </fieldset>

        <BidAccessField value={access} onChange={setAccess} plan={accessed} idPrefix="fl-access" />

        <fieldset className="group">
          <legend className="group__title">If it sells out</legend>
          <ul className="launch-facts">
            <li>The token is made: the {saleShare} of the supply that was sold goes to the winners.</li>
            <li>It starts trading at the final price: an FDV of {fdv ?? "…"} or more.</li>
            <li>
              Every SOL raised, less the {fees.data ? formatPercent(fees.data.saleFeeBps) : "…"} sale fee
              {net ? ` (${formatSol(net, 2)} SOL at the target)` : ""}, opens a Meteora pool at the final price with
              the {goods} it buys there, {pooledTokens ? `${supplyShare(pooledTokens)} of the supply` : "…"} at the
              target. The pool is locked for good.
            </li>
            <li>Then the supply is fixed for good: nobody can ever make more of the token.</li>
          </ul>
          <p className="hint">
            If it does not sell out, no token is ever made, every bid is refunded in full, and you close the sale to
            get your deposit back.
          </p>
        </fieldset>

        <fieldset className="group">
          <legend className="group__title">Costs</legend>
          <dl className="fees">
            <div>
              <dt>Listing</dt>
              <dd>
                <span className="fees__amount">{fees.data ? `${formatSol(fees.data.listingFee)} SOL` : "…"}</span>
                <span className="fees__note">Not refunded.</span>
              </dd>
            </div>
            <div>
              <dt>Processing fee</dt>
              <dd>
                <span className="fees__amount">{crank.data ? `${formatSol(sellerCrankFee(crank.data, "token"))} SOL` : "…"}</span>
                <span className="fees__note">Pays for the private steps that find the price. What is not used comes back.</span>
              </dd>
            </div>
            <div>
              <dt>Deposit</dt>
              <dd>
                <span className="fees__amount">{formatSol(LAUNCH_DEPOSIT)} SOL</span>
                <span className="fees__note">Pays to create the token and its pool if it sells out. The rest comes back.</span>
              </dd>
            </div>
          </dl>
        </fieldset>

        {problems.length > 0 && touched ? <Notice tone="info">{problems[0]}</Notice> : null}
        <div className="launch__submit">
          {signer ? (
            <Button variant="primary" type="submit" busy={action.busy === "launch"} disabled={problems.length > 0}>
              {step === "upload" ? "Uploading the token's details…" : "Launch the token sale"}
            </Button>
          ) : (
            <Button variant="primary" type="button" onClick={requestConnect}>
              Connect a wallet to launch
            </Button>
          )}
          <p className="hint">
            The token's image and details{access.listed ? " and your list" : ""} upload first, with no wallet prompt.
            Then your wallet approves the transaction that opens the sale.
          </p>
        </div>
        {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      </form>
      <aside className="launch__preview" aria-label="Your launch">
        <figure className="launchcard">
          {art ? <img className={`launchcard__art${isSmallImage(image) ? " launch__art--pixels" : ""}`} src={art} alt="" /> : <span className="launchcard__art launchcard__art--empty" />}
          <figcaption>
            <span className="launchcard__name">{name.trim() || "Token name"}</span>
            <span className="launchcard__meta">
              {ticker || "SYMBOL"}, {saleShare} for sale, {hours} hour{hours > 1 ? "s" : ""}
            </span>
          </figcaption>
        </figure>
        <ol className="launchsteps">
          <li>
            <span>
              <strong>Sealed bids for {hours} hour{hours > 1 ? "s" : ""}.</strong> Nobody sees a price.
            </span>
          </li>
          <li>
            <span>
              <strong>One price is found.</strong> It sells out if bids cover {saleShare} of the supply at an FDV of{" "}
              {fdv ?? "…"} or more.
            </span>
          </li>
          <li>
            <span>
              <strong>The token is born</strong> with its pool, or never at all.
            </span>
          </li>
        </ol>
      </aside>
    </div>
  );
}
