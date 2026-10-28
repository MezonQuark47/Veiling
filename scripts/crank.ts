/**
 * Takes one ended auction through every step anyone may take (see
 * `scripts/lib/finish.ts`). `scripts/keeper.ts` does the same for every
 * auction, on its own.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/devnet-test.json ARCIUM_CLUSTER_OFFSET=456 \
 *   [IDL=target/idl/sealed_auction.json] [SETTLE_AT_ONCE=4] \
 *   yarn run ts-node scripts/crank.ts <auction address>
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { finishAuction } from "./lib/finish";

async function main() {
  const auctionAddress = new PublicKey(process.argv[2] ?? "");
  const idl = JSON.parse(readFileSync(process.env.IDL ?? "target/idl/sealed_auction.json", "utf8"));
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(env.connection.rpcEndpoint, "confirmed"),
    env.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  const program = new Program(idl, provider) as Program<any>;
  await finishAuction({ program, provider }, auctionAddress);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
