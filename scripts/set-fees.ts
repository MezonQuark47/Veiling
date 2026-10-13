/**
 * Sets the platform fees: the listing fee in lamports, the sale fee in basis
 * points and the wallet both are paid to (the signing wallet by default).
 * Only the admin can run it, and the program caps the fees at 0.5 SOL and 5%.
 * Auctions that are already open keep the sale fee they opened with.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/devnet-test.json \
 *   yarn run ts-node scripts/set-fees.ts <listing fee, lamports> <sale fee, bps> [treasury]
 *
 * For example, 0.02 SOL to open and 1% of each sale: `20000000 100`.
 */
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";

async function main() {
  const [listingArg, saleArg, treasuryArg] = process.argv.slice(2);
  if (!/^\d+$/.test(listingArg ?? "") || !/^\d+$/.test(saleArg ?? "")) {
    throw new Error("Usage: set-fees.ts <listing fee, lamports> <sale fee, bps> [treasury]");
  }
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
  const treasury = treasuryArg ? new PublicKey(treasuryArg) : admin;
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fees")], program.programId);

  const signature = await program.methods
    .setFees(new BN(listingArg), Number(saleArg))
    .accountsPartial({ admin, config, feeConfig, treasury })
    .rpc({ commitment: "confirmed" });
  const fees = await (program.account as any).feeConfig.fetch(feeConfig, "confirmed");
  console.log(`Signature: ${signature}`);
  console.log(
    `Fees: ${fees.listingFee.toNumber() / LAMPORTS_PER_SOL} SOL to open, ` +
      `${fees.saleFeeBps / 100}% of each sale, paid to ${fees.treasury.toBase58()}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
