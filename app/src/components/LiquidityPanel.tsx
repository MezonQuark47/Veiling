import {
  ANTI_SNIPER_FEE_BPS,
  ANTI_SNIPER_MINUTES,
  DAMM_PROTOCOL_FEE_PERCENT,
  SELLER_POOL_FEE_BPS,
  meteoraPoolUrl,
} from "../config";
import { buildBootstrapLiquidity, buildClaimPoolFees, buildCloseLaunch, buildGraduateLaunch } from "../lib/actions";
import {
  type Auction,
  emergencyOpensAt,
  fetchAuction,
  fetchLaunchToken,
  fetchLiquidityPlan,
  launchSettleSecs,
  pagesInUse,
  formatPercent,
  formatPrice,
  poolReady,
  poolSol,
  saleFee,
  supplyShare,
} from "../lib/chain";
import { formatDuration, formatSol, nowSecs } from "../lib/format";
import { sendTransaction } from "../lib/tx";
import { useWallet } from "../lib/wallet";
import { AddressLink, type AssetInfo, Button, Notice, TxLink, goodsAmount, useAction, useLoader } from "./ui";

/**
 * A token sale's auto-liquidity: the terms the seller fixed before any bid,
 * then the pool's opening (anyone can run it) and its trading fees.
 */
export function LiquidityPanel({ auction, asset, refresh }: { auction: Auction; asset: AssetInfo; refresh: () => void }) {
  const { signer, publicKey } = useWallet();
  const action = useAction();
  const loaded = useLoader(() => fetchLiquidityPlan(auction), [auction.address.toBase58(), auction.liquidity]);
  // A new token's record: there until the token is made (or the sale closes).
  const unmade = useLoader(
    () => (auction.launch ? fetchLaunchToken(auction.address) : Promise.resolve(null)),
    [auction.address.toBase58(), auction.liquidity, auction.resolvedCount]
  );
  if (auction.liquidity === "none") return null;
  const plan = loaded.data;
  const launch = auction.launch;
  const tokenMade = launch && !unmade.loading && unmade.data === null;
  const isSeller = Boolean(publicKey && publicKey.equals(auction.seller));
  const now = nowSecs();

  const needSigner = () => {
    if (!signer) throw new Error("Connect a wallet first");
    return signer;
  };

  const open = () =>
    action.run("open-pool", async () => {
      const s = needSigner();
      const { tx, signers } = await buildBootstrapLiquidity(s.publicKey, auction);
      const sig = await sendTransaction(tx, s, signers);
      const after = await fetchAuction(auction.address);
      refresh();
      loaded.reload();
      return after?.liquidity === "pooled" ? (
        <>
          The pool is open at the clearing price and locked for good; the seller was paid the rest. <TxLink signature={sig} />
        </>
      ) : (
        <>
          Someone had already opened Meteora's pool for this token, so none was added: the seller got all the proceeds
          and the reserve back. <TxLink signature={sig} />
        </>
      );
    });

  const graduate = () =>
    action.run("graduate", async () => {
      const s = needSigner();
      const sig = await sendTransaction(await buildGraduateLaunch(s.publicKey, auction), s);
      unmade.reload();
      refresh();
      return (
        <>
          The token is made: exactly what was sold and what the pool takes, and nobody can mint more. Open the pool
          next. <TxLink signature={sig} />
        </>
      );
    });

  const closeLaunch = () =>
    action.run("close-launch", async () => {
      const s = needSigner();
      const sig = await sendTransaction(await buildCloseLaunch(auction), s);
      refresh();
      return (
        <>
          The sale is closed. Your deposit and every rent came back to you. <TxLink signature={sig} />
        </>
      );
    });

  const claimFees = () =>
    action.run("pool-fees", async () => {
      const s = needSigner();
      const before = plan!;
      const sig = await sendTransaction(await buildClaimPoolFees(s.publicKey, before), s);
      const after = await fetchLiquidityPlan(auction);
      loaded.reload();
      const paid = after ? after.feesToSeller + after.feesToPlatform - before.feesToSeller - before.feesToPlatform : 0n;
      return paid > 0n ? (
        <>
          {formatSol(paid)} SOL of trading fees paid out. <TxLink signature={sig} />
        </>
      ) : (
        <>No new fees to pay out yet.</>
      );
    });

  const terms = launch ? (
    <p>
      Every SOL raised, less the sale fee, opens a Meteora pool at exactly the clearing price, with the {asset.goods}{" "}
      that SOL buys there. The pool is locked forever: nobody can take its liquidity out. Trading starts with a{" "}
      {formatPercent(ANTI_SNIPER_FEE_BPS)} fee against snipers, which falls to{" "}
      {plan ? formatPercent(plan.tradeFeeBps) : "the pool's fee"} over {ANTI_SNIPER_MINUTES} minutes.
    </p>
  ) : plan ? (
    <p>
      {formatPercent(plan.lpBps)} of the net proceeds, and at least {formatSol(plan.floor)} SOL, opens a Meteora
      pool at exactly the clearing price, with the {asset.goods} that SOL buys there. The pool is locked forever:
      nobody can take its liquidity out. Trading starts with a {formatPercent(ANTI_SNIPER_FEE_BPS)} fee against
      snipers, which falls to {formatPercent(plan.tradeFeeBps)} over {ANTI_SNIPER_MINUTES} minutes.
    </p>
  ) : null;

  let body = null;
  // A new token's own story: the token waits for the sale.
  const ended = now >= auction.endTime;
  const nothingLeft = auction.liveBids === 0 && auction.sold === 0n;
  const canCloseLaunch =
    launch &&
    isSeller &&
    !tokenMade &&
    nothingLeft &&
    (auction.status === "cancelled" || ended || (auction.status === "open" && auction.bidCount === 0));
  const closeButton = canCloseLaunch ? (
    <>
      <p>No token was made, and no bid is left. Close the sale to get your deposit and every rent back.</p>
      <Button variant="primary" onClick={closeLaunch} busy={action.busy === "close-launch"}>
        {auction.bidCount === 0 && !ended ? "Withdraw the sale" : "Close the sale"}
      </Button>
    </>
  ) : null;
  if (launch && auction.liquidity === "planned" && !tokenMade) {
    const settling = ended && !poolReady(auction);
    const eta = launchSettleSecs(auction.bidCount, pagesInUse(auction));
    body = (
      <>
        <p>
          Nothing is minted yet. If bids cover the {supplyShare(auction.supply)} of the supply for sale at{" "}
          {formatPrice(auction, auction.minPrice, asset.decimals)} per {asset.unit} or more, the sale raises its{" "}
          {formatSol(auction.minRaise)} SOL target and the token is made: what was sold goes to the winners, and every
          SOL raised less the sale fee opens a Meteora pool at the clearing price, with up to the other{" "}
          {supplyShare(auction.supply)}, locked for good. If not, no token is ever made and every bid is refunded in
          full.
        </p>
        {!ended ? (
          <p className="muted">
            {formatSol(auction.totalDeposited)} SOL deposited so far. A deposit only bounds a bid, so this is the most
            that bids could raise, not what they will. With {auction.bidCount} bid{auction.bidCount === 1 ? "" : "s"}{" "}
            so far, the token would be made about {formatDuration(eta)} after bidding closes; more bids take longer.
          </p>
        ) : null}
        {settling && auction.bidCount > 0 ? (
          <p className="muted">
            Bidding is over. Checking {auction.bidCount} sealed bids, finding the price and settling them takes about{" "}
            {formatDuration(eta)} from the end of bidding; the token comes right after.
          </p>
        ) : null}
        {poolReady(auction) ? (
          <>
            <p>
              The sale sold out. Anyone can make its token now; the creator's deposit pays for it.
            </p>
            <Button variant="primary" onClick={graduate} busy={action.busy === "graduate"} disabled={!signer || unmade.loading}>
              Make the token
            </Button>
          </>
        ) : null}
        {closeButton}
      </>
    );
  } else if (launch && auction.liquidity === "failed") {
    body = (
      <>
        <p>
          The sale missed its {formatSol(auction.minRaise)} SOL target, so its token is never made: every bid gets its
          whole deposit back.
        </p>
        {closeButton}
      </>
    );
  } else if (launch && !tokenMade && emergencyOpensAt(auction) <= now) {
    body = (
      <>
        <p>Settlement stalled, so every bid can be refunded in full; no token is made unless the sale settles.</p>
        {closeButton}
      </>
    );
  } else if (auction.liquidity === "planned") {
    // Once every bid is settled the pool's size is known.
    const fee = saleFee(auction.proceeds, auction.saleFeeBps);
    const sol = plan ? poolSol(auction.proceeds - fee, plan.lpBps, plan.floor) : 0n;
    const tokens = auction.clearingPrice > 0n ? (sol * auction.priceUnit) / auction.clearingPrice : 0n;
    body = (
      <>
        {terms}
        {poolReady(auction) ? (
          <>
            <p>
              The sale is settled: the pool gets {formatSol(sol)} SOL and{" "}
              {launch ? `${supplyShare(tokens)} of the supply` : goodsAmount(tokens, asset)} at{" "}
              {formatPrice(auction, auction.clearingPrice, asset.decimals)} per {asset.unit}. Anyone can open it
              {launch ? "." : "; it also pays the seller the rest of the proceeds."}
            </p>
            <Button variant="primary" onClick={open} busy={action.busy === "open-pool"} disabled={!signer || !plan}>
              Open the pool
            </Button>
          </>
        ) : (
          <p className="muted">
            The seller escrowed a reserve of {plan ? goodsAmount(plan.reserve, asset) : "tokens"} for it; what the pool
            does not use goes back to them. If the sale cannot raise the minimum, it does not go ahead and every bid
            is refunded in full.
          </p>
        )}
      </>
    );
  } else if (auction.liquidity === "failed") {
    body = (
      <p>
        {auction.raiseMissed
          ? `The sale missed its minimum raise of ${formatSol(auction.minRaise)} SOL`
          : `The sale could not raise the pool's minimum of ${formatSol(auction.liquidityFloor)} SOL after fees`}
        , so it does not go ahead and no pool opens: every bid gets its whole deposit back, and the seller their
        tokens and reserve.
      </p>
    );
  } else if (auction.liquidity === "released") {
    body = <p>No pool was opened. The reserve and the rent deposit went back to the seller.</p>;
  } else if (plan) {
    const sellerShare = SELLER_POOL_FEE_BPS;
    body = (
      <>
        <dl className="facts">
          <div>
            <dt>Pool</dt>
            <dd>
              <a href={meteoraPoolUrl(plan.pool)} target="_blank" rel="noreferrer noopener">
                Trade on Meteora
              </a>{" "}
              · <AddressLink address={plan.pool} />
            </dd>
          </div>
          <div>
            <dt>Opened with</dt>
            <dd>
              {formatSol(plan.poolSol)} SOL and{" "}
              {launch ? `${supplyShare(plan.poolTokens)} of the supply` : goodsAmount(plan.poolTokens, asset)}, at{" "}
              {formatPrice(auction, auction.clearingPrice, asset.decimals)} per {asset.unit}
            </dd>
          </div>
          <div>
            <dt>Liquidity</dt>
            <dd>Locked forever; no one can withdraw it</dd>
          </div>
          <div>
            <dt>Trading fee</dt>
            <dd>
              {formatPercent(plan.tradeFeeBps)}. Meteora keeps {DAMM_PROTOCOL_FEE_PERCENT}%; of the rest,{" "}
              {formatPercent(sellerShare)} goes to the seller and {formatPercent(10_000 - sellerShare)} to Veiling
            </dd>
          </div>
          <div>
            <dt>Fees paid out</dt>
            <dd>
              {formatSol(plan.feesToSeller)} SOL to the seller, {formatSol(plan.feesToPlatform)} SOL to Veiling
            </dd>
          </div>
        </dl>
        <Button onClick={claimFees} busy={action.busy === "pool-fees"} disabled={!signer}>
          Pay out the pool's fees
        </Button>
        <p className="hint">Anyone can do this; the fees only ever go to the seller and Veiling.</p>
      </>
    );
  }

  return (
    <section className="panel" aria-labelledby="liquidity-title">
      <h2 id="liquidity-title" className="panel__title">
        {launch ? "Token and pool" : "Auto-liquidity"}
      </h2>
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : body}
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      {action.done ? <Notice tone="success">{action.done}</Notice> : null}
    </section>
  );
}
