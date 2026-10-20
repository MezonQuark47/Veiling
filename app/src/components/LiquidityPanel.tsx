import {
  ANTI_SNIPER_FEE_BPS,
  ANTI_SNIPER_MINUTES,
  DAMM_PROTOCOL_FEE_PERCENT,
  SELLER_POOL_FEE_BPS,
  meteoraPoolUrl,
} from "../config";
import { buildBootstrapLiquidity, buildClaimPoolFees } from "../lib/actions";
import {
  type Auction,
  fetchAuction,
  fetchLiquidityPlan,
  formatPercent,
  formatPrice,
  poolReady,
  poolSol,
  saleFee,
} from "../lib/chain";
import { formatSol } from "../lib/format";
import { sendTransaction } from "../lib/tx";
import { useWallet } from "../lib/wallet";
import { AddressLink, type AssetInfo, Button, Notice, TxLink, goodsAmount, useAction, useLoader } from "./ui";

/**
 * A token sale's auto-liquidity: the terms the seller fixed before any bid,
 * then the pool's opening (anyone can run it) and its trading fees.
 */
export function LiquidityPanel({ auction, asset, refresh }: { auction: Auction; asset: AssetInfo; refresh: () => void }) {
  const { signer } = useWallet();
  const action = useAction();
  const loaded = useLoader(() => fetchLiquidityPlan(auction), [auction.address.toBase58(), auction.liquidity]);
  if (auction.liquidity === "none") return null;
  const plan = loaded.data;

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

  const terms = plan ? (
    <p>
      {formatPercent(plan.lpBps)} of the net proceeds, and at least {formatSol(plan.floor)} SOL, opens a Meteora
      pool at exactly the clearing price, with the {asset.goods} that SOL buys there. The pool is locked forever:
      nobody can take its liquidity out. Trading starts with a {formatPercent(ANTI_SNIPER_FEE_BPS)} fee against
      snipers, which falls to {formatPercent(plan.tradeFeeBps)} over {ANTI_SNIPER_MINUTES} minutes.
    </p>
  ) : null;

  let body = null;
  if (auction.liquidity === "planned") {
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
              The sale is settled: the pool gets {formatSol(sol)} SOL and {goodsAmount(tokens, asset)} at{" "}
              {formatPrice(auction, auction.clearingPrice, asset.decimals)} per {asset.unit}. Anyone can open it; it
              also pays the seller the rest of the proceeds.
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
              {formatSol(plan.poolSol)} SOL and {goodsAmount(plan.poolTokens, asset)}, at{" "}
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
        Auto-liquidity
      </h2>
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : body}
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      {action.done ? <Notice tone="success">{action.done}</Notice> : null}
    </section>
  );
}
