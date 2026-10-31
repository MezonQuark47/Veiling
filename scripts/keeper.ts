/**
 * The keeper: finishes every sale on its own, and keeps the site's all-time
 * totals, points and each wallet's history.
 *
 * Every step after bidding is public and paid from the sale's own processing
 * fund, so anyone may run it; the keeper simply always does. It watches the
 * program (through Helius when HELIUS_API_KEY is set), and when a sale's
 * bidding ends it checks the bids, finds the final price, works out every bid,
 * makes the token and opens its pool, and sends out tokens, NFTs and refunds
 * (`scripts/lib/finish.ts`). The seller's own steps (revealing hidden art,
 * collecting earnings, closing the sale) stay with the seller.
 *
 * It also reads the program's history into totals and points
 * (`scripts/lib/stats.ts`) and serves them at http://localhost:PORT/stats.json
 * for the site (VITE_STATS_URL), and each wallet's own history at
 * /wallet/<address>.json for its dashboard.
 *
 * Settings come from the environment, or from `keeper.env` in the repo root
 * (KEY=value lines; never commit it):
 *
 *   HELIUS_API_KEY   Helius key; the keeper then uses Helius's RPC
 *   RPC_URL          or any other RPC address
 *   NETWORK          devnet (default) or mainnet
 *   KEEPER_WALLET    keypair file that pays fees and earns the step rewards
 *                    (default ~/.config/solana/veiling-keeper.json)
 *   PORT             where stats.json is served (default 8787)
 *   DATA_DIR         where the keeper keeps its state (default keeper-data)
 *   EXCLUDE_WALLETS  more wallets, comma separated, that earn no points
 *   STATS_ONLY=1     only keep the totals; finish no sales
 *   SEASON_NAME, SEASON_START, SEASON_END
 *                    the season with its own leaderboard (dates like
 *                    2026-10-30); on devnet Season 0 by default, none on
 *                    mainnet. Must match SEASON in app/src/config.ts.
 *
 * It also takes invites, X checks and reminders for the site
 * (`scripts/lib/services.ts`, which lists their settings).
 *
 *   yarn run ts-node scripts/keeper.ts
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "fs";
import { createServer } from "http";
import { homedir } from "os";
import { join } from "path";
import { finishAuction } from "./lib/finish";
import { createServices, type SaleNow } from "./lib/services";
import { indexHistory, loadState, saveSnapshot, saveState, snapshot, type Season, type StatsSnapshot, walletView } from "./lib/stats";

// ---------------------------------------------------------------------------
// Settings

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(join(process.cwd(), "keeper.env"));

const NETWORK = process.env.NETWORK === "mainnet" ? "mainnet" : "devnet";
const RPC_URL =
  process.env.RPC_URL ??
  (process.env.HELIUS_API_KEY
    ? `https://${NETWORK}.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : NETWORK === "mainnet"
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com");
const RPC_NAME = process.env.HELIUS_API_KEY && !process.env.RPC_URL ? "Helius" : new URL(RPC_URL).host;
process.env.ARCIUM_CLUSTER_OFFSET ??= "456";
const WALLET_PATH = (process.env.KEEPER_WALLET ?? "~/.config/solana/veiling-keeper.json").replace(/^~/, homedir());
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? "keeper-data";
const STATS_ONLY = process.env.STATS_ONLY === "1";
/** A date setting (2026-10-30, or any date JavaScript reads) in unix seconds. */
const dateSetting = (value: string | undefined, fallback: string) => Math.floor(Date.parse(value || fallback) / 1000);
const SEASON: Season | null =
  NETWORK === "mainnet" && !process.env.SEASON_START
    ? null
    : {
        name: process.env.SEASON_NAME || "Season 0",
        start: dateSetting(process.env.SEASON_START, "2026-10-30T00:00:00Z"),
        end: dateSetting(process.env.SEASON_END, "2026-12-15T00:00:00Z"),
      };
const IDL_PATH = [process.env.IDL, "target/idl/sealed_auction.json", "app/src/idl/sealed_auction.json"].find(
  (p) => p && existsSync(p)
);

/** Sales finished at the same time. */
const AT_ONCE = 3;
/** How often to look again, at the latest, in ms. */
const SCAN_EVERY = 60_000;
/** After a run that had nothing to do, leave the sale alone this long, in seconds. */
const IDLE_BACKOFF = 600;
/** After a run that failed, try again after this long, in seconds. */
const ERROR_BACKOFF = 120;
/** A pooled sale's trading fees are paid out this often, in seconds. */
const FEES_EVERY = 3600;

const LIQUIDITY_PLANNED = 1;
const LIQUIDITY_POOLED = 3;
const variant = (value: object) => Object.keys(value)[0];
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (line: string) => console.log(`${stamp()} ${line}`);

// ---------------------------------------------------------------------------

async function main() {
  if (!IDL_PATH) throw new Error("No IDL found: build the program, or set IDL to the program's IDL file.");
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  const programId = new PublicKey(idl.address);
  const connection = new Connection(RPC_URL, "confirmed");

  let keeper: Keypair | null = null;
  if (!STATS_ONLY) {
    if (!existsSync(WALLET_PATH)) {
      throw new Error(
        `No keeper wallet at ${WALLET_PATH}. Make one with: solana-keygen new --no-bip39-passphrase --silent -o ${WALLET_PATH}`
      );
    }
    keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET_PATH, "utf8"))));
  }
  const exclude = new Set(
    [keeper?.publicKey.toBase58(), ...(process.env.EXCLUDE_WALLETS ?? "").split(",")]
      .map((w) => w?.trim())
      .filter((w): w is string => Boolean(w))
  );

  log(`Veiling keeper on ${NETWORK} through ${RPC_NAME}, program ${programId.toBase58()}`);
  if (keeper) {
    const balance = await connection.getBalance(keeper.publicKey, "confirmed");
    log(`Keeper wallet ${keeper.publicKey.toBase58()}: ${balance / 1e9} SOL`);
    if (balance < 0.05e9) log("The keeper wallet is low on SOL: it pays each step's fee before the sale pays it back.");
  } else {
    log("STATS_ONLY: keeping the totals only.");
  }

  // -------------------------------------------------------------------------
  // Stats

  const statePath = join(DATA_DIR, "stats-state.json");
  const snapshotPath = join(DATA_DIR, "stats.json");
  const state = loadState(statePath, programId, SEASON);
  if (SEASON) {
    log(`${SEASON.name}: ${new Date(SEASON.start * 1000).toISOString().slice(0, 10)} to ${new Date(SEASON.end * 1000).toISOString().slice(0, 10)}`);
  }
  const reader = new Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(Keypair.generate()), {})) as Program<any>;
  const services = createServices({
    dataDir: DATA_DIR,
    state: () => state,
    fetchAuction: async (address) => {
      const a = await (reader.account as any).auction.fetchNullable(new PublicKey(address), "confirmed");
      return a ? { seller: a.seller.toBase58(), status: variant(a.status), endTime: a.endTime.toNumber() } : null;
    },
    log,
  });
  let latest: StatsSnapshot | null = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, "utf8")) : null;
  let indexing = false;
  async function updateStats() {
    if (indexing) return;
    indexing = true;
    try {
      const read = await indexHistory(
        connection,
        programId,
        idl,
        state,
        (line) => log(line),
        () => saveState(statePath, state),
        services.invites
      );
      if (read > 0 || !latest) {
        saveState(statePath, state);
        latest = snapshot(state, NETWORK, exclude);
        saveSnapshot(snapshotPath, latest);
        if (read > 0) {
          log(
            `stats: ${read} new transaction(s); ${latest.totals.sales} sales, ${latest.totals.bids} bids, ` +
              `${latest.totals.users} users, ${latest.totals.volumeSol} SOL bought`
          );
        }
      } else {
        // Nothing new is news too: the totals are current as of now.
        latest.updatedAt = Math.floor(Date.now() / 1000);
      }
    } catch (e: any) {
      log(`stats: could not update (${e?.message ?? e}); trying again later`);
    } finally {
      indexing = false;
    }
  }

  createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", req.method === "GET" ? "public, max-age=30" : "no-store");
    const url = new URL(req.url ?? "/", "http://keeper");
    const path = url.pathname;
    if (await services.handle(req, res, path, url.searchParams)) return;
    if (path === "/stats.json") {
      if (!latest) {
        res.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"not ready"}');
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(latest));
    } else if (/^\/wallet\/[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(path)) {
      // One wallet's own history, for its dashboard.
      const wallet = path.slice("/wallet/".length, -".json".length);
      const found = walletView(state, wallet, latest, services.invites);
      // The X name it invites with, if it took one.
      const handle = services.handleOf(wallet);
      const empty = {
        wallet,
        updatedAt: Math.floor(Date.now() / 1000),
        points: 0,
        rank: null,
        season: latest?.season ? { name: latest.season.name, points: 0, rank: null } : null,
        invites: { joined: 0, active: 0, points: 0 },
        totals: { bids: 0, salesJoined: 0, salesWon: 0, paid: "0", deposited: "0", refunded: "0", salesLaunched: 0, raised: "0", steps: 0 },
        joined: [],
        launched: [],
      };
      const view = found ? { ...found, handle } : handle ? { ...empty, handle } : null;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(view));
    } else if (path === "/health") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: true, network: NETWORK, working: [...busy], statsUpdatedAt: latest?.updatedAt ?? null }));
    } else {
      res.writeHead(404).end();
    }
  }).listen(PORT, () => log(`Stats at http://localhost:${PORT}/stats.json`));

  // -------------------------------------------------------------------------
  // Finishing sales

  const busy = new Set<string>();
  /** When each sale may be looked at again, in unix seconds. */
  const notBefore = new Map<string, number>();
  const feesPaidAt = new Map<string, number>();

  async function finish(address: PublicKey, poolFees: boolean) {
    const key = address.toBase58();
    busy.add(key);
    // Each run gets its own provider, so it can count what it sent.
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keeper!), {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    let sent = 0;
    const send = provider.sendAndConfirm.bind(provider);
    provider.sendAndConfirm = (async (...args: Parameters<typeof send>) => {
      sent++;
      return send(...args);
    }) as typeof send;
    const program = new Program(idl, provider) as Program<any>;
    const short = `${key.slice(0, 4)}…${key.slice(-4)}`;
    try {
      await finishAuction({ program, provider, poolFees, log: (line) => log(`[${short}] ${line}`) }, address);
      if (poolFees) feesPaidAt.set(key, Date.now() / 1000);
      notBefore.set(key, sent === 0 ? Date.now() / 1000 + IDLE_BACKOFF : 0);
    } catch (e: any) {
      log(`[${short}] stopped: ${e?.message ?? e}. Trying again in ${ERROR_BACKOFF / 60} minutes.`);
      notBefore.set(key, Date.now() / 1000 + ERROR_BACKOFF);
    } finally {
      busy.delete(key);
      soon();
    }
  }

  let scanning = false;
  let endTimer: NodeJS.Timeout | null = null;
  async function scan() {
    if (STATS_ONLY || scanning) return;
    scanning = true;
    try {
      const program = new Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(keeper!), {})) as Program<any>;
      const all = (await (program.account as any).auction.all()) as { publicKey: PublicKey; account: any }[];
      const now = Date.now() / 1000;
      // Reminders: every sale's state now; a sale that is gone is closed, so over.
      const sales = new Map<string, SaleNow>();
      for (const { publicKey, account: a } of all) {
        const status = variant(a.status);
        const end = a.endTime.toNumber();
        const settled = a.resolvedCount >= a.bidCount && a.liveBids === 0 && (a.liquidity ?? 0) !== LIQUIDITY_PLANNED;
        sales.set(publicKey.toBase58(), {
          status,
          endTime: end,
          done: status === "finished" || (status === "settling" && settled) || (status === "open" && end <= now && a.bidCount === 0),
          failed: Boolean(a.raiseMissed),
        });
      }
      void services.sendReminders(sales, (auction) => {
        const sale = state.sales[auction];
        return sale?.symbol ? `the ${sale.symbol} sale` : sale?.name ? `the ${sale.name} sale` : "this sale";
      });
      let nextEnd = Infinity;
      for (const { publicKey, account: a } of all) {
        const key = publicKey.toBase58();
        const status = variant(a.status);
        const end = a.endTime.toNumber();
        if (status === "open" && end > now) nextEnd = Math.min(nextEnd, end);
        if (busy.has(key) || busy.size >= AT_ONCE) continue;
        if ((notBefore.get(key) ?? 0) > now) continue;
        const pooled = (a.liquidity ?? 0) === LIQUIDITY_POOLED;
        const feesDue = pooled && now - (feesPaidAt.get(key) ?? 0) >= FEES_EVERY;
        // A settling sale needs work while bids are open or left to send out, or its
        // pool is still to open; a pooled one also for its fees, hourly.
        const planned = (a.liquidity ?? 0) === LIQUIDITY_PLANNED;
        const due =
          (status === "open" && end <= now && a.bidCount > 0) ||
          (status === "settling" && (a.resolvedCount < a.bidCount || a.liveBids > 0 || planned || feesDue));
        if (due) void finish(publicKey, feesDue);
      }
      // Wake up right as the next sale's bidding ends.
      if (endTimer) clearTimeout(endTimer);
      if (Number.isFinite(nextEnd)) {
        endTimer = setTimeout(() => soon(), Math.min(2 ** 31 - 1, Math.max(1000, (nextEnd - now + 2) * 1000)));
      }
    } catch (e: any) {
      log(`Could not list the sales (${e?.message ?? e}); trying again later`);
    } finally {
      scanning = false;
    }
  }

  let soonTimer: NodeJS.Timeout | null = null;
  /** Looks again in a few seconds; many wake-ups in a row make one look. */
  function soon() {
    if (soonTimer) return;
    soonTimer = setTimeout(() => {
      soonTimer = null;
      void scan();
      void updateStats();
    }, 3000);
  }

  // Anything the program does is a reason to look again.
  connection.onLogs(programId, () => soon(), "confirmed");
  setInterval(() => {
    void scan();
    void updateStats();
  }, SCAN_EVERY);
  await updateStats();
  await scan();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
