/**
 * Sets the rewards paid to whoever runs each MPC step, in lamports: a batch
 * check (four bids), the clearing, a batch settlement (up to four bids) and a collection's
 * seed draw. Only the admin can run it, and the program caps each at 0.1 SOL.
 * Auctions that are already open keep the rewards they opened with.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/devnet-test.json \
 *   yarn run ts-node scripts/set-crank-rewards.ts <check> <clearing> <settlement> <seed draw>
 *
 * Set them a little above what queueing each computation costs, so running
 * the steps never costs anyone money. Measured on devnet with the v2
 * circuits: about 0.0053, 0.0224, 0.0042 and 0.0028 SOL, hence for example
 * `6000000 25000000 4600000 3000000`.
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || !args.every((a) => /^\d+$/.test(a))) {
    throw new Error("Usage: set-crank-rewards.ts <check> <clearing> <settlement> <seed draw> (lamports)");
  }
  const [checkBatch, clearing, settlement, seedDraw] = args.map((a) => new BN(a));
  const idl = JSON.parse(readFileSync(process.env.IDL ?? "target/idl/sealed_auction.json", "utf8"));
  // Blockhashes and reads at "confirmed", so a load-balanced RPC knows them.
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(env.connection.rpcEndpoint, "confirmed"),
    env.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  const program = new Program(idl, provider) as Program<any>;
  const admin = provider.wallet.publicKey;
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [crankConfig] = PublicKey.findProgramAddressSync([Buffer.from("crank")], program.programId);

  const signature = await program.methods
    .setCrankRewards({ checkBatch, clearing, settlement, seedDraw })
    .accountsPartial({ admin, config, crankConfig })
    .rpc({ commitment: "confirmed" });
  const { rewards } = await (program.account as any).crankConfig.fetch(crankConfig, "confirmed");
  const sol = (v: BN) => v.toNumber() / LAMPORTS_PER_SOL;
  console.log(`Signature: ${signature}`);
  console.log(
    `Crank rewards: ${sol(rewards.checkBatch)} SOL per check, ${sol(rewards.clearing)} SOL per clearing, ` +
      `${sol(rewards.settlement)} SOL per settlement, ${sol(rewards.seedDraw)} SOL per seed draw`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
