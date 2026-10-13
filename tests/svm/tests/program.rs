//! Runs the compiled program (`target/deploy/sealed_auction.so`) in LiteSVM
//! and tests everything around the MPC computations: opening auctions, bids
//! and eviction when an auction is full, fees, the safety net and closing
//! auctions. For what comes after MPC, the tests write the results the
//! callbacks would have recorded straight into the accounts, then run the
//! real instructions: sharing NFTs at the clearing price, delivering tokens,
//! minting a collection's NFTs through Metaplex Core and paying the seller.
//!
//! Build the program first (`arcium build`) and put a copy of Metaplex Core
//! next to these tests:
//!
//! ```bash
//! solana program dump -u devnet CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
//!   tests/svm/fixtures/mpl_core.so
//! cargo test --manifest-path tests/svm/Cargo.toml
//! ```

use curve25519_dalek::{
    constants::{ED25519_BASEPOINT_POINT, EIGHT_TORSION},
    montgomery::MontgomeryPoint,
    scalar::Scalar,
};
use litesvm::LiteSVM;
use num_bigint::BigUint;
use serde_json::Value;
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use std::collections::HashMap;
use std::path::PathBuf;

const PROGRAM_ID: Address = Address::from_str_const("CjUVaVK3jF9o4EehHWtB13TGg9SPXBWKGBepmZHwyLK2");
const MPL_CORE: Address = Address::from_str_const("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const TOKEN_PROGRAM: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM: Address = Address::from_str_const("11111111111111111111111111111111");
const COMPUTE_BUDGET: Address = Address::from_str_const("ComputeBudget111111111111111111111111111111");

const MAX_BIDS: u64 = 256;
const SOL: u64 = 1_000_000_000;
const EMERGENCY_DELAY_SECS: i64 = 3 * 24 * 60 * 60;
const MAX_DURATION_SECS: i64 = 14 * 24 * 60 * 60;
const REVEAL_DELAY_SECS: i64 = 7 * 24 * 60 * 60;
/// An item list's header, then entries of a u32 end, a length byte and a
/// 24-byte name.
const ITEM_LIST_HEADER_LEN: usize = 8 + 32 + 32 + 4 + 4 + 1 + 1;
const ITEM_ENTRY_LEN: usize = 4 + 1 + 24;
const TX_FEE: u64 = 5_000;

/// The platform fees set up for every test: 0.02 SOL to open, 1% of a sale.
const LISTING_FEE: u64 = 20_000_000;
const SALE_FEE_BPS: u16 = 100;

/// Lamports per price tick of a collection auction.
const NFT_PRICE_SCALE: u64 = 1_000;

/// What a bid's settlement records: nothing, above the clearing price (or
/// any valid bid when demand never covered the supply), or exactly at it.
const OUTCOME_NONE: u8 = 0;
const OUTCOME_ABOVE: u8 = 1;
const OUTCOME_AT: u8 = 2;

const DURATION_SECS: i64 = 600;

/// The token auction most tests use: 100 tokens of a mint without decimals,
/// prices in lamports per token, at least 2_500 each.
const TOKEN_TERMS: TokenTerms = TokenTerms {
    supply: 100,
    price_unit: 1,
    min_price: 2_500,
    min_deposit: 2_500,
    duration_secs: DURATION_SECS,
};

fn repo_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(relative)
}

fn artifact(env_var: &str, relative: &str) -> PathBuf {
    std::env::var(env_var).map(PathBuf::from).unwrap_or_else(|_| repo_path(relative))
}

// ---------------------------------------------------------------------------
// IDL: discriminators, error codes and account layouts
// ---------------------------------------------------------------------------

/// Read from the IDL so the tests cannot drift from the program.
struct Idl {
    discriminators: HashMap<String, Vec<u8>>,
    account_discriminators: HashMap<String, Vec<u8>>,
    errors: HashMap<String, u32>,
    types: HashMap<String, Value>,
}

fn bytes_of(value: &Value) -> Vec<u8> {
    value.as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect()
}

impl Idl {
    fn load() -> Self {
        let path = artifact("SEALED_AUCTION_IDL", "target/idl/sealed_auction.json");
        let idl: Value = serde_json::from_slice(&std::fs::read(&path).expect("read IDL")).unwrap();
        let named = |key: &str| -> HashMap<String, Vec<u8>> {
            idl[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| (item["name"].as_str().unwrap().to_string(), bytes_of(&item["discriminator"])))
                .collect()
        };
        let idl = Idl {
            discriminators: named("instructions"),
            account_discriminators: named("accounts"),
            errors: idl["errors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (e["name"].as_str().unwrap().to_string(), e["code"].as_u64().unwrap() as u32))
                .collect(),
            types: idl["types"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| (t["name"].as_str().unwrap().to_string(), t["type"].clone()))
                .collect(),
        };
        // The argument encoders below follow these layouts.
        idl.assert_fields(
            "TokenSaleTerms",
            &[("supply", "u64"), ("price_unit", "u64"), ("min_price", "u32"), ("min_deposit", "u64"), ("duration_secs", "i64")],
        );
        idl.assert_fields(
            "CollectionSaleTerms",
            &[("supply", "u64"), ("min_price", "u32"), ("max_per_bid", "u16"), ("duration_secs", "i64")],
        );
        idl.assert_fields(
            "ExpectedTerms",
            &[
                ("mint", "pubkey"),
                ("supply", "u64"),
                ("price_unit", "u64"),
                ("price_scale", "u64"),
                ("min_price", "u32"),
                ("min_deposit", "u64"),
                ("max_per_bid", "u16"),
                ("end_time", "i64"),
            ],
        );
        idl.assert_fields("FeeTerms", &[("listing_fee", "u64"), ("sale_fee_bps", "u16")]);
        idl.assert_fields(
            "CollectionTerms",
            &[
                ("name", "string"),
                ("uri", "string"),
                ("item_name", "string"),
                ("item_uri", "string"),
                ("uri_per_item", "bool"),
                ("royalty_bps", "u16"),
                ("hidden", "bool"),
            ],
        );
        idl.assert_fields("NewItem", &[("name", "string"), ("supply", "u32")]);
        idl
    }

    fn assert_fields(&self, ty: &str, expected: &[(&str, &str)]) {
        let actual: Vec<(String, String)> = self.types[ty]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                let kind = f["type"].as_str().map(str::to_string).unwrap_or_else(|| f["type"].to_string());
                (f["name"].as_str().unwrap().to_string(), kind)
            })
            .collect();
        let expected: Vec<(String, String)> = expected.iter().map(|(n, t)| (n.to_string(), t.to_string())).collect();
        assert_eq!(actual, expected, "layout of {ty}");
    }

    fn data(&self, name: &str, args: &[u8]) -> Vec<u8> {
        let mut data = self.discriminators[name].clone();
        data.extend_from_slice(args);
        data
    }

    /// Size of a fixed-size IDL type.
    fn size_of(&self, ty: &Value) -> usize {
        if let Some(name) = ty.as_str() {
            return match name {
                "u8" | "i8" | "bool" => 1,
                "u16" | "i16" => 2,
                "u32" | "i32" => 4,
                "u64" | "i64" => 8,
                "u128" | "i128" => 16,
                "pubkey" => 32,
                other => panic!("{other} has no fixed size"),
            };
        }
        if let Some(array) = ty.get("array") {
            return self.size_of(&array[0]) * array[1].as_u64().unwrap() as usize;
        }
        let name = ty["defined"]["name"].as_str().expect("defined type");
        let def = &self.types[name];
        match def["kind"].as_str().unwrap() {
            "enum" => {
                assert!(def["variants"].as_array().unwrap().iter().all(|v| v.get("fields").is_none()));
                1
            }
            "struct" => def["fields"].as_array().unwrap().iter().map(|f| self.size_of(&f["type"])).sum(),
            other => panic!("{other}"),
        }
    }

    /// Offset of `field` in an account of type `account`, counting the
    /// 8-byte discriminator. Only fixed-size fields may come before it.
    fn offset(&self, account: &str, field: &str) -> usize {
        let mut at = 8;
        for f in self.types[account]["fields"].as_array().unwrap() {
            if f["name"] == field {
                return at;
            }
            at += self.size_of(&f["type"]);
        }
        panic!("{account} has no field {field}");
    }

    fn variant(&self, ty: &str, name: &str) -> u8 {
        self.types[ty]["variants"]
            .as_array()
            .unwrap()
            .iter()
            .position(|v| v["name"] == name)
            .unwrap_or_else(|| panic!("{ty}::{name}")) as u8
    }
}

/// Little-endian argument encoder (Borsh for the types used here).
#[derive(Default)]
struct Args(Vec<u8>);

impl Args {
    fn u8(mut self, v: u8) -> Self {
        self.0.push(v);
        self
    }
    fn u16(mut self, v: u16) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u32(mut self, v: u32) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u64(mut self, v: u64) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn i64(mut self, v: i64) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u128(mut self, v: u128) -> Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn bytes(mut self, v: &[u8]) -> Self {
        self.0.extend_from_slice(v);
        self
    }
    fn string(self, v: &str) -> Self {
        self.bytes(&(v.len() as u32).to_le_bytes()).bytes(v.as_bytes())
    }
    /// `TokenSaleTerms`.
    fn token_terms(self, t: &TokenTerms) -> Self {
        self.u64(t.supply)
            .u64(t.price_unit)
            .u32(t.min_price)
            .u64(t.min_deposit)
            .i64(t.duration_secs)
    }
    /// `CollectionSaleTerms`.
    fn nft_terms(self, t: &NftTerms) -> Self {
        self.u64(t.supply).u32(t.min_price).u16(t.max_per_bid).i64(t.duration_secs)
    }
    /// `FeeTerms`: the most the seller accepts to pay.
    fn fees(self, fees: (u64, u16)) -> Self {
        self.u64(fees.0).u16(fees.1)
    }
    /// `ExpectedTerms`: the terms of `view`, as a bidder saw them.
    fn expected(self, view: &AuctionInfo) -> Self {
        self.bytes(view.mint.as_ref())
            .u64(view.supply)
            .u64(view.price_unit)
            .u64(view.price_scale)
            .u32(view.min_price)
            .u64(view.min_deposit)
            .u16(view.max_per_bid)
            .i64(view.end_time)
    }
}

fn pda(seeds: &[&[u8]]) -> Address {
    Address::find_program_address(seeds, &PROGRAM_ID).0
}

fn ata(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}

/// The NFT minted for place `position` of an auction.
fn asset_address(auction: &Address, position: u32) -> Address {
    pda(&[b"asset", auction.as_ref(), &position.to_le_bytes()])
}

/// The program's `shuffled_items` for one place: which NFT (from 0) place
/// `position` becomes among `supply` NFTs once `seed` is drawn.
fn shuffled_item(position: u32, supply: u32, seed: u128) -> u32 {
    fn mix64(mut z: u64) -> u64 {
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    let word = |round: u32, salt: u32| {
        let w = ((round as u64) << 32) | salt as u64;
        mix64(mix64(w ^ seed as u64) ^ (seed >> 64) as u64)
    };
    let n = supply as u64;
    let mut item = position as u64;
    for round in 0..64 {
        let pivot = word(round, u32::MAX) % n;
        let flip = (pivot + n - item) % n;
        if word(round, item.max(flip) as u32) & 1 == 1 {
            item = flip;
        }
    }
    item as u32
}

fn w(address: Address) -> AccountMeta {
    AccountMeta::new(address, false)
}
fn r(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, false)
}
fn signer(address: Address) -> AccountMeta {
    AccountMeta::new(address, true)
}

fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET, &data, vec![])
}

/// Reads a Borsh string at `at`; returns it and the offset after it.
fn read_string(data: &[u8], at: usize) -> (String, usize) {
    let len = u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
    (String::from_utf8(data[at + 4..at + 4 + len].to_vec()).unwrap(), at + 4 + len)
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

fn field_modulus() -> BigUint {
    (BigUint::from(1u8) << 255u32) - BigUint::from(19u8)
}

fn to_bytes32(v: &BigUint) -> [u8; 32] {
    let mut out = [0u8; 32];
    let bytes = v.to_bytes_le();
    out[..bytes.len()].copy_from_slice(&bytes);
    out
}

/// (u - 1) / (u + 1) mod p, the hint `place_bid` checks a key with.
fn edwards_y(u: &[u8; 32]) -> [u8; 32] {
    let p = field_modulus();
    let u = BigUint::from_bytes_le(u) % &p;
    let inverse = ((&u + 1u8) % &p).modpow(&(&p - 2u8), &p);
    to_bytes32(&(((&u + &p - 1u8) % &p) * inverse % &p))
}

fn honest_key(i: u64) -> [u8; 32] {
    let secret = solana_sha256_hasher::hashv(&[b"secret", &i.to_le_bytes()]).to_bytes();
    MontgomeryPoint::mul_base_clamped(secret).to_bytes()
}

/// A canonical field element that is not a real ciphertext; fine for bids
/// that never reach MPC in these tests.
fn ciphertext(i: u64) -> [u8; 32] {
    let mut c = solana_sha256_hasher::hashv(&[b"ct", &i.to_le_bytes()]).to_bytes();
    c[31] &= 0x3f;
    c
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/// Terms of a test token auction, as `create_auction` takes them.
#[derive(Clone, Copy)]
struct TokenTerms {
    supply: u64,
    price_unit: u64,
    min_price: u32,
    min_deposit: u64,
    duration_secs: i64,
}

/// Terms of a test collection auction, as `create_collection_auction` takes
/// them.
#[derive(Clone, Copy)]
struct NftTerms {
    supply: u64,
    min_price: u32,
    max_per_bid: u16,
    duration_secs: i64,
}

/// An opened auction and its terms as a bidder sees them.
#[derive(Clone, Copy)]
struct AuctionInfo {
    seller: Address,
    auction: Address,
    book: Address,
    /// The token, or the collection of a collection auction.
    mint: Address,
    vault: Address,
    is_collection: bool,
    supply: u64,
    price_unit: u64,
    price_scale: u64,
    min_price: u32,
    min_deposit: u64,
    max_per_bid: u16,
    end_time: i64,
}

struct Env {
    svm: LiteSVM,
    idl: Idl,
    admin: Keypair,
    treasury: Keypair,
    max_compute_units: u64,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = artifact("SEALED_AUCTION_SO", "target/deploy/sealed_auction.so");
        svm.add_program_from_file(PROGRAM_ID, &so)
            .unwrap_or_else(|e| panic!("load {}: {e:?}", so.display()));
        let core = artifact("MPL_CORE_SO", "tests/svm/fixtures/mpl_core.so");
        svm.add_program_from_file(MPL_CORE, &core).unwrap_or_else(|e| {
            panic!(
                "load {}: {e:?}. Dump Metaplex Core first: solana program dump -u devnet \
                 CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d tests/svm/fixtures/mpl_core.so",
                core.display()
            )
        });
        let mut env = Env {
            svm,
            idl: Idl::load(),
            admin: Keypair::new(),
            treasury: Keypair::new(),
            max_compute_units: 0,
        };
        env.svm.airdrop(&env.admin.pubkey(), 10 * SOL).unwrap();
        env.svm.airdrop(&env.treasury.pubkey(), SOL).unwrap();

        // The config as `initialize` leaves it; that instruction needs the
        // upgrade authority of a real deployment.
        let (config, bump) = Address::find_program_address(&[b"config"], &PROGRAM_ID);
        let mut data = env.idl.account_discriminators["Config"].clone();
        data.extend_from_slice(env.admin.pubkey().as_ref());
        data.push(0); // no pending admin
        data.push(bump);
        let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
        env.svm
            .set_account(
                config,
                Account {
                    lamports,
                    data,
                    owner: PROGRAM_ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let admin = env.admin.insecure_clone();
        let ix = env.set_fees_ix(&admin.pubkey(), LISTING_FEE, SALE_FEE_BPS, env.treasury.pubkey());
        env.send(&[ix], &admin, &[]).expect("set fees");
        env
    }

    fn funded(&mut self, sol: u64) -> Keypair {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), sol * SOL).unwrap();
        kp
    }

    /// Sends a transaction that must fit `limit` compute units; when the
    /// limit is above the default, it is requested first.
    fn send_with_limit(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        extra: &[&Keypair],
        limit: u32,
    ) -> Result<u64, TransactionError> {
        let mut all = Vec::new();
        if limit > 200_000 {
            all.push(compute_limit(limit));
        }
        all.extend_from_slice(ixs);
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(&all, Some(&payer.pubkey()), &signers, self.svm.latest_blockhash());
        let result = self.svm.send_transaction(tx);
        // Lets identical transactions run again later in the test.
        self.svm.expire_blockhash();
        match result {
            Ok(meta) => {
                assert!(
                    meta.compute_units_consumed < limit as u64,
                    "{} compute units",
                    meta.compute_units_consumed
                );
                self.max_compute_units = self.max_compute_units.max(meta.compute_units_consumed);
                Ok(meta.compute_units_consumed)
            }
            Err(failed) => Err(failed.err),
        }
    }

    /// Every instruction except NFT claims must fit the default budget.
    fn send(&mut self, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> Result<u64, TransactionError> {
        self.send_with_limit(ixs, payer, extra, 200_000)
    }

    fn expect_error(&mut self, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair], name: &str) {
        let code = match self.idl.errors.get(name) {
            Some(&code) => code,
            None => anchor_error(name),
        };
        match self.send_with_limit(ixs, payer, extra, 1_400_000) {
            Err(TransactionError::InstructionError(_, InstructionError::Custom(c))) if c == code => {}
            other => panic!("expected {name} ({code}), got {other:?}"),
        }
    }

    fn balance(&self, address: &Address) -> u64 {
        self.svm.get_balance(address).unwrap_or(0)
    }

    fn exists(&self, address: &Address) -> bool {
        self.svm.get_account(address).map(|a| a.lamports > 0).unwrap_or(false)
    }

    fn data(&self, address: &Address) -> Vec<u8> {
        self.svm.get_account(address).expect("account").data
    }

    /// Lamports an account holds above its rent-exempt minimum.
    fn above_rent(&self, address: &Address) -> u64 {
        self.balance(address) - self.svm.minimum_balance_for_rent_exemption(self.data(address).len())
    }

    fn token_amount(&self, account: &Address) -> u64 {
        let data = self.data(account);
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        clock.slot += 1_000;
        self.svm.set_sysvar(&clock);
    }

    // -- Reading and writing account fields --------------------------------

    fn read(&self, address: &Address, account: &str, field: &str, len: usize) -> Vec<u8> {
        let at = self.idl.offset(account, field);
        self.data(address)[at..at + len].to_vec()
    }

    fn read_u32(&self, address: &Address, account: &str, field: &str) -> u32 {
        u32::from_le_bytes(self.read(address, account, field, 4).try_into().unwrap())
    }

    fn read_u64(&self, address: &Address, account: &str, field: &str) -> u64 {
        u64::from_le_bytes(self.read(address, account, field, 8).try_into().unwrap())
    }

    fn read_u128(&self, address: &Address, account: &str, field: &str) -> u128 {
        u128::from_le_bytes(self.read(address, account, field, 16).try_into().unwrap())
    }

    fn bid_u64(&self, bid: &Address, field: &str) -> u64 {
        self.read_u64(bid, "Bid", field)
    }

    /// Where an `Auction` field after its two strings sits; `offset` cannot
    /// see past them, as their lengths vary.
    fn auction_tail(&self, auction: &Address, field: &str) -> usize {
        let data = self.data(auction);
        let (_, after_name) = read_string(&data, self.idl.offset("Auction", "item_name"));
        let (_, mut at) = read_string(&data, after_name);
        for (name, size) in [
            ("assigned_positions", 4),
            ("nft_seed", 16),
            ("seed_drawn", 1),
            ("named_items", 1),
            ("unrevealed", 1),
        ] {
            if name == field {
                return at;
            }
            at += size;
        }
        panic!("Auction has no field {field} after its strings");
    }

    fn write_auction_tail(&mut self, auction: &Address, field: &str, bytes: &[u8]) {
        let at = self.auction_tail(auction, field);
        let mut acc = self.svm.get_account(auction).expect("auction");
        acc.data[at..at + bytes.len()].copy_from_slice(bytes);
        self.svm.set_account(*auction, acc).unwrap();
    }

    fn auction_flag(&self, auction: &Address, field: &str) -> bool {
        let at = self.auction_tail(auction, field);
        self.data(auction)[at] == 1
    }

    fn assigned_positions(&self, auction: &Address) -> u32 {
        let at = self.auction_tail(auction, "assigned_positions");
        u32::from_le_bytes(self.data(auction)[at..at + 4].try_into().unwrap())
    }

    fn book_deposit(&self, a: &AuctionInfo, index: usize) -> u64 {
        let at = self.idl.offset("BidBook", "deposits") + 8 * index;
        u64::from_le_bytes(self.data(&a.book)[at..at + 8].try_into().unwrap())
    }

    /// Checks that the auction account holds the terms `a` describes.
    fn assert_terms(&self, a: &AuctionInfo) {
        let at = |field: &str| self.read(&a.auction, "Auction", field, 8);
        assert_eq!(self.read_u64(&a.auction, "Auction", "supply"), a.supply);
        assert_eq!(self.read_u64(&a.auction, "Auction", "price_unit"), a.price_unit);
        assert_eq!(self.read_u64(&a.auction, "Auction", "price_scale"), a.price_scale);
        assert_eq!(self.read_u32(&a.auction, "Auction", "min_price"), a.min_price);
        assert_eq!(self.read_u64(&a.auction, "Auction", "min_deposit"), a.min_deposit);
        assert_eq!(self.read(&a.auction, "Auction", "max_per_bid", 2), a.max_per_bid.to_le_bytes());
        assert_eq!(at("end_time"), a.end_time.to_le_bytes());
        assert_eq!(self.read(&a.auction, "Auction", "mint", 32), a.mint.as_ref());
        let kind = self.idl.variant("AuctionKind", if a.is_collection { "Collection" } else { "Token" });
        assert_eq!(self.read(&a.auction, "Auction", "kind", 1), [kind]);
    }

    /// Writes fields the way an MPC callback would have.
    fn write(&mut self, address: &Address, account: &str, fields: &[(&str, Vec<u8>)]) {
        let mut acc = self.svm.get_account(address).expect("account");
        for (field, bytes) in fields {
            let at = self.idl.offset(account, field);
            acc.data[at..at + bytes.len()].copy_from_slice(bytes);
        }
        self.svm.set_account(*address, acc).unwrap();
    }

    /// Moves lamports the way a settlement moves a payment.
    fn shift_lamports(&mut self, from: &Address, to: &Address, amount: u64) {
        let mut a = self.svm.get_account(from).unwrap();
        a.lamports -= amount;
        self.svm.set_account(*from, a).unwrap();
        let mut b = self.svm.get_account(to).unwrap();
        b.lamports += amount;
        self.svm.set_account(*to, b).unwrap();
    }

    /// The state `clear_price_callback` leaves: every bid checked, the
    /// clearing price (the minimum price when demand never covered the
    /// supply) and the demand above and at it, which must pass the same
    /// consistency check the callback applies.
    fn simulate_clearing(&mut self, a: &AuctionInfo, price: u32, filled: bool, weight_above: u128, weight_at: u128) {
        let supply = a.supply as u128;
        let consistent = match (a.is_collection, filled) {
            (true, true) => weight_above < supply && weight_above + weight_at >= supply,
            (true, false) => weight_above < supply,
            (false, true) => {
                let unit = a.price_unit as u128;
                (weight_above + weight_at) * unit >= supply * price as u128
                    && weight_above * unit < supply * (price as u128 + 1)
            }
            (false, false) => weight_above * (a.price_unit as u128) < supply * a.min_price as u128,
        };
        assert!(consistent, "the callback would refuse this clearing");
        assert!(if filled { price >= a.min_price } else { price == a.min_price && weight_at == 0 });

        let settling = self.idl.variant("AuctionStatus", "Settling");
        let bids = self.read(&a.auction, "Auction", "bid_count", 4);
        self.write(
            &a.auction,
            "Auction",
            &[
                ("status", vec![settling]),
                ("checked_count", bids),
                ("clearing_price", price.to_le_bytes().to_vec()),
                ("filled", vec![filled as u8]),
                ("weight_above", weight_above.to_le_bytes().to_vec()),
                ("weight_at", weight_at.to_le_bytes().to_vec()),
            ],
        );
    }

    /// The state `award_bid_callback` (or `finalize_share`) leaves for a
    /// decided bid: what it won, and its payment moved to the auction.
    fn simulate_award(&mut self, a: &AuctionInfo, bid: &Address, outcome: u8, won: u64, payment: u64) {
        assert!(payment <= self.bid_u64(bid, "deposit"));
        self.shift_lamports(bid, &a.auction, payment);
        let settled = self.idl.variant("BidStatus", "Settled");
        self.write(
            bid,
            "Bid",
            &[
                ("status", vec![settled]),
                ("outcome", vec![outcome]),
                ("won", won.to_le_bytes().to_vec()),
                ("payment", payment.to_le_bytes().to_vec()),
            ],
        );
        // A winning collection bid takes the next places, as the program does.
        if a.is_collection && won > 0 {
            let first = self.assigned_positions(&a.auction);
            self.write(bid, "Bid", &[("first_position", first.to_le_bytes().to_vec())]);
            let next = first + won as u32;
            self.write_auction_tail(&a.auction, "assigned_positions", &next.to_le_bytes());
        }
        let sold = self.read_u64(&a.auction, "Auction", "sold") + won;
        assert!(sold <= a.supply, "oversold");
        let proceeds = self.read_u64(&a.auction, "Auction", "proceeds") + payment;
        let resolved = self.read_u32(&a.auction, "Auction", "resolved_count") + 1;
        self.write(
            &a.auction,
            "Auction",
            &[
                ("sold", sold.to_le_bytes().to_vec()),
                ("proceeds", proceeds.to_le_bytes().to_vec()),
                ("resolved_count", resolved.to_le_bytes().to_vec()),
            ],
        );
    }

    /// The state `award_bid_callback` leaves for a collection bid exactly at
    /// the clearing price: its size, recorded for `finalize_share`, and once
    /// every such bid is revealed, the NFTs left for them counted as sold.
    fn simulate_at_clearing(&mut self, a: &AuctionInfo, bid: &Address, quantity: u32) {
        assert!(a.is_collection);
        let at_clearing = self.idl.variant("BidStatus", "AtClearing");
        self.write(bid, "Bid", &[("status", vec![at_clearing]), ("outcome", vec![OUTCOME_AT])]);
        let index = self.read_u32(bid, "Bid", "index") as usize;
        let at = self.idl.offset("BidBook", "clearing_quantities") + 4 * index;
        let mut book = self.svm.get_account(&a.book).unwrap();
        book.data[at..at + 4].copy_from_slice(&quantity.to_le_bytes());
        self.svm.set_account(a.book, book).unwrap();
        let revealed = self.read_u128(&a.auction, "Auction", "at_revealed") + quantity as u128;
        let mut fields = vec![("at_revealed", revealed.to_le_bytes().to_vec())];
        if revealed == self.read_u128(&a.auction, "Auction", "weight_at") {
            let left = a.supply - self.read_u128(&a.auction, "Auction", "weight_above") as u64;
            let sold = self.read_u64(&a.auction, "Auction", "sold") + left;
            fields.push(("sold", sold.to_le_bytes().to_vec()));
        }
        self.write(&a.auction, "Auction", &fields);
    }

    /// The state `draw_seed_callback` leaves: the seed that turns places into
    /// NFT numbers.
    fn simulate_draw(&mut self, a: &AuctionInfo, seed: u128) {
        assert!(a.is_collection);
        self.write_auction_tail(&a.auction, "nft_seed", &seed.to_le_bytes());
        self.write_auction_tail(&a.auction, "seed_drawn", &[1]);
    }

    // -- Instructions ------------------------------------------------------

    fn fee_config(&self) -> Address {
        pda(&[b"fees"])
    }

    fn set_fees_ix(&self, admin: &Address, listing_fee: u64, sale_fee_bps: u16, treasury: Address) -> Instruction {
        Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("set_fees", &Args::default().u64(listing_fee).u16(sale_fee_bps).0),
            vec![
                signer(*admin),
                r(pda(&[b"config"])),
                w(self.fee_config()),
                r(treasury),
                r(SYSTEM_PROGRAM),
            ],
        )
    }

    fn set_listing_ix(&self, admin: &Address, auction: &Address, featured: bool, hidden: bool) -> Instruction {
        Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("set_listing", &Args::default().u8(featured as u8).u8(hidden as u8).0),
            vec![AccountMeta::new_readonly(*admin, true), r(pda(&[b"config"])), w(*auction)],
        )
    }

    /// A classic SPL token without decimals, with `supply` units in the
    /// owner's account and its mint authority revoked (no freeze authority
    /// from the start).
    fn fixed_supply_mint(&mut self, owner: &Keypair, supply: u64) -> Address {
        let mint = Keypair::new();
        let rent = self.svm.minimum_balance_for_rent_exemption(82);
        let owner_ata = ata(&owner.pubkey(), &mint.pubkey());
        let mut init = vec![20u8, 0];
        init.extend_from_slice(owner.pubkey().as_ref());
        init.push(0); // no freeze authority
        let mut mint_to = vec![7u8];
        mint_to.extend_from_slice(&supply.to_le_bytes());
        let ixs = [
            solana_system_interface::instruction::create_account(
                &owner.pubkey(),
                &mint.pubkey(),
                rent,
                82,
                &TOKEN_PROGRAM,
            ),
            Instruction::new_with_bytes(TOKEN_PROGRAM, &init, vec![w(mint.pubkey())]),
            create_ata_ix(&owner.pubkey(), &owner.pubkey(), &mint.pubkey()),
            Instruction::new_with_bytes(
                TOKEN_PROGRAM,
                &mint_to,
                vec![w(mint.pubkey()), w(owner_ata), signer(owner.pubkey())],
            ),
            // SetAuthority(MintTokens, None)
            Instruction::new_with_bytes(
                TOKEN_PROGRAM,
                &[6u8, 0, 0],
                vec![w(mint.pubkey()), signer(owner.pubkey())],
            ),
        ];
        self.send(&ixs, owner, &[&mint]).expect("create mint");
        mint.pubkey()
    }

    fn create_auction_ix(
        &self,
        seller: &Address,
        seed: u64,
        mint: Address,
        terms: TokenTerms,
        fees: (u64, u16),
    ) -> (Instruction, AuctionInfo) {
        let auction = pda(&[b"auction", seller.as_ref(), &seed.to_le_bytes()]);
        let book = pda(&[b"book", auction.as_ref()]);
        let vault = ata(&auction, &mint);
        let args = Args::default().u64(seed).token_terms(&terms).fees(fees);
        let ix = Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("create_auction", &args.0),
            vec![
                signer(*seller),
                w(auction),
                w(book),
                r(mint),
                w(ata(seller, &mint)),
                w(vault),
                r(self.fee_config()),
                w(self.treasury.pubkey()),
                r(TOKEN_PROGRAM),
                r(ATA_PROGRAM),
                r(SYSTEM_PROGRAM),
            ],
        );
        let info = AuctionInfo {
            seller: *seller,
            auction,
            book,
            mint,
            vault,
            is_collection: false,
            supply: terms.supply,
            price_unit: terms.price_unit,
            price_scale: 1,
            min_price: terms.min_price,
            min_deposit: terms.min_deposit,
            max_per_bid: 0,
            end_time: self.now() + terms.duration_secs,
        };
        (ix, info)
    }

    fn create_auction(&mut self, seller: &Keypair, seed: u64, mint: Address, terms: TokenTerms) -> AuctionInfo {
        let (ix, info) = self.create_auction_ix(&seller.pubkey(), seed, mint, terms, (LISTING_FEE, SALE_FEE_BPS));
        self.send(&[ix], seller, &[]).expect("create auction");
        info
    }

    fn create_collection_ix(
        &self,
        seller: &Address,
        seed: u64,
        terms: NftTerms,
        collection: &CollectionTerms,
    ) -> (Instruction, AuctionInfo) {
        self.create_collection_ix_with(seller, seed, terms, collection, None)
    }

    /// `create_collection_auction`, with the item list of a collection named
    /// per item.
    fn create_collection_ix_with(
        &self,
        seller: &Address,
        seed: u64,
        terms: NftTerms,
        collection: &CollectionTerms,
        item_list: Option<Address>,
    ) -> (Instruction, AuctionInfo) {
        let auction = pda(&[b"auction", seller.as_ref(), &seed.to_le_bytes()]);
        let book = pda(&[b"book", auction.as_ref()]);
        let collection_address = pda(&[b"collection", auction.as_ref()]);
        let args = Args::default()
            .u64(seed)
            .nft_terms(&terms)
            .fees((LISTING_FEE, SALE_FEE_BPS))
            .string(collection.name)
            .string(collection.uri)
            .string(collection.item_name)
            .string(collection.item_uri)
            .u8(collection.uri_per_item as u8)
            .u16(collection.royalty_bps)
            .u8(collection.hidden as u8);
        let ix = Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("create_collection_auction", &args.0),
            vec![
                signer(*seller),
                w(auction),
                w(book),
                w(collection_address),
                r(self.fee_config()),
                w(self.treasury.pubkey()),
                r(MPL_CORE),
                r(SYSTEM_PROGRAM),
                // Optional accounts that are absent are passed as the program id.
                item_list.map(w).unwrap_or(r(PROGRAM_ID)),
            ],
        );
        let info = AuctionInfo {
            seller: *seller,
            auction,
            book,
            mint: collection_address,
            vault: Address::default(),
            is_collection: true,
            supply: terms.supply,
            price_unit: 1,
            price_scale: NFT_PRICE_SCALE,
            min_price: terms.min_price,
            // The cheapest valid bid: one NFT at the minimum price.
            min_deposit: terms.min_price as u64 * NFT_PRICE_SCALE,
            max_per_bid: terms.max_per_bid,
            end_time: self.now() + terms.duration_secs,
        };
        (ix, info)
    }

    fn create_collection(&mut self, seller: &Keypair, seed: u64, terms: NftTerms) -> AuctionInfo {
        let (ix, info) = self.create_collection_ix(&seller.pubkey(), seed, terms, &CATS);
        self.send(&[ix], seller, &[]).expect("create collection auction");
        info
    }

    /// `place_bid` on the auction of `view`, for the terms `view` shows.
    #[allow(clippy::too_many_arguments)]
    fn place_bid_ix(
        &self,
        view: &AuctionInfo,
        bidder: &Address,
        seed: u64,
        key: [u8; 32],
        hint: [u8; 32],
        deposit: u64,
        evicted: Option<(Address, Address)>,
    ) -> (Instruction, Address) {
        let bid = pda(&[b"bid", view.auction.as_ref(), bidder.as_ref(), &seed.to_le_bytes()]);
        let nonce_digest = solana_sha256_hasher::hashv(&[b"sealed-auction/bid-nonce/v1", bid.as_ref()]).to_bytes();
        let nonce = u128::from_le_bytes(nonce_digest[..16].try_into().unwrap());
        let args = Args::default()
            .u64(seed)
            .expected(view)
            // Price and quantity ciphertexts, key, hint, nonce, deposit
            .bytes(&ciphertext(seed))
            .bytes(&ciphertext(seed + 1_000_000))
            .bytes(&key)
            .bytes(&hint)
            .u128(nonce)
            .u64(deposit);
        // Optional accounts that are absent are passed as the program id.
        let (evicted_bid, evicted_bidder) = match evicted {
            Some((bid, owner)) => (w(bid), w(owner)),
            None => (r(PROGRAM_ID), r(PROGRAM_ID)),
        };
        let ix = Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("place_bid", &args.0),
            vec![
                signer(*bidder),
                w(view.auction),
                w(view.book),
                w(bid),
                evicted_bid,
                evicted_bidder,
                r(SYSTEM_PROGRAM),
            ],
        );
        (ix, bid)
    }

    /// Places an honest bid and returns its address.
    fn bid(&mut self, a: &AuctionInfo, bidder: &Keypair, seed: u64, deposit: u64) -> Address {
        let key = honest_key(seed);
        let (ix, bid) = self.place_bid_ix(a, &bidder.pubkey(), seed, key, edwards_y(&key), deposit, None);
        self.send(&[ix], bidder, &[]).expect("place bid");
        bid
    }

    /// `cancel_auction`, `claim_proceeds` or `close_auction` of a token
    /// auction.
    fn seller_ix(&self, name: &str, a: &AuctionInfo) -> Instruction {
        let mut accounts = vec![signer(a.seller), w(a.auction)];
        if name == "close_auction" {
            accounts.push(w(a.book));
        } else {
            accounts.push(w(self.treasury.pubkey()));
        }
        accounts.extend([
            r(a.mint),
            w(a.vault),
            w(ata(&a.seller, &a.mint)),
            r(TOKEN_PROGRAM),
            r(ATA_PROGRAM),
            r(SYSTEM_PROGRAM),
        ]);
        Instruction::new_with_bytes(PROGRAM_ID, &self.idl.data(name, &[]), accounts)
    }

    /// `cancel_collection_auction`, `claim_collection_proceeds` or
    /// `close_collection_auction`.
    fn collection_seller_ix(&self, name: &str, a: &AuctionInfo) -> Instruction {
        self.collection_seller_ix_with(name, a, None)
    }

    /// The same, closing the auction's item list with it.
    fn collection_seller_ix_with(&self, name: &str, a: &AuctionInfo, item_list: Option<Address>) -> Instruction {
        let accounts = if name == "close_collection_auction" {
            vec![
                signer(a.seller),
                w(a.auction),
                w(a.book),
                w(a.mint),
                r(MPL_CORE),
                r(SYSTEM_PROGRAM),
                item_list.map(w).unwrap_or(r(PROGRAM_ID)),
            ]
        } else {
            vec![signer(a.seller), w(a.auction), w(self.treasury.pubkey())]
        };
        Instruction::new_with_bytes(PROGRAM_ID, &self.idl.data(name, &[]), accounts)
    }

    /// `close_bid` or `emergency_refund`.
    fn bid_ix(&self, name: &str, a: &AuctionInfo, bid: Address, owner: Address) -> Instruction {
        Instruction::new_with_bytes(PROGRAM_ID, &self.idl.data(name, &[]), vec![w(owner), w(a.auction), w(bid)])
    }

    fn finalize_ix(&self, a: &AuctionInfo, bid: Address) -> Instruction {
        Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("finalize_share", &[]),
            vec![w(a.auction), r(a.book), w(bid)],
        )
    }

    fn claim_tokens_ix(&self, a: &AuctionInfo, payer: Address, bid: Address, owner: Address) -> Instruction {
        Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("claim_tokens", &[]),
            vec![
                signer(payer),
                w(a.auction),
                w(bid),
                r(owner),
                w(a.seller),
                r(a.mint),
                w(a.vault),
                w(ata(&owner, &a.mint)),
                r(TOKEN_PROGRAM),
                r(ATA_PROGRAM),
                r(SYSTEM_PROGRAM),
            ],
        )
    }

    fn claim_nfts_ix(&self, a: &AuctionInfo, payer: Address, bid: Address, owner: Address, assets: &[Address]) -> Instruction {
        self.claim_named_nfts_ix(a, payer, bid, owner, assets, None)
    }

    /// `claim_nfts` of a collection named per item, with its item list.
    fn claim_named_nfts_ix(
        &self,
        a: &AuctionInfo,
        payer: Address,
        bid: Address,
        owner: Address,
        assets: &[Address],
        item_list: Option<Address>,
    ) -> Instruction {
        let mut accounts = vec![
            signer(payer),
            w(a.auction),
            w(bid),
            r(owner),
            w(a.mint),
            r(MPL_CORE),
            r(SYSTEM_PROGRAM),
            r(item_list.unwrap_or(PROGRAM_ID)),
        ];
        accounts.extend(assets.iter().map(|asset| w(*asset)));
        Instruction::new_with_bytes(PROGRAM_ID, &self.idl.data("claim_nfts", &[]), accounts)
    }

    fn init_item_list_ix(&self, seller: &Address, seed: u64) -> Instruction {
        let auction = pda(&[b"auction", seller.as_ref(), &seed.to_le_bytes()]);
        Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("init_item_list", &Args::default().u64(seed).0),
            vec![signer(*seller), r(auction), w(item_list_address(&auction)), r(SYSTEM_PROGRAM)],
        )
    }

    fn add_items_ix(&self, seller: &Address, item_list: Address, items: &[(&str, u32)]) -> Instruction {
        let mut args = Args::default().u32(items.len() as u32);
        for (name, supply) in items {
            args = args.string(name).u32(*supply);
        }
        Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("add_items", &args.0),
            vec![signer(*seller), w(item_list), r(SYSTEM_PROGRAM)],
        )
    }

    fn close_item_list_ix(&self, seller: &Address, item_list: Address) -> Instruction {
        Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("close_item_list", &[]),
            vec![signer(*seller), w(item_list)],
        )
    }

    fn reveal_ix(&self, a: &AuctionInfo) -> Instruction {
        Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("reveal_collection", &[]),
            vec![AccountMeta::new_readonly(a.seller, true), w(a.auction)],
        )
    }

    fn refund_unrevealed_ix(&self, a: &AuctionInfo, bid: Address) -> Instruction {
        Instruction::new_with_bytes(
            PROGRAM_ID,
            &self.idl.data("refund_unrevealed", &[]),
            vec![w(a.auction), w(bid)],
        )
    }
}

/// The item list of the collection auction at `auction`.
fn item_list_address(auction: &Address) -> Address {
    pda(&[b"items", auction.as_ref()])
}

/// Anchor's own errors, which the IDL does not list.
fn anchor_error(name: &str) -> u32 {
    match name {
        "ConstraintSeeds" => 2006,
        other => panic!("no error named {other}"),
    }
}

/// What a collection auction sells, as `create_collection_auction` takes it.
#[derive(Clone, Copy)]
struct CollectionTerms {
    name: &'static str,
    uri: &'static str,
    item_name: &'static str,
    item_uri: &'static str,
    uri_per_item: bool,
    royalty_bps: u16,
    hidden: bool,
}

const CATS: CollectionTerms = CollectionTerms {
    name: "Veiling Cats",
    uri: "https://example.com/cats/collection.json",
    item_name: "Veiling Cat",
    item_uri: "https://example.com/cats/",
    uri_per_item: true,
    royalty_bps: 500,
    hidden: false,
};

/// A collection named per item: each item's name and how many editions of
/// it there are, in the order the item list holds them.
const TILES: [(&str, u32); 3] = [("Gün Batımı", 3), ("Lale", 1), ("Çini", 2)];

fn create_ata_ix(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
    Instruction::new_with_bytes(
        ATA_PROGRAM,
        &[1u8], // CreateIdempotent
        vec![
            signer(*payer),
            w(ata(owner, mint)),
            r(*owner),
            r(*mint),
            r(SYSTEM_PROGRAM),
            r(TOKEN_PROGRAM),
        ],
    )
}

/// A Core collection: (update authority, name, uri, num_minted, current_size).
fn read_collection(data: &[u8]) -> (Address, String, String, u32, u32) {
    assert_eq!(data[0], 5, "CollectionV1");
    let authority = Address::new_from_array(data[1..33].try_into().unwrap());
    let (name, at) = read_string(data, 33);
    let (uri, at) = read_string(data, at);
    let minted = u32::from_le_bytes(data[at..at + 4].try_into().unwrap());
    let size = u32::from_le_bytes(data[at + 4..at + 8].try_into().unwrap());
    (authority, name, uri, minted, size)
}

/// A Core asset: (owner, collection it belongs to, name, uri).
fn read_asset(data: &[u8]) -> (Address, Address, String, String) {
    assert_eq!(data[0], 1, "AssetV1");
    let owner = Address::new_from_array(data[1..33].try_into().unwrap());
    assert_eq!(data[33], 2, "update authority: its collection");
    let collection = Address::new_from_array(data[34..66].try_into().unwrap());
    let (name, at) = read_string(data, 66);
    let (uri, _) = read_string(data, at);
    (owner, collection, name, uri)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn opening_checks_the_sale_terms() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let mint = env.fixed_supply_mint(&seller, 1_000);

    // Accounts of the earlier releases cannot be mistaken for these.
    for (account, discriminator) in [("Auction", b"VAuctn02"), ("BidBook", b"VBook_02"), ("Bid", b"VBid__02")] {
        assert_eq!(env.idl.account_discriminators[account], discriminator.to_vec());
    }

    // -- Token auctions ------------------------------------------------------
    let refused = [
        (TokenTerms { supply: 0, ..TOKEN_TERMS }, "InvalidSupply"),
        (TokenTerms { price_unit: 0, ..TOKEN_TERMS }, "InvalidPriceUnit"),
        (TokenTerms { price_unit: 3, ..TOKEN_TERMS }, "InvalidPriceUnit"),
        (TokenTerms { price_unit: 20, ..TOKEN_TERMS }, "InvalidPriceUnit"),
        (TokenTerms { price_unit: 100_000_000_000_000_000, ..TOKEN_TERMS }, "InvalidPriceUnit"),
        (TokenTerms { min_price: 0, ..TOKEN_TERMS }, "InvalidPrice"),
        (TokenTerms { min_deposit: 0, ..TOKEN_TERMS }, "InvalidMinDeposit"),
        (TokenTerms { duration_secs: 59, ..TOKEN_TERMS }, "InvalidDuration"),
        (TokenTerms { duration_secs: MAX_DURATION_SECS + 1, ..TOKEN_TERMS }, "InvalidDuration"),
    ];
    for (terms, error) in refused {
        let (ix, _) = env.create_auction_ix(&seller.pubkey(), 1, mint, terms, (LISTING_FEE, SALE_FEE_BPS));
        env.expect_error(&[ix], &seller, &[], error);
    }
    // A price may refer to up to 10^16 base units: one token of 16 decimals.
    let terms = TokenTerms {
        price_unit: 10_000_000_000_000_000,
        min_price: 7,
        min_deposit: 1,
        ..TOKEN_TERMS
    };
    let a = env.create_auction(&seller, 1, mint, terms);
    env.assert_terms(&a);
    assert_eq!(env.token_amount(&a.vault), 100);

    // -- Collection auctions -------------------------------------------------
    let nft = NftTerms {
        supply: 6,
        min_price: 900,
        max_per_bid: 5,
        duration_secs: DURATION_SECS,
    };
    let refused = [
        (NftTerms { supply: 0, ..nft }, "InvalidSupply"),
        (NftTerms { supply: 10_001, max_per_bid: 1, ..nft }, "InvalidSupply"),
        (NftTerms { min_price: 0, ..nft }, "InvalidPrice"),
        (NftTerms { max_per_bid: 0, ..nft }, "InvalidMaxPerBid"),
        (NftTerms { max_per_bid: 7, ..nft }, "InvalidMaxPerBid"),
        (NftTerms { duration_secs: MAX_DURATION_SECS + 1, ..nft }, "InvalidDuration"),
    ];
    for (terms, error) in refused {
        let (ix, _) = env.create_collection_ix(&seller.pubkey(), 2, terms, &CATS);
        env.expect_error(&[ix], &seller, &[], error);
    }
    for bad in [
        CollectionTerms { item_uri: "http://example.com/", ..CATS },
        CollectionTerms { uri: "https://example.com/a b.json", ..CATS },
        CollectionTerms { name: "Veiling\u{202e}Cats", ..CATS },
        CollectionTerms { item_name: "A name far too long for an NFT", ..CATS },
        CollectionTerms { name: "   ", ..CATS },
        CollectionTerms { royalty_bps: 1_001, ..CATS },
    ] {
        let (ix, _) = env.create_collection_ix(&seller.pubkey(), 2, nft, &bad);
        env.expect_error(&[ix], &seller, &[], "InvalidCollectionTerms");
    }
    let c = env.create_collection(&seller, 2, nft);
    env.assert_terms(&c);
    assert_eq!(c.min_deposit, 900_000, "one NFT at the minimum price");

    // A bid deposits at least the minimum and names the terms it saw.
    let bidder = env.funded(1);
    let key = honest_key(1);
    let hint = edwards_y(&key);
    let (ix, _) = env.place_bid_ix(&c, &bidder.pubkey(), 1, key, hint, c.min_deposit - 1, None);
    env.expect_error(&[ix], &bidder, &[], "DepositTooSmall");
    for view in [
        AuctionInfo { max_per_bid: 4, ..c },
        AuctionInfo { price_scale: 1, ..c },
        AuctionInfo { min_deposit: c.min_deposit - 1, ..c },
    ] {
        let (ix, _) = env.place_bid_ix(&view, &bidder.pubkey(), 1, key, hint, c.min_deposit, None);
        env.expect_error(&[ix], &bidder, &[], "TermsMismatch");
    }
    let bid = env.bid(&c, &bidder, 1, c.min_deposit);
    assert_eq!(env.bid_u64(&bid, "deposit"), c.min_deposit);
    assert_eq!(env.read_u64(&c.auction, "Auction", "total_deposited"), c.min_deposit);
}

#[test]
fn bids_are_checked_full_auctions_evict_and_the_safety_net_returns_everything() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let bidder = env.funded(100);
    let rival = env.funded(10);
    let mint = env.fixed_supply_mint(&seller, 1_000);
    let a = env.create_auction(&seller, 7, mint, TOKEN_TERMS);
    assert_eq!(env.token_amount(&a.vault), TOKEN_TERMS.supply);
    env.assert_terms(&a);

    // -- Bid checks --------------------------------------------------------
    let key = honest_key(0);
    let hint = edwards_y(&key);
    let min_deposit = a.min_deposit;
    let bad = |env: &Env, view: &AuctionInfo, key: [u8; 32], hint: [u8; 32], deposit: u64| {
        env.place_bid_ix(view, &bidder.pubkey(), 999, key, hint, deposit, None).0
    };
    // Terms other than the auction's.
    for view in [
        AuctionInfo { end_time: a.end_time + 1, ..a },
        AuctionInfo { supply: a.supply - 1, ..a },
        AuctionInfo { price_unit: 10, ..a },
        AuctionInfo { min_price: a.min_price - 1, ..a },
        AuctionInfo { min_deposit: a.min_deposit - 1, ..a },
        AuctionInfo { max_per_bid: 1, ..a },
    ] {
        let ix = bad(&env, &view, key, hint, min_deposit);
        env.expect_error(&[ix], &bidder, &[], "TermsMismatch");
    }
    let ix = bad(&env, &a, key, hint, min_deposit - 1);
    env.expect_error(&[ix], &bidder, &[], "DepositTooSmall");
    // A point on the twist (u = 2), with its own correct hint.
    let mut twist = [0u8; 32];
    twist[0] = 2;
    let ix = bad(&env, &a, twist, edwards_y(&twist), min_deposit);
    env.expect_error(&[ix], &bidder, &[], "InvalidEncryptionKey");
    // A point on the curve but outside the prime-order subgroup.
    let honest = ED25519_BASEPOINT_POINT * Scalar::from_bytes_mod_order([5u8; 32]);
    let mixed = (honest + EIGHT_TORSION[1]).to_montgomery().to_bytes();
    let ix = bad(&env, &a, mixed, edwards_y(&mixed), min_deposit);
    env.expect_error(&[ix], &bidder, &[], "InvalidEncryptionKey");
    // The base point, and a real key with a wrong hint.
    let mut nine = [0u8; 32];
    nine[0] = 9;
    let ix = bad(&env, &a, nine, edwards_y(&nine), min_deposit);
    env.expect_error(&[ix], &bidder, &[], "InvalidEncryptionKey");
    let mut wrong = hint;
    wrong[0] ^= 1;
    let ix = bad(&env, &a, key, wrong, min_deposit);
    env.expect_error(&[ix], &bidder, &[], "InvalidEncryptionKey");

    // -- Fill every slot ---------------------------------------------------
    // Deposits 3_000 + i, so index 0 holds the smallest.
    let mut bids = Vec::new();
    let mut total = 0;
    for i in 0..MAX_BIDS {
        let key = honest_key(i);
        let deposit = 3_000 + i;
        let (ix, bid) = env.place_bid_ix(&a, &bidder.pubkey(), i, key, edwards_y(&key), deposit, None);
        env.send(&[ix], &bidder, &[]).unwrap_or_else(|e| panic!("bid {i}: {e:?}"));
        bids.push((bid, bidder.pubkey(), deposit));
        total += deposit;
    }
    assert_eq!(env.book_deposit(&a, 0), 3_000);
    assert_eq!(env.book_deposit(&a, 255), 3_255);
    assert_eq!(env.read_u64(&a.auction, "Auction", "total_deposited"), total);

    // -- Eviction ----------------------------------------------------------
    let key = honest_key(10_000);
    let hint = edwards_y(&key);
    let rival_bid = |env: &Env, seed: u64, deposit: u64, evicted: Option<(Address, Address)>| {
        env.place_bid_ix(&a, &rival.pubkey(), seed, key, hint, deposit, evicted).0
    };
    // Full: a plain bid is refused.
    let ix = rival_bid(&env, 1, 10_000, None);
    env.expect_error(&[ix], &rival, &[], "TooManyBids");
    // Only the smallest deposit can be replaced...
    let ix = rival_bid(&env, 1, 10_000, Some((bids[1].0, bidder.pubkey())));
    env.expect_error(&[ix], &rival, &[], "NotSmallestBid");
    // ...funds can only go to its owner...
    let ix = rival_bid(&env, 1, 10_000, Some((bids[0].0, rival.pubkey())));
    env.expect_error(&[ix], &rival, &[], "Unauthorized");
    // ...and the new deposit must be 10% larger (3_000 -> 3_300).
    let ix = rival_bid(&env, 1, 3_299, Some((bids[0].0, bidder.pubkey())));
    env.expect_error(&[ix], &rival, &[], "DepositTooSmall");

    let evicted_lamports = env.balance(&bids[0].0);
    let bidder_before = env.balance(&bidder.pubkey());
    let (ix, rival_bid_address) =
        env.place_bid_ix(&a, &rival.pubkey(), 1, key, hint, 3_300, Some((bids[0].0, bidder.pubkey())));
    env.send(&[ix], &rival, &[]).expect("evict");
    assert!(!env.exists(&bids[0].0), "evicted bid closed");
    assert_eq!(env.balance(&bidder.pubkey()) - bidder_before, evicted_lamports);
    assert!(evicted_lamports > 3_000, "deposit and rent returned");
    assert_eq!(env.book_deposit(&a, 0), 3_300);
    // The replaced deposit leaves the total, the new one joins it.
    assert_eq!(env.read_u64(&a.auction, "Auction", "total_deposited"), total - 3_000 + 3_300);
    assert_eq!(env.read_u32(&rival_bid_address, "Bid", "index"), 0);
    assert_eq!(env.read_u32(&a.auction, "Auction", "bid_count"), 256);
    bids[0] = (rival_bid_address, rival.pubkey(), 3_300);
    // The next smallest is now index 1 (3_001); index 0 is no longer it.
    let ix = rival_bid(&env, 2, 4_000, Some((rival_bid_address, rival.pubkey())));
    env.expect_error(&[ix], &rival, &[], "NotSmallestBid");

    // -- After the deadline ------------------------------------------------
    env.set_time(a.end_time + 1);
    let ix = rival_bid(&env, 3, 10_000, Some((bids[1].0, bidder.pubkey())));
    env.expect_error(&[ix], &rival, &[], "BiddingClosed");
    let ix = env.seller_ix("claim_proceeds", &a);
    env.expect_error(&[ix], &seller, &[], "NotSettled");
    let ix = env.bid_ix("emergency_refund", &a, bids[5].0, bidder.pubkey());
    env.expect_error(&[ix], &rival, &[], "TooEarly");
    let ix = env.bid_ix("close_bid", &a, bids[5].0, bidder.pubkey());
    env.expect_error(&[ix], &rival, &[], "NotSettled");
    let ix = env.seller_ix("close_auction", &a);
    env.expect_error(&[ix], &seller, &[], "WrongStatus");
    let ix = env.seller_ix("cancel_auction", &a);
    env.expect_error(&[ix], &seller, &[], "HasBids");

    // -- Safety net: MPC never ran ----------------------------------------
    env.set_time(a.end_time + EMERGENCY_DELAY_SECS);
    let treasury_before = env.balance(&env.treasury.pubkey());
    let ix = env.seller_ix("claim_proceeds", &a);
    env.send(&[ix], &seller, &[]).expect("claim proceeds");
    assert!(!env.exists(&a.vault), "vault closed: nothing owed");
    assert_eq!(env.token_amount(&ata(&seller.pubkey(), &mint)), 1_000);
    assert_eq!(env.balance(&env.treasury.pubkey()), treasury_before, "no proceeds, no fee");

    let ix = env.seller_ix("close_auction", &a);
    env.expect_error(&[ix], &seller, &[], "BidsOutstanding");

    // Anyone can return a stuck deposit, but only to its owner.
    let ix = env.bid_ix("emergency_refund", &a, bids[5].0, rival.pubkey());
    env.expect_error(&[ix], &rival, &[], "Unauthorized");
    for (bid, owner, deposit) in bids.iter() {
        let held = env.balance(bid);
        assert!(held > *deposit);
        let before = env.balance(owner);
        let ix = env.bid_ix("emergency_refund", &a, *bid, *owner);
        env.send(&[ix], &rival, &[]).expect("emergency refund");
        // `rival` pays the fee; when it is also the owner, it shows up here.
        let fee = if *owner == rival.pubkey() { TX_FEE } else { 0 };
        assert_eq!(env.balance(owner) + fee - before, held);
        assert!(!env.exists(bid));
    }

    // -- Closing returns the remaining rent to the seller -------------------
    let held = env.balance(&a.auction) + env.balance(&a.book);
    let before = env.balance(&seller.pubkey());
    let ix = env.seller_ix("close_auction", &a);
    env.send(&[ix], &seller, &[]).expect("close auction");
    assert_eq!(env.balance(&seller.pubkey()) + TX_FEE - before, held);
    assert!(!env.exists(&a.auction) && !env.exists(&a.book));
    println!("most compute units used by one transaction: {}", env.max_compute_units);
}

#[test]
fn a_filled_token_sale_charges_every_winner_the_clearing_price() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let mint = env.fixed_supply_mint(&seller, 1_000);
    // 100 tokens, at least 1_000 lamports each; budgets of at least 10_000.
    let terms = TokenTerms {
        min_price: 1_000,
        min_deposit: 10_000,
        ..TOKEN_TERMS
    };
    let a = env.create_auction(&seller, 11, mint, terms);

    // Each bid is a budget (its deposit) and, sealed, the highest price per
    // token it accepts: A 120_000 up to 5_000, B 60_000 up to 4_000,
    // D 200_000 up to 3_000, E 30_000 up to 2_000.
    let budgets = [120_000u64, 60_000, 200_000, 30_000];
    let bidders: Vec<Keypair> = (0..4).map(|_| env.funded(1)).collect();
    let bids: Vec<Address> = (0..4).map(|i| env.bid(&a, &bidders[i], 20 + i as u64, budgets[i])).collect();
    assert_eq!(env.read_u64(&a.auction, "Auction", "total_deposited"), 410_000);
    env.set_time(a.end_time + 1);

    // At 3_000 the budgets of A, B and D (380_000) would buy 126 tokens,
    // more than the 100 for sale; at any higher price A and B alone
    // (180_000) buy fewer than 100. So 3_000 clears, with D at it.
    env.simulate_clearing(&a, 3_000, true, 180_000, 200_000);
    // What `award_bid_callback` records: A and B buy all their budgets
    // afford at 3_000 (40 and 20 tokens), D gets the 40 left, E loses.
    let awards = [
        (OUTCOME_ABOVE, 40, 120_000),
        (OUTCOME_ABOVE, 20, 60_000),
        (OUTCOME_AT, 40, 120_000),
        (OUTCOME_NONE, 0, 0),
    ];
    for (bid, (outcome, won, payment)) in bids.iter().zip(awards) {
        env.simulate_award(&a, bid, outcome, won, payment);
    }
    assert_eq!(env.read_u64(&a.auction, "Auction", "sold"), 100);
    assert_eq!(env.read_u64(&a.auction, "Auction", "proceeds"), 300_000);

    let caller = env.funded(1);
    // E won nothing, and tokens only ever go to a bid's owner.
    let ix = env.claim_tokens_ix(&a, caller.pubkey(), bids[3], bidders[3].pubkey());
    env.expect_error(&[ix], &caller, &[], "NothingToClaim");
    let ix = env.claim_tokens_ix(&a, caller.pubkey(), bids[0], caller.pubkey());
    env.expect_error(&[ix], &caller, &[], "Unauthorized");
    // A winner's deposit stays until its tokens are delivered.
    let ix = env.bid_ix("close_bid", &a, bids[0], bidders[0].pubkey());
    env.expect_error(&[ix], &caller, &[], "TokensUnclaimed");

    // A and B collect, anyone can do it for them.
    for i in [0usize, 1] {
        let owner = bidders[i].pubkey();
        let ix = env.claim_tokens_ix(&a, caller.pubkey(), bids[i], owner);
        env.send(&[ix], &caller, &[]).expect("claim tokens");
        assert_eq!(env.token_amount(&ata(&owner, &mint)), awards[i].1);
    }
    let ix = env.claim_tokens_ix(&a, caller.pubkey(), bids[0], bidders[0].pubkey());
    env.expect_error(&[ix], &caller, &[], "AlreadyClaimed");

    // The seller is paid while D's tokens still wait in the vault: every
    // token was sold, so none come back.
    let fee = 300_000 / 100;
    let treasury_before = env.balance(&env.treasury.pubkey());
    let seller_before = env.balance(&seller.pubkey());
    env.send(&[env.seller_ix("claim_proceeds", &a)], &seller, &[]).expect("claim proceeds");
    assert_eq!(env.balance(&env.treasury.pubkey()) - treasury_before, fee);
    assert_eq!(env.balance(&seller.pubkey()) + TX_FEE - seller_before, 300_000 - fee);
    assert_eq!(env.token_amount(&ata(&seller.pubkey(), &mint)), 900);
    assert_eq!(env.token_amount(&a.vault), 40);
    let ix = env.seller_ix("claim_proceeds", &a);
    env.expect_error(&[ix], &seller, &[], "NotSettled");

    // D's claim empties the vault, which closes with its rent going to the
    // seller.
    let vault_rent = env.balance(&a.vault);
    let seller_before = env.balance(&seller.pubkey());
    let ix = env.claim_tokens_ix(&a, caller.pubkey(), bids[2], bidders[2].pubkey());
    env.send(&[ix], &caller, &[]).expect("claim tokens");
    assert_eq!(env.token_amount(&ata(&bidders[2].pubkey(), &mint)), 40);
    assert!(!env.exists(&a.vault));
    assert_eq!(env.balance(&seller.pubkey()) - seller_before, vault_rent);

    // Everyone gets back what they did not spend, and the account's rent.
    for (i, bid) in bids.iter().enumerate() {
        let owner = bidders[i].pubkey();
        assert_eq!(env.above_rent(bid), budgets[i] - awards[i].2);
        let held = env.balance(bid);
        let before = env.balance(&owner);
        env.send(&[env.bid_ix("close_bid", &a, *bid, owner)], &caller, &[]).expect("close bid");
        assert_eq!(env.balance(&owner) - before, held);
    }
    env.send(&[env.seller_ix("close_auction", &a)], &seller, &[]).expect("close auction");
    assert!(!env.exists(&a.auction) && !env.exists(&a.book));
}

#[test]
fn an_unfilled_token_sale_sells_at_the_minimum_price_and_returns_the_rest() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let mint = env.fixed_supply_mint(&seller, 100);
    let terms = TokenTerms {
        min_price: 1_500,
        min_deposit: 5_000,
        ..TOKEN_TERMS
    };
    let a = env.create_auction(&seller, 12, mint, terms);

    // A 30_000 up to 2_000, B 20_000 up to 1_600, C 10_000 at 1_000: below
    // the minimum price, so it counts as no bid.
    let budgets = [30_000u64, 20_000, 10_000];
    let bidders: Vec<Keypair> = (0..3).map(|_| env.funded(1)).collect();
    let bids: Vec<Address> = (0..3).map(|i| env.bid(&a, &bidders[i], 30 + i as u64, budgets[i])).collect();
    env.set_time(a.end_time + 1);

    // The valid budgets (50_000) buy only 33 tokens at the minimum price:
    // demand never covers the supply, so every valid bid wins at 1_500.
    env.simulate_clearing(&a, 1_500, false, 50_000, 0);
    // A buys 20 tokens for 30_000; B 13 (13.3 rounded down) for 19_500.
    let awards = [(OUTCOME_ABOVE, 20, 30_000), (OUTCOME_ABOVE, 13, 19_500), (OUTCOME_NONE, 0, 0)];
    for (bid, (outcome, won, payment)) in bids.iter().zip(awards) {
        env.simulate_award(&a, bid, outcome, won, payment);
    }

    // The seller is paid first: the 67 unsold tokens come back, the 33 sold
    // stay for the winners.
    let proceeds = 49_500;
    let fee = proceeds / 100;
    let treasury_before = env.balance(&env.treasury.pubkey());
    let seller_before = env.balance(&seller.pubkey());
    env.send(&[env.seller_ix("claim_proceeds", &a)], &seller, &[]).expect("claim proceeds");
    assert_eq!(env.balance(&env.treasury.pubkey()) - treasury_before, fee);
    assert_eq!(env.balance(&seller.pubkey()) + TX_FEE - seller_before, proceeds - fee);
    assert_eq!(env.token_amount(&ata(&seller.pubkey(), &mint)), 67);
    assert_eq!(env.token_amount(&a.vault), 33);

    // The winners collect; the last claim closes the vault.
    let caller = env.funded(1);
    for i in 0..2 {
        let owner = bidders[i].pubkey();
        let ix = env.claim_tokens_ix(&a, caller.pubkey(), bids[i], owner);
        env.send(&[ix], &caller, &[]).expect("claim tokens");
        assert_eq!(env.token_amount(&ata(&owner, &mint)), awards[i].1);
    }
    assert!(!env.exists(&a.vault));

    // B gets back the 500 lamports its 13 tokens did not cost, C its whole
    // budget.
    for (i, bid) in bids.iter().enumerate() {
        let owner = bidders[i].pubkey();
        assert_eq!(env.above_rent(bid), budgets[i] - awards[i].2);
        let held = env.balance(bid);
        let before = env.balance(&owner);
        env.send(&[env.bid_ix("close_bid", &a, *bid, owner)], &caller, &[]).expect("close bid");
        assert_eq!(env.balance(&owner) - before, held);
    }
    env.send(&[env.seller_ix("close_auction", &a)], &seller, &[]).expect("close auction");
    assert!(!env.exists(&a.auction) && !env.exists(&a.book));
}

#[test]
fn closing_a_cancelled_auction_sweeps_tokens_sent_to_its_vault() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let donor = env.funded(10);
    let mint = env.fixed_supply_mint(&seller, 1_000);
    let a = env.create_auction(&seller, 7, mint, TOKEN_TERMS);

    let ix = env.seller_ix("cancel_auction", &a);
    env.send(&[ix], &seller, &[]).expect("cancel");
    assert!(!env.exists(&a.vault));
    let seller_ata = ata(&seller.pubkey(), &mint);
    assert_eq!(env.token_amount(&seller_ata), 1_000);

    // Someone re-creates the vault and sends tokens to it.
    let donor_ata = ata(&donor.pubkey(), &mint);
    let mut transfer = vec![12u8]; // TransferChecked
    transfer.extend_from_slice(&40u64.to_le_bytes());
    transfer.push(0);
    let ixs = [
        create_ata_ix(&donor.pubkey(), &donor.pubkey(), &mint),
        create_ata_ix(&donor.pubkey(), &a.auction, &mint),
    ];
    env.send(&ixs, &donor, &[]).expect("create accounts");
    let mut give = vec![12u8];
    give.extend_from_slice(&100u64.to_le_bytes());
    give.push(0);
    let ix = Instruction::new_with_bytes(
        TOKEN_PROGRAM,
        &give,
        vec![w(seller_ata), r(mint), w(donor_ata), signer(seller.pubkey())],
    );
    env.send(&[ix], &seller, &[]).expect("fund donor");
    let ix = Instruction::new_with_bytes(
        TOKEN_PROGRAM,
        &transfer,
        vec![w(donor_ata), r(mint), w(a.vault), signer(donor.pubkey())],
    );
    env.send(&[ix], &donor, &[]).expect("donate");
    assert_eq!(env.token_amount(&a.vault), 40);

    // A stranger cannot close it.
    let mut stranger_ix = env.seller_ix("close_auction", &a);
    stranger_ix.accounts[0] = signer(donor.pubkey());
    stranger_ix.accounts[5] = w(ata(&donor.pubkey(), &mint));
    env.expect_error(&[stranger_ix], &donor, &[], "Unauthorized");

    let ix = env.seller_ix("close_auction", &a);
    env.send(&[ix], &seller, &[]).expect("close auction");
    assert_eq!(env.token_amount(&seller_ata), 900 + 40);
    assert!(!env.exists(&a.vault) && !env.exists(&a.auction) && !env.exists(&a.book));
}

#[test]
fn fees_are_capped_paid_to_the_treasury_and_fixed_per_auction() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let stranger = env.funded(5);
    let treasury = env.treasury.pubkey();

    // Only the admin, only within the caps, only to a funded wallet.
    let ix = env.set_fees_ix(&stranger.pubkey(), 0, 0, treasury);
    env.expect_error(&[ix], &stranger, &[], "Unauthorized");
    let ix = env.set_fees_ix(&admin.pubkey(), 500_000_001, 100, treasury);
    env.expect_error(&[ix], &admin, &[], "FeeTooHigh");
    let ix = env.set_fees_ix(&admin.pubkey(), LISTING_FEE, 501, treasury);
    env.expect_error(&[ix], &admin, &[], "FeeTooHigh");
    let empty = Keypair::new();
    let ix = env.set_fees_ix(&admin.pubkey(), LISTING_FEE, SALE_FEE_BPS, empty.pubkey());
    env.expect_error(&[ix], &admin, &[], "InvalidTreasury");
    let mint_owner = env.funded(5);
    let token = env.fixed_supply_mint(&mint_owner, 10);
    let ix = env.set_fees_ix(&admin.pubkey(), LISTING_FEE, SALE_FEE_BPS, token);
    env.expect_error(&[ix], &admin, &[], "InvalidTreasury");

    // Opening pays the listing fee to the treasury...
    let seller = env.funded(10);
    let mint = env.fixed_supply_mint(&seller, 1_000);
    let before = env.balance(&treasury);
    let a = env.create_auction(&seller, 1, mint, TOKEN_TERMS);
    assert_eq!(env.balance(&treasury) - before, LISTING_FEE);
    let fee_at = env.idl.offset("Auction", "sale_fee_bps");
    assert_eq!(env.data(&a.auction)[fee_at..fee_at + 2], SALE_FEE_BPS.to_le_bytes());

    // ...but only if the seller accepted at least the current fees.
    let (ix, _) = env.create_auction_ix(&seller.pubkey(), 2, mint, TOKEN_TERMS, (LISTING_FEE - 1, SALE_FEE_BPS));
    env.expect_error(&[ix], &seller, &[], "FeesChanged");
    let (ix, _) = env.create_auction_ix(&seller.pubkey(), 2, mint, TOKEN_TERMS, (LISTING_FEE, SALE_FEE_BPS - 1));
    env.expect_error(&[ix], &seller, &[], "FeesChanged");
    // The fee goes only to the configured treasury.
    let (mut ix, _) = env.create_auction_ix(&seller.pubkey(), 2, mint, TOKEN_TERMS, (LISTING_FEE, SALE_FEE_BPS));
    ix.accounts[7] = w(stranger.pubkey());
    env.expect_error(&[ix], &seller, &[], "InvalidTreasury");

    // A fee change applies to new auctions only, and a seller who accepted
    // the old fees is not charged a higher one.
    let ix = env.set_fees_ix(&admin.pubkey(), 0, 250, treasury);
    env.send(&[ix], &admin, &[]).expect("change fees");
    let (ix, _) = env.create_auction_ix(&seller.pubkey(), 3, mint, TOKEN_TERMS, (LISTING_FEE, SALE_FEE_BPS));
    env.expect_error(&[ix], &seller, &[], "FeesChanged");
    let before = env.balance(&treasury);
    let (ix, b) = env.create_auction_ix(&seller.pubkey(), 3, mint, TOKEN_TERMS, (0, 250));
    env.send(&[ix], &seller, &[]).expect("create auction");
    assert_eq!(env.balance(&treasury), before, "no listing fee");
    assert_eq!(env.data(&b.auction)[fee_at..fee_at + 2], 250u16.to_le_bytes());
    assert_eq!(env.data(&a.auction)[fee_at..fee_at + 2], SALE_FEE_BPS.to_le_bytes());

    // Featuring and hiding are the admin's call.
    let listing_at = env.idl.offset("Auction", "featured");
    assert_eq!(env.idl.offset("Auction", "hidden"), listing_at + 1);
    let ix = env.set_listing_ix(&stranger.pubkey(), &a.auction, true, false);
    env.expect_error(&[ix], &stranger, &[], "Unauthorized");
    let ix = env.set_listing_ix(&admin.pubkey(), &a.auction, true, false);
    env.send(&[ix], &admin, &[]).expect("feature");
    assert_eq!(env.data(&a.auction)[listing_at..listing_at + 2], [1, 0]);
    let ix = env.set_listing_ix(&admin.pubkey(), &a.auction, false, true);
    env.send(&[ix], &admin, &[]).expect("hide");
    assert_eq!(env.data(&a.auction)[listing_at..listing_at + 2], [0, 1]);

    // Claiming proceeds pays the fee only to the auction's own treasury.
    env.set_time(a.end_time + EMERGENCY_DELAY_SECS);
    let mut ix = env.seller_ix("claim_proceeds", &a);
    ix.accounts[2] = w(stranger.pubkey());
    env.expect_error(&[ix], &seller, &[], "InvalidTreasury");
}

#[test]
fn collection_auctions_mint_on_claim_and_hand_the_collection_to_the_seller() {
    let mut env = Env::new();
    let seller = env.funded(10);
    // Six NFTs, at least 900 ticks (0.0009 SOL) each, at most five per bid.
    let terms = NftTerms {
        supply: 6,
        min_price: 900,
        max_per_bid: 5,
        duration_secs: DURATION_SECS,
    };

    // Someone sends lamports to the collection's address first; opening
    // still works and they go to the seller.
    let (ix, a) = env.create_collection_ix(&seller.pubkey(), 1, terms, &CATS);
    let griefer = env.funded(1);
    let gift = solana_system_interface::instruction::transfer(&griefer.pubkey(), &a.mint, 1_000_000);
    env.send(&[gift], &griefer, &[]).expect("prefund collection");
    let treasury_before = env.balance(&env.treasury.pubkey());
    env.send(&[ix], &seller, &[]).expect("create collection auction");
    assert_eq!(env.balance(&env.treasury.pubkey()) - treasury_before, LISTING_FEE);
    let collection = env.svm.get_account(&a.mint).unwrap();
    assert_eq!(collection.owner, MPL_CORE);
    let (authority, name, uri, minted, _) = read_collection(&collection.data);
    assert_eq!((authority, name.as_str(), uri.as_str(), minted), (a.auction, CATS.name, CATS.uri, 0));
    env.assert_terms(&a);

    // Collection-only instructions refuse a token auction.
    let mint = env.fixed_supply_mint(&seller, 10);
    let t = env.create_auction(&seller, 2, mint, TokenTerms { supply: 10, ..TOKEN_TERMS });
    let ix = env.collection_seller_ix("cancel_collection_auction", &t);
    env.expect_error(&[ix], &seller, &[], "WrongAuctionKind");

    // Alice asks for 5 NFTs at up to 1_000 ticks each and deposits exactly
    // that; Bob asks for 3 at up to 900 and deposits more than he needs, to
    // hide his bid.
    let alice = env.funded(1);
    let bob = env.funded(1);
    let carol = env.funded(1);
    let alice_deposit = 5 * 1_000 * NFT_PRICE_SCALE;
    let bob_deposit = 3_000_000;
    let alice_bid = env.bid(&a, &alice, 1, alice_deposit);
    let bob_bid = env.bid(&a, &bob, 2, bob_deposit);
    env.set_time(a.end_time + 1);
    // Above 900 only Alice's 5 are wanted; at 900, 8 for 6 NFTs: 900 clears
    // and Bob gets the one NFT left.
    env.simulate_clearing(&a, 900, true, 5, 3);
    let price = 900 * NFT_PRICE_SCALE;
    env.simulate_award(&a, &alice_bid, OUTCOME_ABOVE, 5, 5 * price);
    env.simulate_at_clearing(&a, &bob_bid, 3);

    // Bob has to be finalized before he can claim.
    let ix = env.claim_nfts_ix(&a, bob.pubkey(), bob_bid, bob.pubkey(), &[asset_address(&a.auction, 5)]);
    env.expect_error(&[ix], &bob, &[], "NotSettled");
    env.send(&[env.finalize_ix(&a, bob_bid)], &carol, &[]).expect("finalize");
    assert_eq!(env.bid_u64(&bob_bid, "won"), 1);
    assert_eq!(env.bid_u64(&bob_bid, "payment"), price);

    // Alice settled first and holds places 0-4, Bob place 5. Nothing can be
    // minted before the seed that shuffles them is drawn.
    assert_eq!(env.read_u32(&alice_bid, "Bid", "first_position"), 0);
    assert_eq!(env.read_u32(&bob_bid, "Bid", "first_position"), 5);
    assert_eq!(env.assigned_positions(&a.auction), 6);
    let assets: Vec<Address> = (0..6).map(|i| asset_address(&a.auction, i)).collect();
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets[..1]);
    env.expect_error(&[ix], &alice, &[], "NftsNotShuffled");
    let seed = 0x5eed_0000_1111_2222_3333_4444_5555_6666u128;
    env.simulate_draw(&a, seed);

    // NFTs are minted place by place, only to the winner, at most five at a
    // time; each place becomes the NFT the shuffle gives it.
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &[assets[1]]);
    env.expect_error(&[ix], &alice, &[], "WrongAssetAccounts");
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets);
    env.expect_error(&[ix], &alice, &[], "WrongAssetAccounts");
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, bob.pubkey(), &assets[..1]);
    env.expect_error(&[ix], &alice, &[], "Unauthorized");
    // Lamports sent to the next NFT's address cannot block the claim; the
    // payer gets them.
    let gift = solana_system_interface::instruction::transfer(&griefer.pubkey(), &assets[0], 1_000_000);
    env.send(&[gift], &griefer, &[]).expect("prefund asset");
    let before = env.balance(&alice.pubkey());
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets[..3]);
    let units = env.send_with_limit(&[ix], &alice, &[], 400_000).expect("claim three");
    println!("claiming 3 NFTs: {units} compute units");
    // The payer got the prefunded lamports back and paid for the NFTs.
    let held: u64 = assets[..3].iter().map(|x| env.balance(x)).sum();
    let paid = before + 1_000_000 - env.balance(&alice.pubkey()) - TX_FEE;
    println!("3 NFTs cost the payer {paid} lamports, {held} of them held by the NFT accounts");
    assert!(paid >= held && held > 0);
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets[3..5]);
    env.send_with_limit(&[ix], &alice, &[], 400_000).expect("claim two");
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets[5..6]);
    env.expect_error(&[ix], &alice, &[], "AlreadyClaimed");
    // Anyone can mint Bob's NFT for him.
    let ix = env.claim_nfts_ix(&a, carol.pubkey(), bob_bid, bob.pubkey(), &assets[5..6]);
    env.send_with_limit(&[ix], &carol, &[], 400_000).expect("claim for bob");

    let mut numbers = Vec::new();
    for (i, asset) in assets.iter().enumerate() {
        let account = env.svm.get_account(asset).unwrap();
        assert_eq!(account.owner, MPL_CORE);
        let (owner, collection, name, uri) = read_asset(&account.data);
        assert_eq!(owner, if i < 5 { alice.pubkey() } else { bob.pubkey() });
        assert_eq!(collection, a.mint);
        let item = shuffled_item(i as u32, 6, seed);
        assert_eq!(name, format!("Veiling Cat #{}", item + 1));
        assert_eq!(uri, format!("https://example.com/cats/{item}.json"));
        numbers.push(item);
    }
    // Every NFT went to someone, in an order the seed chose.
    assert_ne!(numbers, (0..6).collect::<Vec<u32>>());
    numbers.sort_unstable();
    assert_eq!(numbers, (0..6).collect::<Vec<u32>>());
    let (_, _, _, minted, size) = read_collection(&env.data(&a.mint));
    assert_eq!((minted, size), (6, 6));

    // Bids close with what they did not spend, the seller is paid less 1%,
    // and closing hands over the collection.
    for (bid, owner, unspent) in [
        (alice_bid, alice.pubkey(), alice_deposit - 5 * price),
        (bob_bid, bob.pubkey(), bob_deposit - price),
    ] {
        assert_eq!(env.above_rent(&bid), unspent);
        let held = env.balance(&bid);
        let before = env.balance(&owner);
        env.send(&[env.bid_ix("close_bid", &a, bid, owner)], &carol, &[]).expect("close bid");
        assert_eq!(env.balance(&owner) - before, held);
    }
    let proceeds = 6 * price;
    let fee = proceeds / 100;
    let treasury_before = env.balance(&env.treasury.pubkey());
    let seller_before = env.balance(&seller.pubkey());
    let ix = env.collection_seller_ix("claim_collection_proceeds", &a);
    env.send(&[ix], &seller, &[]).expect("claim proceeds");
    assert_eq!(env.balance(&env.treasury.pubkey()) - treasury_before, fee);
    assert_eq!(env.balance(&seller.pubkey()) + TX_FEE - seller_before, proceeds - fee);
    let ix = env.collection_seller_ix("close_collection_auction", &a);
    env.send(&[ix], &seller, &[]).expect("close collection auction");
    let (authority, _, _, _, _) = read_collection(&env.data(&a.mint));
    assert_eq!(authority, seller.pubkey());
    assert!(!env.exists(&a.auction) && !env.exists(&a.book));
    println!("most compute units used by one transaction: {}", env.max_compute_units);
}

#[test]
fn bids_at_the_clearing_price_share_every_nft() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let terms = NftTerms {
        supply: 10,
        min_price: 1_000,
        max_per_bid: 5,
        duration_secs: DURATION_SECS,
    };
    let a = env.create_collection(&seller, 9, terms);
    let bidders: Vec<Keypair> = (0..4).map(|_| env.funded(1)).collect();
    // Enough for five NFTs at up to 2_000 ticks each.
    let deposit = 5 * 2_000 * NFT_PRICE_SCALE;
    let bids: Vec<Address> = (0..4).map(|i| env.bid(&a, &bidders[i], 100 + i as u64, deposit)).collect();
    assert_eq!(env.read_u64(&a.auction, "Auction", "total_deposited"), 4 * deposit);
    env.set_time(a.end_time + 1);

    // Clearing at 1_500 ticks: bid 0 wants 3 NFTs above it, bids 1-3 want
    // 5 each at it, so 7 NFTs are left to share there.
    env.simulate_clearing(&a, 1_500, true, 3, 15);
    let price = 1_500 * NFT_PRICE_SCALE;
    env.simulate_award(&a, &bids[0], OUTCOME_ABOVE, 3, 3 * price);
    env.simulate_at_clearing(&a, &bids[1], 5);
    env.simulate_at_clearing(&a, &bids[2], 5);

    // Bid 3 is still sealed, so nothing can be split yet.
    env.expect_error(&[env.finalize_ix(&a, bids[1])], &bidders[0], &[], "SharesNotReady");
    env.expect_error(&[env.finalize_ix(&a, bids[0])], &bidders[0], &[], "NotAtClearing");
    assert_eq!(env.read_u64(&a.auction, "Auction", "sold"), 3);
    env.simulate_at_clearing(&a, &bids[3], 5);
    assert_eq!(env.read_u64(&a.auction, "Auction", "sold"), 10);

    // A share that can be finalized cannot be refunded instead, even once
    // the safety net is open.
    let ix = env.bid_ix("emergency_refund", &a, bids[2], bidders[2].pubkey());
    env.expect_error(&[ix], &bidders[0], &[], "TooEarly");
    env.set_time(a.end_time + EMERGENCY_DELAY_SECS);
    let ix = env.bid_ix("emergency_refund", &a, bids[2], bidders[2].pubkey());
    env.expect_error(&[ix], &bidders[0], &[], "ShareReady");

    // 7 * 5 / 15 = 2.33 each; the earliest bid gets the leftover NFT. Any
    // order and any caller.
    let caller = env.funded(1);
    for &i in &[3usize, 1, 2] {
        env.send(&[env.finalize_ix(&a, bids[i])], &caller, &[]).expect("finalize");
    }
    env.expect_error(&[env.finalize_ix(&a, bids[1])], &caller, &[], "NotAtClearing");
    let won: Vec<u64> = bids.iter().map(|b| env.bid_u64(b, "won")).collect();
    assert_eq!(won, vec![3, 3, 2, 2]);
    for (bid, nfts) in bids.iter().zip(&won) {
        assert_eq!(env.bid_u64(bid, "payment"), nfts * price);
    }
    assert_eq!(env.read_u64(&a.auction, "Auction", "proceeds"), 10 * price);
    assert_eq!(env.read_u32(&a.auction, "Auction", "resolved_count"), 4);

    // Places follow settlement order: bid 0, then the shares in the order
    // they were finalized (3, 1, 2).
    let first: Vec<u32> = bids.iter().map(|b| env.read_u32(b, "Bid", "first_position")).collect();
    assert_eq!(first, vec![0, 5, 8, 3]);
    assert_eq!(env.assigned_positions(&a.auction), 10);

    // The seed was never drawn and the safety net is open, so each place is
    // its own NFT number: winners can still collect their NFTs, and the rest
    // of their deposits.
    for (i, bid) in bids.iter().enumerate() {
        let owner = bidders[i].pubkey();
        let count = won[i] as u32;
        let places: Vec<u32> = (first[i]..first[i] + count).collect();
        let assets: Vec<Address> = places.iter().map(|&k| asset_address(&a.auction, k)).collect();
        let ix = env.claim_nfts_ix(&a, caller.pubkey(), *bid, owner, &assets);
        env.send_with_limit(&[ix], &caller, &[], 400_000).expect("claim nfts");
        for (asset, place) in assets.iter().zip(&places) {
            let (nft_owner, _, name, _) = read_asset(&env.data(asset));
            assert_eq!(nft_owner, owner);
            assert!(name.ends_with(&format!(" #{}", place + 1)), "{name}");
        }
        assert_eq!(env.above_rent(bid), deposit - won[i] * price);
        let held = env.balance(bid);
        let before = env.balance(&owner);
        env.send(&[env.bid_ix("close_bid", &a, *bid, owner)], &caller, &[]).expect("close bid");
        assert_eq!(env.balance(&owner) - before, held);
    }

    // The seller gets the proceeds less 1%, the treasury the 1%.
    let fee = 10 * price / 100;
    let treasury_before = env.balance(&env.treasury.pubkey());
    let seller_before = env.balance(&seller.pubkey());
    let ix = env.collection_seller_ix("claim_collection_proceeds", &a);
    env.send(&[ix], &seller, &[]).expect("claim proceeds");
    assert_eq!(env.balance(&env.treasury.pubkey()) - treasury_before, fee);
    assert_eq!(env.balance(&seller.pubkey()) + TX_FEE - seller_before, 10 * price - fee);
    let ix = env.collection_seller_ix("close_collection_auction", &a);
    env.send(&[ix], &seller, &[]).expect("close collection auction");
    let (authority, _, _, minted, _) = read_collection(&env.data(&a.mint));
    assert_eq!((authority, minted), (seller.pubkey(), 10));
    assert!(!env.exists(&a.auction) && !env.exists(&a.book));
}

#[test]
fn bids_at_the_clearing_price_are_refunded_if_one_never_reveals() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let terms = NftTerms {
        supply: 10,
        min_price: 1_000,
        max_per_bid: 5,
        duration_secs: DURATION_SECS,
    };
    let a = env.create_collection(&seller, 9, terms);
    let bidders: Vec<Keypair> = (0..2).map(|_| env.funded(1)).collect();
    let deposit = 5 * 1_000 * NFT_PRICE_SCALE;
    let bids: Vec<Address> = (0..2).map(|i| env.bid(&a, &bidders[i], i as u64, deposit)).collect();
    env.set_time(a.end_time + 1);

    // Both bids sit at the clearing price; only the first was ever revealed.
    env.simulate_clearing(&a, 1_000, true, 0, 10);
    env.simulate_at_clearing(&a, &bids[0], 5);
    env.set_time(a.end_time + EMERGENCY_DELAY_SECS);
    env.expect_error(&[env.finalize_ix(&a, bids[0])], &bidders[0], &[], "SharesNotReady");

    // Both get their whole deposit back; nothing was sold.
    for (i, bid) in bids.iter().enumerate() {
        let held = env.balance(bid);
        let owner = bidders[i].pubkey();
        let before = env.balance(&owner);
        env.send(&[env.bid_ix("emergency_refund", &a, *bid, owner)], &seller, &[]).expect("refund");
        assert_eq!(env.balance(&owner) - before, held);
    }
    let treasury_before = env.balance(&env.treasury.pubkey());
    let ix = env.collection_seller_ix("claim_collection_proceeds", &a);
    env.send(&[ix], &seller, &[]).expect("claim proceeds");
    assert_eq!(env.balance(&env.treasury.pubkey()), treasury_before, "no proceeds, no fee");
    let ix = env.collection_seller_ix("close_collection_auction", &a);
    env.send(&[ix], &seller, &[]).expect("close collection auction");
    let (authority, _, _, minted, _) = read_collection(&env.data(&a.mint));
    assert_eq!((authority, minted), (seller.pubkey(), 0));
}

#[test]
fn a_cancelled_collection_auction_returns_the_empty_collection() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let stranger = env.funded(1);
    let terms = NftTerms {
        supply: 100,
        min_price: 1_000,
        max_per_bid: 10,
        duration_secs: DURATION_SECS,
    };
    let plain = CollectionTerms {
        uri_per_item: false,
        royalty_bps: 0,
        item_uri: "ar://single-metadata",
        ..CATS
    };
    let (ix, a) = env.create_collection_ix(&seller.pubkey(), 5, terms, &plain);
    env.send(&[ix], &seller, &[]).expect("create");
    let name_at = env.idl.offset("Auction", "item_name");
    let (item_name, at) = read_string(&env.data(&a.auction), name_at);
    let (item_uri, _) = read_string(&env.data(&a.auction), at);
    assert_eq!((item_name.as_str(), item_uri.as_str()), ("Veiling Cat", "ar://single-metadata"));

    // Not before it is cancelled, and only by the seller.
    let ix = env.collection_seller_ix("close_collection_auction", &a);
    env.expect_error(&[ix], &seller, &[], "WrongStatus");
    let mut ix = env.collection_seller_ix("cancel_collection_auction", &a);
    ix.accounts[0] = signer(stranger.pubkey());
    env.expect_error(&[ix], &stranger, &[], "Unauthorized");
    let ixs = [
        env.collection_seller_ix("cancel_collection_auction", &a),
        env.collection_seller_ix("close_collection_auction", &a),
    ];
    let held = env.balance(&a.auction) + env.balance(&a.book);
    let before = env.balance(&seller.pubkey());
    env.send(&ixs, &seller, &[]).expect("cancel and close");
    assert_eq!(env.balance(&seller.pubkey()) + TX_FEE - before, held);
    let (authority, _, _, minted, _) = read_collection(&env.data(&a.mint));
    assert_eq!((authority, minted), (seller.pubkey(), 0));
}

#[test]
fn a_token_auction_can_be_cancelled_and_closed_in_one_transaction() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let mint = env.fixed_supply_mint(&seller, 1_000);
    let a = env.create_auction(&seller, 3, mint, TOKEN_TERMS);
    let held = env.balance(&a.auction) + env.balance(&a.book) + env.balance(&a.vault);
    let before = env.balance(&seller.pubkey());
    let ixs = [env.seller_ix("cancel_auction", &a), env.seller_ix("close_auction", &a)];
    env.send(&ixs, &seller, &[]).expect("cancel and close");
    assert_eq!(env.balance(&seller.pubkey()) + TX_FEE - before, held);
    assert_eq!(env.token_amount(&ata(&seller.pubkey(), &mint)), 1_000);
    assert!(!env.exists(&a.auction) && !env.exists(&a.book) && !env.exists(&a.vault));
}

#[test]
fn collections_named_per_item_mint_every_edition_under_its_item_name() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let stranger = env.funded(1);
    let terms = NftTerms {
        supply: 6,
        min_price: 1_000,
        max_per_bid: 5,
        duration_secs: DURATION_SECS,
    };
    let tiles = CollectionTerms {
        name: "Veiling Tiles",
        uri: "https://example.com/tiles/collection.json",
        item_name: "Veiling Tile",
        item_uri: "https://example.com/tiles/",
        ..CATS
    };

    // The seller starts the list at the address the auction will have, then
    // fills it.
    let seed = 7u64;
    let auction = pda(&[b"auction", seller.pubkey().as_ref(), &seed.to_le_bytes()]);
    let list = item_list_address(&auction);
    env.send(&[env.init_item_list_ix(&seller.pubkey(), seed)], &seller, &[]).expect("init item list");
    assert_eq!(env.data(&list).len(), ITEM_LIST_HEADER_LEN);

    // Each item needs a visible name of at most 24 bytes and at least one
    // NFT, and a list adds up to at most 10,000 NFTs.
    let long = "x".repeat(25);
    let invalid: [Vec<(&str, u32)>; 7] = [
        vec![],
        vec![("", 1)],
        vec![("   ", 1)],
        vec![("Lale", 0)],
        vec![(long.as_str(), 1)],
        vec![("Lale\u{202e}", 1)],
        vec![("Lale", 10_001)],
    ];
    for items in &invalid {
        let ix = env.add_items_ix(&seller.pubkey(), list, items);
        env.expect_error(&[ix], &seller, &[], "InvalidItems");
    }
    let ix = env.add_items_ix(&stranger.pubkey(), list, &TILES);
    env.expect_error(&[ix], &stranger, &[], "Unauthorized");

    // A list holds at most 500 items. One that no auction uses can be
    // closed by its seller.
    let spare_auction = pda(&[b"auction", seller.pubkey().as_ref(), &8u64.to_le_bytes()]);
    let spare = item_list_address(&spare_auction);
    env.send(&[env.init_item_list_ix(&seller.pubkey(), 8)], &seller, &[]).expect("init spare list");
    let names: Vec<String> = (1..=500).map(|i| format!("Item {i}")).collect();
    for chunk in names.chunks(50) {
        let items: Vec<(&str, u32)> = chunk.iter().map(|name| (name.as_str(), 1)).collect();
        env.send(&[env.add_items_ix(&seller.pubkey(), spare, &items)], &seller, &[]).expect("add 50 items");
    }
    assert_eq!(env.data(&spare).len(), ITEM_LIST_HEADER_LEN + 500 * ITEM_ENTRY_LEN);
    let ix = env.add_items_ix(&seller.pubkey(), spare, &[("Item 501", 1)]);
    env.expect_error(&[ix], &seller, &[], "TooManyItems");
    env.expect_error(&[env.close_item_list_ix(&stranger.pubkey(), spare)], &stranger, &[], "Unauthorized");

    // The auction only opens with a list that adds up to its supply.
    env.send(&[env.add_items_ix(&seller.pubkey(), list, &TILES[..2])], &seller, &[]).expect("add items");
    let (ix, _) = env.create_collection_ix_with(&seller.pubkey(), seed, terms, &tiles, Some(list));
    env.expect_error(&[ix], &seller, &[], "ItemListMismatch");
    env.send(&[env.add_items_ix(&seller.pubkey(), list, &TILES[2..])], &seller, &[]).expect("add items");
    assert_eq!(env.data(&list).len(), ITEM_LIST_HEADER_LEN + 3 * ITEM_ENTRY_LEN);
    assert_eq!(env.read_u32(&list, "ItemList", "count"), 3);
    assert_eq!(env.read_u32(&list, "ItemList", "total"), 6);
    let (ix, _) =
        env.create_collection_ix_with(&seller.pubkey(), seed, NftTerms { supply: 7, ..terms }, &tiles, Some(list));
    env.expect_error(&[ix], &seller, &[], "ItemListMismatch");
    // Names per item need a metadata file per NFT.
    let shared = CollectionTerms { uri_per_item: false, ..tiles };
    let (ix, _) = env.create_collection_ix_with(&seller.pubkey(), seed, terms, &shared, Some(list));
    env.expect_error(&[ix], &seller, &[], "InvalidCollectionTerms");
    // Another auction's list does not fit.
    let (ix, _) = env.create_collection_ix_with(&seller.pubkey(), seed, terms, &tiles, Some(spare));
    env.expect_error(&[ix], &seller, &[], "ConstraintSeeds");

    let (ix, a) = env.create_collection_ix_with(&seller.pubkey(), seed, terms, &tiles, Some(list));
    env.send(&[ix], &seller, &[]).expect("create collection auction");
    assert!(env.auction_flag(&a.auction, "named_items"));
    assert!(!env.auction_flag(&a.auction, "unrevealed"));
    // Sealed: the list can no longer change, nor close on its own.
    assert_eq!(env.read(&list, "ItemList", "sealed", 1), [1]);
    let ix = env.add_items_ix(&seller.pubkey(), list, &[("Ekstra", 1)]);
    env.expect_error(&[ix], &seller, &[], "ItemListSealed");
    env.expect_error(&[env.close_item_list_ix(&seller.pubkey(), list)], &seller, &[], "ItemListSealed");

    // Alice wants 4 NFTs above 1_000 ticks and Bob 2 at it: all six sell at
    // 1_000.
    let alice = env.funded(1);
    let bob = env.funded(1);
    let price = 1_000 * NFT_PRICE_SCALE;
    let alice_bid = env.bid(&a, &alice, 1, 4 * 2 * price);
    let bob_bid = env.bid(&a, &bob, 2, 2 * price);
    env.set_time(a.end_time + 1);
    env.simulate_clearing(&a, 1_000, true, 4, 2);
    env.simulate_award(&a, &alice_bid, OUTCOME_ABOVE, 4, 4 * price);
    env.simulate_at_clearing(&a, &bob_bid, 2);
    env.send(&[env.finalize_ix(&a, bob_bid)], &stranger, &[]).expect("finalize");
    assert_eq!(env.bid_u64(&bob_bid, "won"), 2);
    let shuffle = 0x7469_6c65_7300_0000_0000_0000_0000_0042u128;
    env.simulate_draw(&a, shuffle);

    // Claims read the names from the list, so they must pass it: this
    // auction's own.
    let assets: Vec<Address> = (0..6).map(|i| asset_address(&a.auction, i)).collect();
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets[..1]);
    env.expect_error(&[ix], &alice, &[], "ItemListMismatch");
    let ix = env.claim_named_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets[..1], Some(spare));
    env.expect_error(&[ix], &alice, &[], "ConstraintSeeds");
    let ix = env.claim_named_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets[..4], Some(list));
    let units = env.send_with_limit(&[ix], &alice, &[], 400_000).expect("claim four");
    println!("claiming 4 NFTs named per item: {units} compute units");
    let ix = env.claim_named_nfts_ix(&a, stranger.pubkey(), bob_bid, bob.pubkey(), &assets[4..], Some(list));
    env.send_with_limit(&[ix], &stranger, &[], 400_000).expect("claim for bob");

    // NFT numbers 0-2 are the three editions of the first item, 3 is the
    // only Lale, so it carries no number, and 4-5 are the two Çini.
    let mut by_item = vec![String::new(); 6];
    for (place, asset) in assets.iter().enumerate() {
        let (owner, collection, name, uri) = read_asset(&env.data(asset));
        assert_eq!(owner, if place < 4 { alice.pubkey() } else { bob.pubkey() });
        assert_eq!(collection, a.mint);
        let item = shuffled_item(place as u32, 6, shuffle);
        assert_eq!(uri, format!("https://example.com/tiles/{item}.json"));
        by_item[item as usize] = name;
    }
    assert_eq!(by_item, ["Gün Batımı #1", "Gün Batımı #2", "Gün Batımı #3", "Lale", "Çini #1", "Çini #2"]);

    // The list closes with the auction, and the auction only with its list.
    for (bid, owner) in [(alice_bid, alice.pubkey()), (bob_bid, bob.pubkey())] {
        env.send(&[env.bid_ix("close_bid", &a, bid, owner)], &stranger, &[]).expect("close bid");
    }
    let ix = env.collection_seller_ix("claim_collection_proceeds", &a);
    env.send(&[ix], &seller, &[]).expect("claim proceeds");
    let ix = env.collection_seller_ix("close_collection_auction", &a);
    env.expect_error(&[ix], &seller, &[], "ItemListMismatch");
    let held = env.balance(&a.auction) + env.balance(&a.book) + env.balance(&list);
    let before = env.balance(&seller.pubkey());
    let ix = env.collection_seller_ix_with("close_collection_auction", &a, Some(list));
    env.send(&[ix], &seller, &[]).expect("close collection auction");
    assert_eq!(env.balance(&seller.pubkey()) + TX_FEE - before, held);
    assert!(!env.exists(&a.auction) && !env.exists(&list));
    let (authority, _, _, minted, _) = read_collection(&env.data(&a.mint));
    assert_eq!((authority, minted), (seller.pubkey(), 6));

    let held = env.balance(&spare);
    let before = env.balance(&seller.pubkey());
    env.send(&[env.close_item_list_ix(&seller.pubkey(), spare)], &seller, &[]).expect("close spare list");
    assert_eq!(env.balance(&seller.pubkey()) + TX_FEE - before, held);
    assert!(!env.exists(&spare));
}

#[test]
fn hidden_collections_open_their_nfts_only_once_revealed() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let stranger = env.funded(1);
    let terms = NftTerms {
        supply: 4,
        min_price: 1_000,
        max_per_bid: 4,
        duration_secs: DURATION_SECS,
    };
    // The address of the metadata is fixed when the auction opens; the
    // files need not be there before the reveal.
    let hidden = CollectionTerms {
        item_uri: "https://arweave.net/committed-manifest/",
        hidden: true,
        ..CATS
    };
    let one_file = CollectionTerms { uri_per_item: false, ..hidden };
    let (ix, _) = env.create_collection_ix(&seller.pubkey(), 3, terms, &one_file);
    env.expect_error(&[ix], &seller, &[], "InvalidCollectionTerms");
    let (ix, a) = env.create_collection_ix(&seller.pubkey(), 3, terms, &hidden);
    env.send(&[ix], &seller, &[]).expect("create hidden collection auction");
    assert!(env.auction_flag(&a.auction, "unrevealed"));
    assert!(!env.auction_flag(&a.auction, "named_items"));
    env.expect_error(&[env.reveal_ix(&a)], &seller, &[], "BiddingOpen");

    // Alice wants all four at the minimum price.
    let alice = env.funded(1);
    let price = 1_000 * NFT_PRICE_SCALE;
    let alice_bid = env.bid(&a, &alice, 1, 4 * price);
    env.set_time(a.end_time + 1);
    env.simulate_clearing(&a, 1_000, true, 0, 4);
    env.simulate_at_clearing(&a, &alice_bid, 4);
    env.send(&[env.finalize_ix(&a, alice_bid)], &stranger, &[]).expect("finalize");
    let shuffle = 0x6869_6464_656e_0000_0000_0000_0000_0007u128;
    env.simulate_draw(&a, shuffle);

    // Until the seller reveals, nothing can be minted and the seller is not
    // paid; while the seller still has time, Alice cannot take her payment
    // back either.
    let assets: Vec<Address> = (0..4).map(|i| asset_address(&a.auction, i)).collect();
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets);
    env.expect_error(&[ix], &alice, &[], "NotRevealed");
    let ix = env.collection_seller_ix("claim_collection_proceeds", &a);
    env.expect_error(&[ix], &seller, &[], "NotRevealed");
    env.expect_error(&[env.refund_unrevealed_ix(&a, alice_bid)], &stranger, &[], "TooEarly");

    // Only the seller reveals, up to the last second, and only once.
    let mut ix = env.reveal_ix(&a);
    ix.accounts[0] = AccountMeta::new_readonly(stranger.pubkey(), true);
    env.expect_error(&[ix], &stranger, &[], "Unauthorized");
    env.set_time(a.end_time + REVEAL_DELAY_SECS - 1);
    env.send(&[env.reveal_ix(&a)], &seller, &[]).expect("reveal");
    assert!(!env.auction_flag(&a.auction, "unrevealed"));
    env.expect_error(&[env.reveal_ix(&a)], &seller, &[], "AlreadyRevealed");
    env.expect_error(&[env.refund_unrevealed_ix(&a, alice_bid)], &stranger, &[], "AlreadyRevealed");

    // The NFTs point at the committed address.
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets);
    env.send_with_limit(&[ix], &alice, &[], 400_000).expect("claim");
    for (place, asset) in assets.iter().enumerate() {
        let (owner, _, name, uri) = read_asset(&env.data(asset));
        let item = shuffled_item(place as u32, 4, shuffle);
        assert_eq!(owner, alice.pubkey());
        assert_eq!(name, format!("Veiling Cat #{}", item + 1));
        assert_eq!(uri, format!("https://arweave.net/committed-manifest/{item}.json"));
    }
    env.send(&[env.bid_ix("close_bid", &a, alice_bid, alice.pubkey())], &stranger, &[]).expect("close bid");
    let fee = 4 * price / 100;
    let before = env.balance(&seller.pubkey());
    let ix = env.collection_seller_ix("claim_collection_proceeds", &a);
    env.send(&[ix], &seller, &[]).expect("claim proceeds");
    assert_eq!(env.balance(&seller.pubkey()) + TX_FEE - before, 4 * price - fee);
    let ix = env.collection_seller_ix("close_collection_auction", &a);
    env.send(&[ix], &seller, &[]).expect("close collection auction");

    // A hidden auction withdrawn before any bid closes without a reveal.
    let (ix, b) = env.create_collection_ix(&seller.pubkey(), 4, terms, &hidden);
    env.send(&[ix], &seller, &[]).expect("create");
    env.send(&[env.collection_seller_ix("cancel_collection_auction", &b)], &seller, &[]).expect("cancel");
    env.set_time(b.end_time + 1);
    env.expect_error(&[env.reveal_ix(&b)], &seller, &[], "WrongStatus");
    env.send(&[env.collection_seller_ix("close_collection_auction", &b)], &seller, &[]).expect("close");
    assert!(!env.exists(&b.auction));

    // So does one that sold nothing: there is nothing to reveal.
    let (ix, c) = env.create_collection_ix(&seller.pubkey(), 5, terms, &hidden);
    env.send(&[ix], &seller, &[]).expect("create");
    env.set_time(c.end_time + 1);
    let ix = env.collection_seller_ix("claim_collection_proceeds", &c);
    env.send(&[ix], &seller, &[]).expect("finish without sales");
    env.send(&[env.collection_seller_ix("close_collection_auction", &c)], &seller, &[]).expect("close");
    assert!(!env.exists(&c.auction));
}

#[test]
fn unrevealed_collections_give_winners_their_payments_back() {
    let mut env = Env::new();
    let seller = env.funded(10);
    let caller = env.funded(1);
    let terms = NftTerms {
        supply: 4,
        min_price: 1_000,
        max_per_bid: 4,
        duration_secs: DURATION_SECS,
    };
    let hidden = CollectionTerms {
        item_uri: "https://arweave.net/never-published/",
        hidden: true,
        ..CATS
    };
    let (ix, a) = env.create_collection_ix(&seller.pubkey(), 3, terms, &hidden);
    env.send(&[ix], &seller, &[]).expect("create hidden collection auction");

    // Alice wants 3 NFTs above 1_200 ticks and Bob one at it.
    let alice = env.funded(1);
    let bob = env.funded(1);
    let alice_deposit = 3 * 1_500 * NFT_PRICE_SCALE;
    let bob_deposit = 2_000_000;
    let alice_bid = env.bid(&a, &alice, 1, alice_deposit);
    let bob_bid = env.bid(&a, &bob, 2, bob_deposit);
    env.set_time(a.end_time + 1);
    env.simulate_clearing(&a, 1_200, true, 3, 1);
    let price = 1_200 * NFT_PRICE_SCALE;
    env.simulate_award(&a, &alice_bid, OUTCOME_ABOVE, 3, 3 * price);
    env.simulate_at_clearing(&a, &bob_bid, 1);

    // The seller lets the time to reveal run out.
    env.set_time(a.end_time + REVEAL_DELAY_SECS);
    env.expect_error(&[env.reveal_ix(&a)], &seller, &[], "RevealClosed");
    let assets = [asset_address(&a.auction, 0)];
    let ix = env.claim_nfts_ix(&a, alice.pubkey(), alice_bid, alice.pubkey(), &assets);
    env.expect_error(&[ix], &alice, &[], "NotRevealed");
    // Payments go back once every bid is settled, Bob's share included.
    env.expect_error(&[env.refund_unrevealed_ix(&a, alice_bid)], &caller, &[], "NotSettled");
    env.send(&[env.finalize_ix(&a, bob_bid)], &caller, &[]).expect("finalize");
    assert_eq!(env.bid_u64(&bob_bid, "won"), 1);
    // The seller is not paid for NFTs nobody can have.
    let ix = env.collection_seller_ix("claim_collection_proceeds", &a);
    env.expect_error(&[ix], &seller, &[], "NotRevealed");

    // Anyone can give a winner the payment back, once; closing the bid then
    // returns the whole deposit.
    for (bid, owner, deposit) in [(alice_bid, alice.pubkey(), alice_deposit), (bob_bid, bob.pubkey(), bob_deposit)] {
        env.send(&[env.refund_unrevealed_ix(&a, bid)], &caller, &[]).expect("refund");
        env.expect_error(&[env.refund_unrevealed_ix(&a, bid)], &caller, &[], "NothingToClaim");
        assert_eq!(env.above_rent(&bid), deposit);
        let held = env.balance(&bid);
        let before = env.balance(&owner);
        env.send(&[env.bid_ix("close_bid", &a, bid, owner)], &caller, &[]).expect("close bid");
        assert_eq!(env.balance(&owner) - before, held);
    }
    assert_eq!(env.read_u64(&a.auction, "Auction", "proceeds"), 0);
    assert_eq!(env.read_u64(&a.auction, "Auction", "sold"), 0);

    // Nothing to pay and no fee; the seller gets the empty collection back.
    let treasury_before = env.balance(&env.treasury.pubkey());
    let ix = env.collection_seller_ix("claim_collection_proceeds", &a);
    env.send(&[ix], &seller, &[]).expect("finish");
    assert_eq!(env.balance(&env.treasury.pubkey()), treasury_before);
    let ix = env.collection_seller_ix("close_collection_auction", &a);
    env.send(&[ix], &seller, &[]).expect("close collection auction");
    let (authority, _, _, minted, _) = read_collection(&env.data(&a.mint));
    assert_eq!((authority, minted), (seller.pubkey(), 0));
}
