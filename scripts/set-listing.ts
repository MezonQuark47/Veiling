/**
 * Features, hides or resets auctions in the listing. Only the admin can run
 * it. It changes where the app shows an auction, never its terms or funds.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/devnet-test.json \
 *   yarn run ts-node scripts/set-listing.ts <featured|hidden|normal> <auction address> [...]
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";

const LISTINGS: Record<string, [featured: boolean, hidden: boolean]> = {
  featured: [true, false],
  hidden: [false, true],
  normal: [false, false],
};

async function main() {
  const [listing, ...addresses] = process.argv.slice(2);
  if (!(listing in LISTINGS) || addresses.length === 0) {
    throw new Error("Usage: set-listing.ts <featured|hidden|normal> <auction address> [...]");
  }
  const [featured, hidden] = LISTINGS[listing];
  const idl = JSON.parse(readFileSync(process.env.IDL ?? "target/idl/sealed_auction.json", "utf8"));
  // Blockhashes and reads at "confirmed", so a load-balanced RPC knows them.
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(env.connection.rpcEndpoint, "confirmed"),
    env.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  const program = new Program(idl, provider) as Program<any>;
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

  for (const address of addresses) {
    const auction = new PublicKey(address);
    const signature = await program.methods
      .setListing(featured, hidden)
      .accountsPartial({ admin: provider.wallet.publicKey, config, auction })
      .rpc({ commitment: "confirmed" });
    console.log(`${auction.toBase58()}: ${listing} (${signature})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
