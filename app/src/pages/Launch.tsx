import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey, type Transaction } from "@solana/web3.js";
import type { BN } from "@anchor-lang/core";
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  FEATURE_CONTACT,
  FREE_UPLOAD_ITEM_BYTES,
  FREE_UPLOAD_TOTAL_BYTES,
  MAX_COLLECTION_NAME_LEN,
  MAX_COLLECTION_SIZE,
  MAX_IMAGE_BYTES,
  MAX_ITEM_NAME_LEN,
  MAX_ITEMS,
  MAX_PAGES,
  MAX_PRICE_TICKS,
  MAX_ROYALTY_BPS,
  MAX_UPLOADED_ITEMS,
  MAX_URI_LEN,
  NFT_MINT_COST_LAMPORTS,
  NFT_PRICE_SCALE,
  PAGE_BIDS,
  REVEAL_DELAY_SECS,
  MAX_START_DELAY_SECS,
  ANTI_SNIPER_FEE_BPS,
  ANTI_SNIPER_MINUTES,
  DAMM_PROTOCOL_FEE_PERCENT,
  LP_RENT_DEPOSIT,
  MAX_LP_BPS,
  MIN_LP_BPS,
  POOL_FEE_TIERS,
  SELLER_POOL_FEE_BPS,
} from "../config";
import { DemandChart } from "../components/DemandChart";
import { ImagePicker, ImageSetPicker, isSmallImage, useImageUrl } from "../components/ImagePicker";
import {
  type ChosenSheet,
  type Details,
  type DraftItem,
  type Kind,
  DetailsFields,
  ItemsEditor,
  KindChooser,
  MAX_DESCRIPTION_LEN,
  NftPreview,
  SheetPicker,
  emptyDetails,
  isLinkOrEmpty,
  traitsOf,
} from "../components/LaunchParts";
import { type StorageOption, StorageChoice } from "../components/StorageChoice";
import { Button, Notice, useAction, useLoader, useMetadataImage, useNow } from "../components/ui";
import {
  buildCreateAuction,
  type LiquidityTerms,
  buildCreateCollectionAuction,
  buildCreateToken,
  buildItemList,
} from "../lib/actions";
import { UploadError, freeTarget, paidTarget } from "../lib/arweave";
import {
  type TokenInfo,
  auctionAddress,
  bidCrankFee,
  connection,
  fetchAuction,
  fetchCrankRewards,
  fetchFeeConfig,
  fetchItemList,
  fetchTokenInfo,
  formatPercent,
  poolSol,
  randomU64,
  sellerCrankFee,
} from "../lib/chain";
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatSol,
  formatTokens,
  nowSecs,
  parseDecimal,
  parseSol,
  plural,
} from "../lib/format";
import { type PreparedImage, formatKb } from "../lib/images";
import { type ListedItem, itemBatches, numberedName } from "../lib/items";
import {
  choosePriceUnit,
  formatDecimal,
  nftPrice,
  nftPriceToTicks,
  parseAmount,
  roundUpSignificant,
  sameDecimal,
  tokenPrice,
} from "../lib/price";
import { revealKey } from "../lib/sealed";
import { creditFor, ensureCredit, fetchStorageRates, quoteStorage, walletSignature, walletUploadKey } from "../lib/storage";
import { sendTransaction, sendTransactions } from "../lib/tx";
import {
  type CollectionUpload,
  type NftFile,
  type Quality,
  type SealOptions,
  collectionUploadSizes,
  uploadCollection,
  uploadTokenMetadata,
} from "../lib/uploads";
import { byteLength, isDisplayText, isMetadataUri } from "../lib/validate";
import { useWallet } from "../lib/wallet";

const DURATIONS: { label: string; secs: number }[] = [
  { label: "10 min", secs: 600 },
  { label: "1 hour", secs: 3_600 },
  { label: "6 hours", secs: 21_600 },
  { label: "1 day", secs: 86_400 },
  { label: "3 days", secs: 259_200 },
  { label: "7 days", secs: 604_800 },
];

/** A scheduled start must be at least this far ahead, so it is still ahead when the auction lands. */
const MIN_START_LEAD_SECS = 5 * 60;
/** Room left under the program's limit for the time a launch takes. */
const START_LIMIT_MARGIN_SECS = 60 * 60;

/** `"YYYY-MM-DDTHH:mm"` in local time, as a `datetime-local` input takes it. */
function toLocalInput(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Unix seconds of a `datetime-local` value, read as local time; null if it is not one. */
function fromLocalInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** What is wrong with a scheduled start, if anything. */
function startProblem(startAt: string | null, now: number): string | null {
  if (startAt === null) return null;
  const start = fromLocalInput(startAt);
  if (start === null) return "Pick the date and time bidding opens.";
  if (start < now + MIN_START_LEAD_SECS) return "Schedule bidding at least 5 minutes ahead, or let it open right away.";
  if (start > now + MAX_START_DELAY_SECS - START_LIMIT_MARGIN_SECS) return "Bidding can open at most 30 days ahead.";
  return null;
}

/** The next full hour, an hour from now: the first time offered for a scheduled start. */
const suggestedStart = (now: number) => Math.ceil((now + 3_600) / 3_600) * 3_600;

/** When bidding opens and for how long it runs, with what that means in plain dates. */
function BiddingWindow({
  startAt,
  onStartAt,
  duration,
  onDuration,
  children,
}: {
  startAt: string | null;
  onStartAt: (value: string | null) => void;
  duration: number;
  onDuration: (secs: number) => void;
  children?: ReactNode;
}) {
  const now = useNow(15_000);
  const start = startAt === null ? null : fromLocalInput(startAt);
  const problem = startProblem(startAt, now);
  const durationLabel = DURATIONS.find((d) => d.secs === duration)?.label ?? formatDuration(duration);
  return (
    <fieldset className="group">
      <legend className="group__title">Bidding</legend>
      <div className="field">
        <span className="field__label" id="opens-label">
          Opens
        </span>
        <Segmented
          label="When bidding opens"
          value={startAt === null ? "now" : "later"}
          options={[
            ["now", "Right away"],
            ["later", "At a set time"],
          ]}
          onChange={(v) => onStartAt(v === "now" ? null : toLocalInput(suggestedStart(nowSecs())))}
        />
      </div>
      {startAt !== null ? (
        <div className="field">
          <label htmlFor="start-at">Date and time (your local time)</label>
          <input
            id="start-at"
            type="datetime-local"
            className="field__datetime"
            value={startAt}
            min={toLocalInput(now + MIN_START_LEAD_SECS)}
            max={toLocalInput(now + MAX_START_DELAY_SECS - START_LIMIT_MARGIN_SECS)}
            onChange={(e) => onStartAt(e.target.value)}
            aria-invalid={problem ? true : undefined}
            aria-describedby="window-hint"
          />
        </div>
      ) : null}
      <div className="field">
        <span className="field__label">Runs for</span>
        <Segmented
          label="How long bidding runs"
          value={String(duration)}
          options={DURATIONS.map((d) => [String(d.secs), d.label] as [string, string])}
          onChange={(v) => onDuration(Number(v))}
        />
      </div>
      <p id="window-hint" className="hint">
        {startAt === null
          ? `Bidding opens as soon as the auction is created and runs for ${durationLabel}.`
          : problem
          ? problem
          : `Bidding opens ${formatDateTime(start!)}, in ${formatDuration(start! - now)}, and closes ${formatDateTime(
              start! + duration
            )}. The auction is listed as upcoming until then, and you can cancel it until the first bid.`}
      </p>
      {children}
    </fieldset>
  );
}

/**
 * How many bids the auction makes room for: 256 per page of its bid book, up
 * to 1,024. Once they are all taken, a new bid must out-deposit the smallest.
 */
/** Room for bids: it grows on its own, so the seller chooses nothing. */
function BidRoom() {
  return (
    <div className="field">
      <span className="field__label">Room for bids</span>
      <p className="hint">
        Up to {formatCount(MAX_PAGES * PAGE_BIDS)} bids, at no cost to you up front. The auction starts with room for{" "}
        {formatCount(PAGE_BIDS)}; each time that fills, the next bid opens room for {formatCount(PAGE_BIDS)} more, paid
        for out of the settlement fund the bids themselves fill. Only if more than {formatCount(PAGE_BIDS)} bids come
        does the extra room, and finding the price across it, cost anything: it is taken from the proceeds, and the
        room's rent comes back when you close the auction. Once {formatCount(MAX_PAGES * PAGE_BIDS)} bids are in,
        larger deposits replace the smallest.
      </p>
    </div>
  );
}

const U64_MAX = (1n << 64n) - 1n;
/**
 * The smallest default for the smallest bid: 0.1 SOL. The seller can set any
 * lower amount; the default keeps throwaway bids from taking places.
 */
const MIN_SUGGESTED_DEPOSIT = 100_000_000n;
/** Rent-exempt lamports per byte of account data, with the 128 bytes every account carries. */
const RENT_PER_BYTE = 6_960n;
/** An item list's size: its header, then one entry per item (see `ItemList`). */
const itemListRent = (items: number) => (128n + 82n + 29n * BigInt(items)) * RENT_PER_BYTE;

type TokenSource = "new" | "existing";
/** Whether the app uploads the art and metadata, or the seller links to files they host. */
type Files = "upload" | "link";
/** A drop's NFTs each have their own image, or all show the same one. */
type DropArt = "unique" | "same";

/** Why the first of these images that cannot be stored as its original cannot be. */
function originalProblem(images: PreparedImage[]): string {
  for (const image of images) if (!image.original.ok) return `${image.name} ${image.original.problem}`;
  return "An image cannot be kept as it is";
}

/** The longest start of `text` that fits in `max` UTF-8 bytes. */
function fitBytes(text: string, max: number): string {
  let out = "";
  for (const ch of text.trim()) {
    if (byteLength(out + ch) > max) break;
    out += ch;
  }
  return out.trim();
}

function Segmented<T extends string>({
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
          key={v}
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

/** What the collection will look like on its sale page, as far as it is filled in. */
function CollectionCard({
  details,
  linkedArt,
  count,
  hidden,
  preview,
}: {
  details: Details;
  linkedArt: string | null;
  count: number;
  hidden: boolean;
  preview: PreparedImage | null;
}) {
  const logo = useImageUrl(details.logo);
  const banner = useImageUrl(details.banner);
  const veil = useImageUrl(preview);
  const art = logo ?? linkedArt;
  if (!art && !banner && !details.name.trim()) return null;
  return (
    <figure className="cardpreview" aria-label="How the collection will show">
      <div className="cardpreview__banner">{banner ? <img src={banner} alt="" /> : null}</div>
      <div className="cardpreview__body">
        {art ? <img className={`cardpreview__logo${isSmallImage(details.logo) ? " launch__art--pixels" : ""}`} src={art} alt="" referrerPolicy="no-referrer" /> : null}
        <figcaption>
          <span className="cardpreview__name">{details.name.trim() || "Collection name"}</span>
          <span className="cardpreview__meta">
            {count > 0 ? plural(count, "NFT") : "NFTs"}
            {hidden ? " · art hidden until the sale ends" : ""}
          </span>
        </figcaption>
        {hidden && veil ? <img className="cardpreview__veil" src={veil} alt="Shown until the reveal" /> : null}
      </div>
    </figure>
  );
}

/** A collection's NFTs as planned: their files, how many are sold, and the item list naming them, if any. */
type NftPlan = {
  /** Every NFT's file (`perNft`), or the one all of them share. */
  files: NftFile[];
  perNft: boolean;
  count: number;
  /** The item list, when NFTs are named per item. */
  listed: ListedItem[] | null;
  /** The NFT name on chain: names NFTs `"{name} #n"` unless they are named per item. */
  baseName: string;
  problems: string[];
  /** Notes that do not stop a launch. */
  notes: string[];
};

export function Launch() {
  const { signer, publicKey } = useWallet();
  const action = useAction();
  const fees = useLoader(fetchFeeConfig, []);
  const crank = useLoader(fetchCrankRewards, []);
  const [kind, setKind] = useState<Kind>("drop");
  const [source, setSource] = useState<TokenSource>("new");

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [tokenFiles, setTokenFiles] = useState<Files>("upload");
  const [tokenImage, setTokenImage] = useState<PreparedImage | null>(null);
  const [tokenDescription, setTokenDescription] = useState("");
  const [uri, setUri] = useState("");
  const [supply, setSupply] = useState("1000000");
  const [decimals, setDecimals] = useState("6");

  const [mintInput, setMintInput] = useState("");
  const [existing, setExisting] = useState<TokenInfo | null>(null);
  const [existingBalance, setExistingBalance] = useState<bigint | null>(null);
  const [existingError, setExistingError] = useState<string | null>(null);

  // Drops and collections share their details.
  const [details, setDetails] = useState<Details>(emptyDetails);
  const [royalty, setRoyalty] = useState("5");
  // Drops.
  const [dropFiles, setDropFiles] = useState<Files>("upload");
  const [dropArt, setDropArt] = useState<DropArt>("unique");
  const [sameUsesLogo, setSameUsesLogo] = useState(true);
  const [itemImage, setItemImage] = useState<PreparedImage | null>(null);
  const [itemImages, setItemImages] = useState<PreparedImage[]>([]);
  const [sheet, setSheet] = useState<ChosenSheet | null>(null);
  const [itemName, setItemName] = useState("");
  const [hiddenChoice, setHidden] = useState(false);
  const [preview, setPreview] = useState<PreparedImage | null>(null);
  const [collectionUri, setCollectionUri] = useState("");
  const [itemUri, setItemUri] = useState("");
  const [uriPerItem, setUriPerItem] = useState(true);
  // Collections built item by item.
  const [items, setItems] = useState<DraftItem[]>([]);

  const [forSale, setForSale] = useState("500000");
  const [nfts, setNfts] = useState("100");
  const [maxPerBidInput, setMaxPerBid] = useState<string | null>(null);
  const [minPriceInput, setMinPrice] = useState("0.0001");
  const [nftMinPriceInput, setNftMinPrice] = useState("0.1");
  const [minDepositInput, setMinDeposit] = useState<string | null>(null);
  const [duration, setDuration] = useState(DURATIONS[1].secs);
  /** Pages of the bid book: 256 bids each. */
  // Auto-liquidity: a Meteora pool at the clearing price (token sales only).
  const [lpOn, setLpOn] = useState(false);
  const [lpPercent, setLpPercent] = useState("30");
  const [lpFloor, setLpFloor] = useState("1");
  const [lpFee, setLpFee] = useState<number>(100);
  /** When bidding opens, as a `datetime-local` value; null for right away. */
  const [startAt, setStartAt] = useState<string | null>(null);
  const [step, setStepState] = useState<"form" | "key" | "pay" | "credit" | "upload" | "token" | "auction">("form");
  const [uploadProgress, setUploadProgress] = useState<[number, number] | null>(null);
  const [txProgress, setTxProgress] = useState<[number, number] | null>(null);
  const [quality, setQuality] = useState<Quality>("compressed");
  /** Set when Turbo says this connection's free allowance is spent. */
  const [freeUsedUp, setFreeUsedUp] = useState(false);
  /** The address a collection launch uses, kept across tries so sealed art and item lists are not made twice. */
  const seedRef = useRef<BN | null>(null);

  const collection = kind !== "token";
  const unit = collection ? "NFT" : "token";
  const linked = kind === "drop" && dropFiles === "link";
  const uploadingCollection = collection && !linked;
  const uploadingToken = !collection && source === "new" && tokenFiles === "upload";
  // Hiding the art needs one file per NFT: uploaded one image each, or a folder of files.
  const canHide = kind === "drop" && (linked ? uriPerItem : dropArt === "unique");
  const hidden = canHide && hiddenChoice;
  const rates = useLoader(() => (uploadingCollection ? fetchStorageRates() : Promise.resolve(null)), [uploadingCollection], 120_000);

  // The preview shows the chosen image, or the one a metadata link points to.
  const chosenArt = useImageUrl(uploadingToken ? tokenImage : null);
  const linkedArt = useMetadataImage(
    collection
      ? linked && isMetadataUri(collectionUri.trim(), MAX_URI_LEN)
        ? collectionUri.trim()
        : null
      : source === "new"
        ? tokenFiles === "link" && isMetadataUri(uri.trim(), MAX_URI_LEN)
          ? uri.trim()
          : null
        : existing?.uri ?? null
  );
  const tokenArt = chosenArt ?? linkedArt;

  const nftCount = Number.parseInt(nfts, 10);

  /** The NFTs the launch makes: names, images, traits, and how they are listed on chain. */
  const nftPlan = useMemo<NftPlan>(() => {
    const problems: string[] = [];
    const notes: string[] = [];
    const typedBase = itemName.trim();
    // Without "#n" names the base name is only a label, so the collection's name does.
    const fallbackBase = fitBytes(details.name, MAX_ITEM_NAME_LEN) || "NFT";
    const needBase = (base: string) => {
      if (!isDisplayText(base, MAX_ITEM_NAME_LEN)) problems.push(`Give the NFTs a name of up to ${MAX_ITEM_NAME_LEN} bytes.`);
    };

    if (kind === "collection") {
      const files: NftFile[] = [];
      for (const item of items) {
        for (let edition = 0; edition < item.editions; edition++) {
          files.push({
            name: item.editions === 1 ? item.name : numberedName(item.name, edition),
            description: item.description,
            externalUrl: item.externalUrl,
            attributes: traitsOf(item.traits),
            image: item.image,
          });
        }
      }
      if (items.length === 0) problems.push("Add at least one item.");
      if (items.length > MAX_ITEMS) problems.push(`A collection holds up to ${formatCount(MAX_ITEMS)} items.`);
      if (files.length > MAX_COLLECTION_SIZE) problems.push(`A collection holds up to ${formatCount(MAX_COLLECTION_SIZE)} NFTs in all.`);
      return {
        files,
        perNft: true,
        count: files.length,
        listed: items.map((item) => ({ name: item.name, supply: item.editions })),
        baseName: fallbackBase,
        problems,
        notes,
      };
    }

    if (linked || dropArt === "same") {
      needBase(typedBase);
      if (!Number.isInteger(nftCount) || nftCount < 1 || nftCount > MAX_COLLECTION_SIZE)
        problems.push(`NFTs for sale must be between 1 and ${formatCount(MAX_COLLECTION_SIZE)}.`);
      const image = sameUsesLogo ? details.logo : itemImage;
      if (!linked && !sameUsesLogo && !itemImage) problems.push("Choose the image every NFT shows.");
      return {
        files: !linked && image ? [{ name: typedBase, description: "", externalUrl: "", attributes: [], image }] : [],
        perNft: false,
        count: Number.isInteger(nftCount) && nftCount > 0 ? nftCount : 0,
        listed: null,
        baseName: typedBase,
        problems,
        notes,
      };
    }

    // One image per NFT, numbered in file-name order unless a sheet says
    // otherwise. A hidden drop is always numbered: names would show on chain
    // before the reveal.
    const rows = sheet?.sheet.rows ?? null;
    const named = Boolean(sheet?.sheet.hasNames) && !hidden;
    if (sheet?.sheet.hasNames && hidden) notes.push("Hidden drops are numbered, so the sheet's names are not used: they would show before the reveal.");
    if (!named) needBase(typedBase);
    const files: NftFile[] = [];
    if (itemImages.length === 0) problems.push("Choose the NFTs' images, one per NFT.");
    else if (!rows) {
      itemImages.forEach((image, n) =>
        files.push({ name: numberedName(typedBase, n), description: "", externalUrl: "", attributes: [], image })
      );
    } else {
      const byName = new Map(itemImages.map((image) => [image.name, image]));
      const byLowerName = new Map(itemImages.map((image) => [image.name.toLowerCase(), image]));
      const used = new Set<PreparedImage>();
      if (!sheet!.sheet.hasFiles && rows.length !== itemImages.length) {
        problems.push(
          `The sheet has ${plural(rows.length, "row")} but ${plural(itemImages.length, "image")} are chosen. Add a file_name column, or choose one image per row.`
        );
      }
      for (const [i, row] of rows.entries()) {
        const image = sheet!.sheet.hasFiles
          ? byName.get(row.fileName) ?? byLowerName.get(row.fileName.toLowerCase())
          : itemImages[i];
        if (!image) {
          if (sheet!.sheet.hasFiles) problems.push(`Line ${row.line} uses ${row.fileName}, which is not among the chosen images.`);
          continue;
        }
        used.add(image);
        if (named && !isDisplayText(row.name, MAX_ITEM_NAME_LEN)) {
          problems.push(`Line ${row.line}: names can be up to ${MAX_ITEM_NAME_LEN} bytes; "${row.name.slice(0, 30)}" is longer.`);
        }
        files.push({
          name: named ? row.name : numberedName(typedBase, row.number),
          description: row.description,
          externalUrl: row.externalUrl,
          attributes: row.traits,
          image,
        });
      }
      if (named && rows.length > MAX_ITEMS) {
        problems.push(
          `Names from the sheet work for drops of up to ${formatCount(MAX_ITEMS)} NFTs. Leave the name column empty to number them instead.`
        );
      }
      const unused = itemImages.length - used.size;
      if (sheet!.sheet.hasFiles && unused > 0) notes.push(`${plural(unused, "chosen image")} the sheet does not use will not be uploaded.`);
    }
    if (files.length > MAX_UPLOADED_ITEMS)
      problems.push(`One image per NFT can be uploaded for up to ${formatCount(MAX_UPLOADED_ITEMS)} NFTs.`);
    return {
      files,
      perNft: true,
      count: files.length,
      listed: named && rows ? rows.map((row) => ({ name: row.name, supply: 1 })) : null,
      baseName: named ? fallbackBase : typedBase,
      problems,
      notes,
    };
  }, [kind, items, linked, dropArt, nftCount, sameUsesLogo, details.logo, details.name, itemImage, itemImages, sheet, itemName, hidden]);

  /** The collection's files as they would be uploaded, once its images are chosen. */
  const collectionDraft = useMemo<CollectionUpload | null>(() => {
    if (!uploadingCollection || !details.logo || nftPlan.files.length === 0) return null;
    return {
      kind: kind === "collection" ? "collection" : "drop",
      name: details.name.trim(),
      description: details.description,
      image: details.logo,
      banner: details.banner,
      links: { website: details.website.trim(), x: details.x.trim() },
      nfts: nftPlan.files,
      perNft: nftPlan.perNft,
      hidden,
      preview: hidden ? preview : null,
    };
  }, [uploadingCollection, details, nftPlan, kind, hidden, preview]);

  /** The image the storage choice shows a detail of: the first NFT's. */
  const storageSample = collectionDraft ? collectionDraft.nfts[0]?.image ?? collectionDraft.image : null;
  const sampleLabel = collectionDraft?.perNft ? "the first NFT" : "the NFT image";

  /** What each way of storing the collection's files holds and costs. */
  const storage = useMemo<Record<Quality, StorageOption>>(() => {
    const option = (q: Quality): StorageOption => {
      if (!collectionDraft) return { bytes: null, free: false, quote: null, problem: null, sample: null };
      const freeSizes = collectionUploadSizes(collectionDraft, q, "free");
      const paidSizes = collectionUploadSizes(collectionDraft, q, "paid");
      if (!freeSizes || !paidSizes) {
        const { image, banner, preview: veil, nfts: files } = collectionDraft;
        const pictures = [image, ...(banner ? [banner] : []), ...(veil ? [veil] : []), ...files.map((f) => f.image)];
        return { bytes: null, free: false, quote: null, problem: originalProblem(pictures), sample: null };
      }
      const all = (sizes: { launch: number[]; reveal: number[] }) => [...sizes.launch, ...sizes.reveal];
      const total = (sizes: number[]) => sizes.reduce((sum, size) => sum + size, 0);
      const free =
        !freeUsedUp && all(freeSizes).every((size) => size <= FREE_UPLOAD_ITEM_BYTES) && total(all(freeSizes)) <= FREE_UPLOAD_TOTAL_BYTES;
      const picture = storageSample;
      return {
        bytes: total(all(free ? freeSizes : paidSizes)),
        free,
        quote: !free && rates.data ? quoteStorage(all(paidSizes), rates.data) : null,
        problem: null,
        sample: !picture
          ? null
          : q === "compressed"
            ? { width: picture.width, height: picture.height, bytes: picture.bytes.length }
            : picture.original.ok
              ? { width: picture.originalWidth, height: picture.originalHeight, bytes: picture.original.size }
              : null,
      };
    };
    return { compressed: option("compressed"), original: option("original") };
  }, [collectionDraft, storageSample, freeUsedUp, rates.data]);
  const chosenStorage = storage[quality];
  const payingForStorage = uploadingCollection && chosenStorage.bytes !== null && !chosenStorage.free;
  const tokenHasMetadata = uploadingToken ? Boolean(tokenImage || tokenDescription.trim()) : uri.trim() !== "";
  // Sealing a hidden drop's art needs a key made from a wallet signature.
  const needsSignature = (uploadingCollection && hidden) || payingForStorage;
  const listTxs = nftPlan.listed ? itemBatches(nftPlan.listed).length : 0;

  // Load an existing token as the user types its address.
  useEffect(() => {
    setExisting(null);
    setExistingBalance(null);
    setExistingError(null);
    if (kind !== "token" || source !== "existing" || mintInput.trim() === "") return;
    let mint: PublicKey;
    try {
      mint = new PublicKey(mintInput.trim());
    } catch {
      setExistingError("That is not a valid token address.");
      return;
    }
    let cancelled = false;
    fetchTokenInfo(mint)
      .then(async (info) => {
        if (cancelled) return;
        setExisting(info);
        if (publicKey) {
          const ata = getAssociatedTokenAddressSync(mint, publicKey, false, info.programId);
          const account = await getAccount(connection, ata, "confirmed", info.programId).catch(() => null);
          if (!cancelled) setExistingBalance(account ? account.amount : 0n);
        }
      })
      .catch(() => !cancelled && setExistingError("No token was found at that address."));
    return () => {
      cancelled = true;
    };
  }, [kind, source, mintInput, publicKey]);

  const tokenDecimals = source === "new" ? Number.parseInt(decimals, 10) : existing?.decimals ?? NaN;
  const saleCount = collection ? nftPlan.count : 0;
  const maxPerBid = maxPerBidInput ?? String(saleCount > 0 ? Math.min(10, saleCount) : 1);

  const plan = useMemo(() => {
    const problems: string[] = [];
    let sellAmount = 0n;
    let priceUnit = 1n;
    let minTicks = 0n;
    let minPriceShown: string | null = null;
    let rounded = false;
    let saleValue = 0n;

    if (collection) {
      if (!isDisplayText(details.name, MAX_COLLECTION_NAME_LEN))
        problems.push(`Give the collection a name of up to ${MAX_COLLECTION_NAME_LEN} bytes.`);
      if (linked) {
        if (!isMetadataUri(collectionUri.trim(), MAX_URI_LEN))
          problems.push("Add the collection's metadata link (https://, ipfs:// or ar://).");
        if (!isMetadataUri(itemUri.trim(), MAX_URI_LEN))
          problems.push(`Add the NFTs' metadata ${uriPerItem ? "folder" : "link"} (https://, ipfs:// or ar://).`);
      } else {
        if (!details.logo) problems.push("Choose the collection's logo.");
        if (details.description.length > MAX_DESCRIPTION_LEN)
          problems.push(`Keep the description to ${formatCount(MAX_DESCRIPTION_LEN)} characters.`);
        if (!isLinkOrEmpty(details.website) || !isLinkOrEmpty(details.x)) problems.push("Links must start with https://.");
      }
      problems.push(...nftPlan.problems);
      const perBid = Number.parseInt(maxPerBid, 10);
      if (!Number.isInteger(perBid) || perBid < 1 || (saleCount > 0 && perBid > saleCount) || perBid > 65_535)
        problems.push("The most NFTs per bid must be between 1 and the number for sale.");
      const typed = parseAmount(nftMinPriceInput);
      minTicks = typed ? nftPriceToTicks(typed, "up") : 0n;
      if (!typed || minTicks < 1n) problems.push("Enter a minimum price per NFT above zero.");
      else if (minTicks > MAX_PRICE_TICKS)
        problems.push(`The minimum price can be at most ${formatDecimal(nftPrice(MAX_PRICE_TICKS))} SOL per NFT.`);
      else {
        minPriceShown = formatDecimal(nftPrice(minTicks));
        rounded = nftPriceToTicks(typed, "down") !== minTicks;
      }
      sellAmount = BigInt(saleCount);
      saleValue = sellAmount * minTicks * NFT_PRICE_SCALE;

      if (uploadingCollection && chosenStorage.problem)
        problems.push(`${chosenStorage.problem}. Choose compressed storage, or another file.`);
      else if (payingForStorage && !chosenStorage.quote)
        problems.push(rates.error ? "Storage prices could not be loaded. Try again in a minute." : "Checking storage prices…");
      if (needsSignature && signer && !signer.signMessage) {
        problems.push(
          hidden
            ? "Your wallet cannot sign messages, which hiding the art needs. Use another wallet, or show the art."
            : "Your wallet cannot sign messages, which paid storage needs. Use another wallet, or free storage."
        );
      }
      const royaltyBps = Math.round(Number.parseFloat(royalty || "0") * 100);
      if (!Number.isFinite(royaltyBps) || royaltyBps < 0 || royaltyBps > MAX_ROYALTY_BPS)
        problems.push(`Creator earnings must be between 0 and ${MAX_ROYALTY_BPS / 100}%.`);
    } else {
      const d = tokenDecimals;
      if (!Number.isInteger(d) || d < 0 || d > 9) problems.push("Decimals must be between 0 and 9.");
      const amount = Number.isInteger(d) ? parseDecimal(forSale, d) : null;
      if (!amount || amount <= 0n || amount > U64_MAX) problems.push("Enter how many tokens are for sale.");
      sellAmount = amount && amount > 0n && amount <= U64_MAX ? amount : 0n;
      const typed = parseAmount(minPriceInput);
      const chosen = typed && Number.isInteger(d) ? choosePriceUnit(typed, d) : null;
      if (!typed || typed.mantissa === 0n) problems.push("Enter a minimum price per token above zero.");
      else if (!chosen) problems.push("That minimum price is too high for a token with these decimals.");
      else {
        priceUnit = chosen.priceUnit;
        minTicks = chosen.minTicks;
        const effective = tokenPrice(minTicks, priceUnit, d);
        minPriceShown = formatDecimal(effective);
        rounded = !sameDecimal(effective, typed);
      }
      saleValue = priceUnit > 0n ? (sellAmount * minTicks + priceUnit - 1n) / priceUnit : 0n;
      if (source === "new") {
        if (name.trim().length === 0 || name.length > 32) problems.push("Give the token a name of up to 32 characters.");
        if (symbol.trim().length === 0 || symbol.length > 10) problems.push("Give the token a symbol of up to 10 characters.");
        if (tokenFiles === "link") {
          if (uri.length > MAX_URI_LEN) problems.push("The metadata link is too long.");
          else if (uri.trim() !== "" && !isMetadataUri(uri.trim(), MAX_URI_LEN))
            problems.push("The metadata link must start with https://, ipfs:// or ar://.");
        } else if (tokenDescription.length > MAX_DESCRIPTION_LEN) {
          problems.push(`Keep the description to ${formatCount(MAX_DESCRIPTION_LEN)} characters.`);
        }
        const total = Number.isInteger(d) ? parseDecimal(supply, d) : null;
        if (!total || total <= 0n || total > U64_MAX) problems.push("Enter the total supply.");
        else if (sellAmount > total) problems.push("The sale needs more tokens than the total supply.");
      } else {
        if (!existing) problems.push("Enter the address of a token you hold.");
        else {
          if (existing.mintAuthority) problems.push("This token can still be minted. Revoke its mint authority first.");
          if (existing.freezeAuthority) problems.push("This token can be frozen. Revoke its freeze authority first.");
          if (existingBalance !== null && sellAmount > existingBalance)
            problems.push(`You hold ${formatTokens(existingBalance, existing.decimals)}; the sale needs more.`);
        }
      }
    }

    // The smallest token bid: its deposit and its sealed budget. By default it is
    // the sale's worth at the minimum price split across every bid place,
    // so nobody can take every place for less than the whole sale.
    // Spread over the first page's places: filling just those costs the sale's worth.
    const places = BigInt(PAGE_BIDS);
    let suggested = saleValue > 0n ? (saleValue + places - 1n) / places : MIN_SUGGESTED_DEPOSIT;
    suggested = suggested < MIN_SUGGESTED_DEPOSIT ? MIN_SUGGESTED_DEPOSIT : roundUpSignificant(suggested, 2);
    const minDepositText = minDepositInput ?? formatSol(suggested, 9).replace(/,/g, "");
    const minDeposit = collection ? minTicks * NFT_PRICE_SCALE : parseSol(minDepositText);
    if (!collection && (!minDeposit || minDeposit <= 0n)) problems.push("Enter the smallest bid in SOL, above zero.");

    if (fees.data === null) problems.push("The platform's fees are not set up yet, so auctions cannot open.");
    return { problems, sellAmount, priceUnit, minTicks, minPriceShown, rounded, saleValue, minDeposit, minDepositText };
  }, [
    collection,
    details,
    linked,
    collectionUri,
    itemUri,
    uriPerItem,
    nftPlan,
    saleCount,
    maxPerBid,
    nftMinPriceInput,
    uploadingCollection,
    chosenStorage,
    payingForStorage,
    rates.error,
    needsSignature,
    hidden,
    signer,
    royalty,
    tokenDecimals,
    forSale,
    minPriceInput,
    minDepositInput,
    source,
    name,
    symbol,
    tokenFiles,
    tokenDescription,
    uri,
    supply,
    existing,
    existingBalance,
    fees.data,
  ]);

  const lp = useMemo(() => {
    const none = { problems: [] as string[], terms: null as LiquidityTerms | null, atMin: null as { net: bigint; sol: bigint } | null };
    if (collection || !lpOn) return none;
    const problems: string[] = [];
    const percent = Number.parseFloat(lpPercent);
    const lpBps = Math.round(percent * 100);
    if (!Number.isFinite(percent) || lpBps < MIN_LP_BPS || lpBps > MAX_LP_BPS)
      problems.push(`The pool's share must be between ${MIN_LP_BPS / 100}% and ${MAX_LP_BPS / 100}% of the proceeds.`);
    const floor = parseSol(lpFloor);
    if (!floor || floor <= 0n) problems.push("Enter the pool's minimum in SOL, above zero.");
    // The pool's reserve: as many tokens again as are for sale.
    const needed = plan.sellAmount * 2n;
    if (plan.sellAmount > 0n && Number.isInteger(tokenDecimals)) {
      if (source === "new") {
        const total = parseDecimal(supply, tokenDecimals);
        if (total && needed > total)
          problems.push("With auto-liquidity the total supply must cover the sale twice: the tokens for sale and as many again for the pool's reserve.");
      } else if (existingBalance !== null && needed > existingBalance) {
        problems.push(`With auto-liquidity you need twice the tokens for sale, ${formatTokens(needed, tokenDecimals)} in all.`);
      }
    }
    // What the pool would get if the sale only fills at the minimum price.
    let atMin = null;
    if (fees.data && floor && floor > 0n && plan.saleValue > 0n && lpBps >= MIN_LP_BPS && lpBps <= MAX_LP_BPS) {
      const net = plan.saleValue - (plan.saleValue * BigInt(fees.data.saleFeeBps)) / 10_000n;
      atMin = { net, sol: poolSol(net, lpBps, floor) };
    }
    const terms = problems.length === 0 && floor ? { lpBps, floor, tradeFeeBps: lpFee } : null;
    return { problems, terms, atMin };
  }, [collection, lpOn, lpPercent, lpFloor, lpFee, plan.sellAmount, plan.saleValue, tokenDecimals, source, supply, existingBalance, fees.data]);

  const onUploadProgress = (done: number, total: number) => setUploadProgress([done, total]);

  /** A fresh auction address for this wallet, kept until a launch goes through. */
  const launchSeed = async (seller: PublicKey): Promise<BN> => {
    let seed = seedRef.current;
    if (seed && (await fetchAuction(auctionAddress(seller, seed)))) seed = null;
    seed ??= randomU64();
    seedRef.current = seed;
    return seed;
  };

  const startIssue = startProblem(startAt, nowSecs());
  const crankIssue = crank.data === null ? "The platform's settlement rewards are not set up yet." : null;
  const problems = [
    ...plan.problems,
    ...lp.problems,
    ...(startIssue ? [startIssue] : []),
    ...(crankIssue ? [crankIssue] : []),
  ];
  /** The start to send: 0 for right away. A time that has passed by then also opens right away. */
  const chosenStart = () => (startAt === null ? 0 : fromLocalInput(startAt) ?? 0);

  const launchCollection = async () => {
    if (!signer || !fees.data) throw new Error("Connect a wallet first");
    const seed = await launchSeed(signer.publicKey);
    const auction = auctionAddress(signer.publicKey, seed);
    // Files go up before the wallet is asked to approve anything on chain,
    // so a failed upload never leaves a half-made auction behind.
    let files = { collectionUri: collectionUri.trim(), itemUri: itemUri.trim(), uriPerItem };
    if (uploadingCollection) {
      if (!collectionDraft) throw new Error("Finish the collection's details and NFTs first.");
      let target = freeTarget();
      let seal: SealOptions | undefined;
      if (needsSignature) setStepState("key");
      if (hidden) seal = { key: revealKey(await walletSignature(signer), auction), auction };
      if (!chosenStorage.free) {
        if (!rates.data) throw new Error("Storage prices are not loaded yet.");
        // The wallet's upload key holds the storage credit. Pay for what is
        // not stored yet (and, for hidden art, what the reveal publishes),
        // less any credit left from before.
        const key = await walletUploadKey(signer);
        target = paidTarget(key);
        const left = collectionUploadSizes(collectionDraft, quality, "paid", target);
        if (!left) throw new Error(`${chosenStorage.problem ?? "An image cannot be kept as it is"}.`);
        await ensureCredit(signer, key, creditFor([...left.launch, ...left.reveal], rates.data), rates.data, (s) =>
          setStepState(s === "pay" ? "pay" : "credit")
        );
      }
      setStepState("upload");
      try {
        files = await uploadCollection(collectionDraft, quality, onUploadProgress, target, seal);
      } catch (e) {
        if (e instanceof UploadError && e.reason === "free-used-up") setFreeUsedUp(true);
        throw e;
      }
    }
    setStepState("auction");
    const txs: Transaction[] = [];
    const listed = nftPlan.listed;
    if (listed) {
      // An unsealed list from an earlier try is replaced.
      const leftover = await fetchItemList(auction);
      txs.push(...(await buildItemList(signer.publicKey, seed, listed, Boolean(leftover && !leftover.sealed))));
    }
    const built = await buildCreateCollectionAuction(
      signer.publicKey,
      seed,
      {
        supply: nftPlan.count,
        minPrice: plan.minTicks,
        maxPerBid: Number.parseInt(maxPerBid, 10),
        durationSecs: duration,
        startTime: chosenStart(),
      },
      {
        name: details.name.trim(),
        uri: files.collectionUri,
        itemName: nftPlan.baseName,
        itemUri: files.itemUri,
        uriPerItem: files.uriPerItem,
        royaltyBps: Math.round(Number.parseFloat(royalty || "0") * 100),
        hidden,
      },
      fees.data,
      Boolean(listed)
    );
    txs.push(built.tx);
    setTxProgress([0, txs.length]);
    await sendTransactions(txs, signer, (done, total) => setTxProgress([done, total]));
    seedRef.current = null;
    return built.auction;
  };

  const launch = () =>
    action.run("launch", async () => {
      if (!signer) throw new Error("Connect a wallet first");
      if (problems.length > 0 || !plan.minDeposit) throw new Error(problems[0]);
      if (!fees.data) throw new Error("The platform's fees are not set up yet.");
      let auction: PublicKey;
      if (collection) {
        auction = await launchCollection();
      } else {
        let mint: PublicKey;
        let tokenProgram: PublicKey;
        if (source === "new") {
          let metadataUri = tokenFiles === "link" ? uri.trim() : "";
          if (uploadingToken && tokenHasMetadata) {
            setStepState("upload");
            metadataUri = await uploadTokenMetadata(
              {
                name: name.trim(),
                symbol: symbol.trim().toUpperCase(),
                description: tokenDescription,
                image: tokenImage,
              },
              onUploadProgress,
              freeTarget()
            );
          }
          setStepState("token");
          const total = parseDecimal(supply, tokenDecimals)!;
          const { tx, mint: mintKeypair } = await buildCreateToken(signer.publicKey, {
            name: name.trim(),
            symbol: symbol.trim().toUpperCase(),
            uri: metadataUri,
            decimals: tokenDecimals,
            supply: total,
          });
          await sendTransaction(tx, signer, [mintKeypair]);
          mint = mintKeypair.publicKey;
          tokenProgram = TOKEN_2022_PROGRAM_ID;
        } else {
          mint = existing!.mint;
          tokenProgram = existing!.programId;
        }
        setStepState("auction");
        const built = await buildCreateAuction(
          signer.publicKey,
          mint,
          tokenProgram,
          {
            supply: plan.sellAmount,
            priceUnit: plan.priceUnit,
            minPrice: plan.minTicks,
            minDeposit: plan.minDeposit,
            durationSecs: duration,
            startTime: chosenStart(),
          },
          fees.data,
          lp.terms
        );
        await sendTransaction(built.tx, signer);
        auction = built.auction;
      }
      window.location.hash = `#/auction/${auction.toBase58()}`;
    }).finally(() => {
      setStepState("form");
      setUploadProgress(null);
      setTxProgress(null);
    });

  const symbolText = source === "new" ? symbol.trim().toUpperCase() || "tokens" : existing?.symbol ?? "tokens";
  const touched = collection
    ? Boolean(details.name || details.logo || itemName || items.length > 0 || itemImages.length > 0)
    : Boolean(name || symbol || source === "existing");
  const baseLabel = itemName.trim() || "Name";
  const saleText = collection
    ? saleCount > 0
      ? `${formatCount(saleCount)} NFTs for sale`
      : "Supply"
    : plan.sellAmount > 0n && Number.isInteger(tokenDecimals)
      ? `${formatTokens(plan.sellAmount, tokenDecimals)} ${symbolText} for sale`
      : "Supply";
  const revealDays = REVEAL_DELAY_SECS / 86_400;
  const countFixed = kind === "collection" || (kind === "drop" && !linked && dropArt === "unique");

  // What the wallet will be asked, in order, for the hint under the button.
  const walletSteps = (): string => {
    const parts: string[] = [];
    if (collection) {
      if (needsSignature) {
        parts.push(
          `Your wallet first asks you to sign a message, which costs nothing and makes ${
            hidden && payingForStorage
              ? "your upload key and the key that seals your art"
              : hidden
                ? "the key that seals your art"
                : "your upload key"
          }.`
        );
      }
      if (payingForStorage) {
        parts.push(
          `Then you approve paying ${chosenStorage.quote ? `${formatSol(chosenStorage.quote.lamports)} SOL` : "for storage"}, less any credit left from before.`
        );
      }
      if (uploadingCollection) {
        parts.push(
          hidden
            ? "Your art is sealed and stored, unseen; the logo and details are published."
            : "Your images and metadata upload, with no wallet prompt."
        );
      }
      const txCount = listTxs + 1;
      parts.push(
        txCount === 1
          ? "Then your wallet asks you to approve one transaction, which opens the auction and pays the listing fee."
          : `Then your wallet asks you to approve ${txCount} transactions at once: ${listTxs === 1 ? "one writes" : `${listTxs} write`} the item list, the last opens the auction and pays the listing fee.`
      );
      return parts.join(" ");
    }
    if (uploadingToken && tokenHasMetadata) parts.push("Your token's details upload first, with no wallet prompt.");
    parts.push(
      source === "new"
        ? "Your wallet asks you to approve two transactions: one creates the token, the next opens the auction and pays the listing fee."
        : "Your wallet asks you to approve one transaction, which opens the auction and pays the listing fee."
    );
    return parts.join(" ");
  };

  return (
    <main className="page">
      <h1 className="page__title">Launch a sealed auction</h1>
      <p className="page__lede">
        Release a drop, build a collection item by item, or sell a token. However you put it together, it sells
        through sealed bids: buyers name their own price in secret, and everyone who wins pays one clearing price.
      </p>
      <KindChooser value={kind} onChange={setKind} />
      <div className="launch">
        <form
          className="launch__form"
          onSubmit={(e) => {
            e.preventDefault();
            launch();
          }}
        >
          {collection ? (
            <fieldset className="group">
              <legend className="group__title">Collection details</legend>
              {kind === "drop" ? (
                <div className="field">
                  <span className="field__label">Files</span>
                  <Segmented
                    label="Files"
                    value={dropFiles}
                    options={[
                      ["upload", "Upload them here"],
                      ["link", "Link to my files"],
                    ]}
                    onChange={setDropFiles}
                  />
                </div>
              ) : null}
              <DetailsFields value={details} onChange={setDetails} linked={linked} />
              {linked ? (
                <div className="field">
                  <label htmlFor="curi">Collection metadata link</label>
                  <input id="curi" value={collectionUri} onChange={(e) => setCollectionUri(e.target.value)} placeholder="https://…/collection.json" spellCheck={false} />
                  <p className="hint">A JSON file with the collection's description and image, on https, IPFS or Arweave.</p>
                </div>
              ) : null}
              <p className="hint">
                The collection is created when the auction opens, and NFTs are minted straight to their winners when
                they collect them; NFTs nobody wins are never minted. Once the sale is closed, the collection is yours
                to manage.
              </p>
            </fieldset>
          ) : null}

          {kind === "drop" ? (
            <fieldset className="group">
              <legend className="group__title">NFTs</legend>
              {linked ? (
                <>
                  <div className="field">
                    <label htmlFor="iname">NFT name</label>
                    <input id="iname" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="Delft Tile" />
                    <p className="hint">The NFTs are {baseLabel} #1, {baseLabel} #2 and so on.</p>
                  </div>
                  <div className="field">
                    <span className="field__label">NFT metadata</span>
                    <Segmented
                      label="NFT metadata"
                      value={uriPerItem ? "each" : "same"}
                      options={[
                        ["each", "One file per NFT"],
                        ["same", "Same file for all"],
                      ]}
                      onChange={(v) => setUriPerItem(v === "each")}
                    />
                    <input
                      className="field__extra"
                      aria-label={uriPerItem ? "Metadata folder link" : "Metadata link"}
                      value={itemUri}
                      onChange={(e) => setItemUri(e.target.value)}
                      placeholder={uriPerItem ? "https://…/metadata/" : "https://…/nft.json"}
                      spellCheck={false}
                    />
                    <p className="hint">
                      {uriPerItem
                        ? `#1 reads ${itemUri.trim() || "…/"}0.json, #2 reads ${itemUri.trim() || "…/"}1.json, and so on.`
                        : "Every NFT shows this file."}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div className="field">
                    <span className="field__label">Art</span>
                    <Segmented
                      label="Art"
                      value={dropArt}
                      options={[
                        ["unique", "One image per NFT"],
                        ["same", "Same image for all"],
                      ]}
                      onChange={setDropArt}
                    />
                  </div>
                  {dropArt === "unique" ? (
                    <>
                      <ImageSetPicker id="iimages" label="Images" value={itemImages} onChange={setItemImages} />
                      <SheetPicker value={sheet} onChange={setSheet} fileNames={itemImages.map((image) => image.name)} />
                      {sheet?.sheet.hasNames && !hidden ? null : (
                        <div className="field">
                          <label htmlFor="iname">NFT name</label>
                          <input id="iname" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="Delft Tile" />
                          <p className="hint">
                            The NFTs are {baseLabel} #1, {baseLabel} #2 and so on, numbered{" "}
                            {sheet ? "by the sheet's tokenID" : "in file-name order"}. Name them one by one in a sheet
                            instead, for drops of up to {formatCount(MAX_ITEMS)}.
                          </p>
                        </div>
                      )}
                      {nftPlan.notes.map((note) => (
                        <p key={note} className="hint hint--warn">
                          {note}
                        </p>
                      ))}
                      <NftPreview nfts={nftPlan.problems.length === 0 ? nftPlan.files : []} />
                    </>
                  ) : (
                    <>
                      <div className="field">
                        <span className="field__label">Image every NFT shows</span>
                        <Segmented
                          label="Image every NFT shows"
                          value={sameUsesLogo ? "logo" : "other"}
                          options={[
                            ["logo", "The logo"],
                            ["other", "Another image"],
                          ]}
                          onChange={(v) => setSameUsesLogo(v === "logo")}
                        />
                      </div>
                      {sameUsesLogo ? null : (
                        <ImagePicker id="iimage" label="Image for every NFT" value={itemImage} onChange={setItemImage} showOriginal />
                      )}
                      <div className="field">
                        <label htmlFor="iname">NFT name</label>
                        <input id="iname" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="Delft Tile" />
                        <p className="hint">The NFTs are {baseLabel} #1, {baseLabel} #2 and so on, all with the same image.</p>
                      </div>
                    </>
                  )}
                </>
              )}
              <p className="hint">Which NFTs each winner gets is drawn at random after the sale, so nobody can pick the rare ones.</p>
            </fieldset>
          ) : null}

          {kind === "collection" ? (
            <fieldset className="group">
              <legend className="group__title">Items</legend>
              <ItemsEditor value={items} onChange={setItems} />
            </fieldset>
          ) : null}

          {kind === "drop" ? (
            <fieldset className="group">
              <legend className="group__title">Reveal</legend>
              <label className={`check${canHide ? "" : " check--off"}`}>
                <input type="checkbox" checked={hidden} disabled={!canHide} onChange={(e) => setHidden(e.target.checked)} />
                <span>
                  <span className="check__title">Hide the art until the sale ends</span>
                  <span className="check__text">
                    {canHide
                      ? linked
                        ? "Your metadata folder only has to be online when you reveal. Bidders see the collection's details, not its NFTs."
                        : "Bidders see the collection's details and your preview image, not the NFTs. Your art is sealed with a key only your wallet can make, and published when you reveal it."
                      : linked
                        ? "Hiding needs one metadata file per NFT."
                        : "Hiding needs one image per NFT."}
                  </span>
                </span>
              </label>
              {hidden ? (
                <>
                  {linked ? null : (
                    <ImagePicker id="preview" label="Preview image (optional)" value={preview} onChange={setPreview} showOriginal />
                  )}
                  <p className="hint hint--warn">
                    After bidding ends you have {revealDays} days to reveal from this wallet. Until you do, no NFT can be
                    minted and you are not paid; if you do not, every winner takes their payment back.
                  </p>
                </>
              ) : null}
            </fieldset>
          ) : null}

          {uploadingCollection ? (
            <fieldset className="group">
              <legend className="group__title" id="storage-title">
                Storage
              </legend>
              <p className="hint">
                Your images and their metadata are stored on Arweave, where they are public and permanent: they cannot
                be changed or deleted.
                {hidden ? " Hidden art is stored twice: sealed now, and in the open when you reveal it." : ""}
              </p>
              <StorageChoice
                value={quality}
                onChange={setQuality}
                options={storage}
                nfts={nftPlan.perNft && nftPlan.count > 0 ? nftPlan.count : null}
                sample={storageSample}
                sampleLabel={sampleLabel}
                sampleKey={nftPlan.perNft ? "#1" : "Image"}
                labelledBy="storage-title"
                prices={{
                  loading: rates.loading,
                  error: rates.error,
                  at: rates.data?.at ?? null,
                  retry: rates.reload,
                }}
              />
            </fieldset>
          ) : null}

          {kind === "token" ? (
            <fieldset className="group">
              <legend className="group__title">Token</legend>
              <Segmented
                label="Token source"
                value={source}
                options={[
                  ["new", "Create a new token"],
                  ["existing", "Use a token I hold"],
                ]}
                onChange={setSource}
              />
              {source === "new" ? (
                <>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="name">Name</label>
                      <input id="name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="Tulip Coin" />
                    </div>
                    <div className="field field--narrow">
                      <label htmlFor="symbol">Symbol</label>
                      <input id="symbol" value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="TULIP" />
                    </div>
                  </div>
                  <div className="field">
                    <span className="field__label">Image and description</span>
                    <Segmented
                      label="Image and description"
                      value={tokenFiles}
                      options={[
                        ["upload", "Upload an image"],
                        ["link", "Link to my file"],
                      ]}
                      onChange={setTokenFiles}
                    />
                  </div>
                  {tokenFiles === "upload" ? (
                    <>
                      <ImagePicker id="timage" label="Token image (optional)" value={tokenImage} onChange={setTokenImage} />
                      <div className="field">
                        <label htmlFor="tdesc">Description (optional)</label>
                        <textarea
                          id="tdesc"
                          rows={3}
                          maxLength={MAX_DESCRIPTION_LEN}
                          value={tokenDescription}
                          onChange={(e) => setTokenDescription(e.target.value)}
                          placeholder="What the token is for."
                        />
                      </div>
                      <p className="hint">
                        Stored on Arweave with the token's name and symbol, public and permanent. The image is made{" "}
                        {formatKb(MAX_IMAGE_BYTES)} or smaller so storing it is free. Neither can be changed later.
                      </p>
                    </>
                  ) : (
                    <div className="field">
                      <label htmlFor="uri">Metadata link (optional)</label>
                      <input id="uri" value={uri} maxLength={MAX_URI_LEN} onChange={(e) => setUri(e.target.value)} placeholder="https://…/metadata.json" spellCheck={false} />
                      <p className="hint">A JSON file with an image, if you have one. It cannot be changed later.</p>
                    </div>
                  )}
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="supply">Total supply</label>
                      <input id="supply" inputMode="decimal" value={supply} onChange={(e) => setSupply(e.target.value)} />
                    </div>
                    <div className="field field--narrow">
                      <label htmlFor="decimals">Decimals</label>
                      <input id="decimals" inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value.replace(/[^0-9]/g, ""))} />
                    </div>
                  </div>
                  <p className="hint">
                    The whole supply is minted to you once. Minting and metadata changes are then switched off for
                    good, so buyers know no more can appear.
                  </p>
                </>
              ) : (
                <div className="field">
                  <label htmlFor="mint">Token address</label>
                  <input id="mint" value={mintInput} onChange={(e) => setMintInput(e.target.value)} placeholder="Token mint address" spellCheck={false} />
                  {existingError ? <p className="hint hint--error">{existingError}</p> : null}
                  {existing ? (
                    <p className="hint">
                      {existing.name ?? "Token"} {existing.symbol ? `(${existing.symbol})` : ""}
                      {existingBalance !== null ? `, you hold ${formatTokens(existingBalance, existing.decimals)}` : ""}.
                    </p>
                  ) : null}
                </div>
              )}
            </fieldset>
          ) : null}

          <fieldset className="group">
            <legend className="group__title">Sale</legend>
            {collection ? (
              <>
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="nfts">NFTs for sale</label>
                    {countFixed ? (
                      <input id="nfts" value={saleCount > 0 ? formatCount(saleCount) : "—"} readOnly aria-describedby="nfts-hint" />
                    ) : (
                      <input id="nfts" inputMode="numeric" value={nfts} onChange={(e) => setNfts(e.target.value.replace(/[^0-9]/g, ""))} />
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="perbid">Most NFTs per bid</label>
                    <input id="perbid" inputMode="numeric" value={maxPerBid} onChange={(e) => setMaxPerBid(e.target.value.replace(/[^0-9]/g, ""))} />
                  </div>
                </div>
                {countFixed ? (
                  <p id="nfts-hint" className="hint">
                    {kind === "collection" ? "Every edition of every item." : sheet ? "One per row of the sheet." : "One per image."}
                  </p>
                ) : null}
                <div className="field">
                  <label htmlFor="nftmin">Minimum price per NFT (SOL)</label>
                  <input id="nftmin" inputMode="decimal" value={nftMinPriceInput} onChange={(e) => setNftMinPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
                  <p className="hint">
                    {plan.rounded && plan.minPriceShown
                      ? `Prices go in steps of 0.000001 SOL, so this becomes ${plan.minPriceShown} SOL. `
                      : ""}
                    Bids below it do not count. The smallest bid is one NFT at this price
                    {plan.minPriceShown ? `, ${plan.minPriceShown} SOL` : ""}.
                  </p>
                </div>
                <p className="hint">
                  Up to {formatCount(MAX_COLLECTION_SIZE)} NFTs. Each winner pays about{" "}
                  {formatSol(NFT_MINT_COST_LAMPORTS)} SOL per NFT in rent and Metaplex fees when collecting.
                </p>
              </>
            ) : (
              <>
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="forsale">Tokens for sale</label>
                    <input id="forsale" inputMode="decimal" value={forSale} onChange={(e) => setForSale(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="minprice">Minimum price per token (SOL)</label>
                    <input id="minprice" inputMode="decimal" value={minPriceInput} onChange={(e) => setMinPrice(e.target.value.replace(/[^0-9.]/g, ""))} />
                  </div>
                </div>
                <p className="hint">
                  {plan.sellAmount > 0n && Number.isInteger(tokenDecimals)
                    ? `${formatTokens(plan.sellAmount, tokenDecimals)} ${symbolText} go into escrow when the auction opens; any not sold come back to you. `
                    : ""}
                  {plan.rounded && plan.minPriceShown ? `The minimum price is rounded to ${plan.minPriceShown} SOL. ` : ""}
                  Bids below the minimum price do not count.
                </p>
                <div className="field field--narrow">
                  <label htmlFor="mindeposit">Smallest bid (SOL)</label>
                  <input
                    id="mindeposit"
                    inputMode="decimal"
                    value={plan.minDepositText}
                    onChange={(e) => setMinDeposit(e.target.value.replace(/[^0-9.]/g, ""))}
                    aria-describedby="mindeposit-hint"
                  />
                </div>
                <p id="mindeposit-hint" className="hint">
                  The least a bidder can deposit, and the smallest sealed budget a bid can name. The auction takes up
                  to {formatCount(MAX_PAGES * PAGE_BIDS)} bids (see Room for bids); after that, larger deposits
                  replace the smallest. The suggestion splits the sale's worth at your minimum price across every place, so nobody
                  can take them all for less, and is at least {formatSol(MIN_SUGGESTED_DEPOSIT)} SOL. You can set a
                  lower amount.
                </p>
              </>
            )}
          </fieldset>

          <BiddingWindow startAt={startAt} onStartAt={setStartAt} duration={duration} onDuration={setDuration}>
            <BidRoom />
          </BiddingWindow>

          {collection ? null : (
            <fieldset className="group">
              <legend className="group__title">Auto-liquidity</legend>
              <label className="check">
                <input type="checkbox" checked={lpOn} onChange={(e) => setLpOn(e.target.checked)} />
                <span>
                  <span className="check__title">Open a Meteora pool at the clearing price</span>
                  <span className="check__text">
                    When the sale settles, part of what it raised and the {symbolText} that buys open a trading pool
                    at exactly the price every winner paid. The pool is locked forever: winners can always sell, and
                    nobody can pull the liquidity out.
                  </span>
                </span>
              </label>
              {lpOn ? (
                <>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="lppercent">Share of the proceeds (%)</label>
                      <input
                        id="lppercent"
                        inputMode="decimal"
                        value={lpPercent}
                        onChange={(e) => setLpPercent(e.target.value.replace(/[^0-9.]/g, ""))}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="lpfloor">Pool minimum (SOL)</label>
                      <input
                        id="lpfloor"
                        inputMode="decimal"
                        value={lpFloor}
                        onChange={(e) => setLpFloor(e.target.value.replace(/[^0-9.]/g, ""))}
                      />
                    </div>
                  </div>
                  <p className="hint">
                    From {MIN_LP_BPS / 100}% to {MAX_LP_BPS / 100}% of what the sale raises after the platform fee. The
                    share rises as needed to reach the minimum; a sale that cannot reach it does not go ahead, and every
                    bid is refunded in full.
                    {lp.atMin
                      ? lp.atMin.net < (parseSol(lpFloor) ?? 0n)
                        ? ` Filling only at the minimum price would raise ${formatSol(lp.atMin.net)} SOL after fees, short of the minimum.`
                        : ` Filling only at the minimum price, the pool would get ${formatSol(lp.atMin.sol)} SOL.`
                      : ""}
                  </p>
                  <div className="field">
                    <span className="field__label">Pool fee</span>
                    <Segmented
                      label="Pool fee"
                      value={String(lpFee)}
                      options={POOL_FEE_TIERS.map((bps) => [String(bps), formatPercent(bps)] as [string, string])}
                      onChange={(v) => setLpFee(Number(v))}
                    />
                  </div>
                  <p className="hint">
                    What traders pay once trading has settled: it opens at {formatPercent(ANTI_SNIPER_FEE_BPS)} against
                    snipers and falls to this over {ANTI_SNIPER_MINUTES} minutes. Meteora keeps{" "}
                    {DAMM_PROTOCOL_FEE_PERCENT}% of every fee; of the rest, {formatPercent(SELLER_POOL_FEE_BPS)} goes to
                    you and {formatPercent(10_000 - SELLER_POOL_FEE_BPS)} to Veiling, for as long as the pool trades.
                  </p>
                  <p className="hint">
                    {plan.sellAmount > 0n && Number.isInteger(tokenDecimals)
                      ? `You also escrow ${formatTokens(plan.sellAmount, tokenDecimals)} ${symbolText} as the pool's reserve`
                      : "You also escrow as many tokens again as the pool's reserve"}{" "}
                    and {formatSol(LP_RENT_DEPOSIT)} SOL for its rent. The pool takes only the tokens its SOL buys at
                    the clearing price; the rest, and the rent it does not use, come back to you.
                  </p>
                </>
              ) : null}
            </fieldset>
          )}

          {collection ? (
            <fieldset className="group">
              <legend className="group__title">Earnings</legend>
              <p className="hint">The proceeds of the sale go to the wallet that opens the auction, less the platform fee below.</p>
              <div className="field">
                <label htmlFor="royalty">Creator earnings (%)</label>
                <input
                  id="royalty"
                  className="field__short"
                  inputMode="decimal"
                  value={royalty}
                  onChange={(e) => setRoyalty(e.target.value.replace(/[^0-9.]/g, ""))}
                />
              </div>
              <p className="hint">
                A royalty paid to you on resales by marketplaces that honour royalties, up to {MAX_ROYALTY_BPS / 100}%.
              </p>
            </fieldset>
          ) : null}

          <fieldset className="group">
            <legend className="group__title">Fees</legend>
            {fees.data ? (
              <dl className="fees">
                <div>
                  <dt>Listing</dt>
                  <dd>
                    <span className="fees__amount">
                      {fees.data.listingFee > 0n ? `${formatSol(fees.data.listingFee)} SOL` : "Free"}
                    </span>
                    <span className="fees__note">Paid when the auction opens; not refunded if you cancel.</span>
                  </dd>
                </div>
                <div>
                  <dt>Sale</dt>
                  <dd>
                    <span className="fees__amount">{formatPercent(fees.data.saleFeeBps)}</span>
                    <span className="fees__note">Of the proceeds, taken when you claim them. Fixed for this auction.</span>
                  </dd>
                </div>
                {crank.data ? (
                  <div>
                    <dt>Settlement fund</dt>
                    <dd>
                      <span className="fees__amount">
                        {formatSol(sellerCrankFee(crank.data, collection ? "collection" : "token"))} SOL
                      </span>
                      <span className="fees__note">
                        Pays whoever runs the private steps that find the price{collection ? " and shuffle the NFTs" : ""}, so
                        your sale settles without you. Each bid adds {formatSol(bidCrankFee(crank.data))} SOL for its
                        own steps. What is not used comes back when you close the auction.
                      </span>
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : fees.loading ? (
              <p className="muted">Loading the platform's fees…</p>
            ) : (
              <p className="hint hint--error">{fees.error ?? "The platform's fees are not set up yet."}</p>
            )}
            {nftPlan.listed && collection ? (
              <p className="hint">
                The item list holds {formatSol(itemListRent(nftPlan.listed.length))} SOL of rent while the sale runs; it
                comes back when you close the auction.
              </p>
            ) : null}
            <p className="hint">
              Featured spots on the front page are picked by hand. To ask for one, message{" "}
              <a href={FEATURE_CONTACT.href} target="_blank" rel="noreferrer noopener">
                {FEATURE_CONTACT.label}
              </a>{" "}
              on X.
            </p>
          </fieldset>

          {problems.length > 0 && touched ? <Notice tone="info">{problems[0]}</Notice> : null}
          <div className="launch__submit">
            <Button variant="primary" type="submit" busy={action.busy === "launch"} disabled={!signer || problems.length > 0}>
              {!signer
                ? "Connect a wallet to launch"
                : kind === "drop"
                  ? "Launch drop and open auction"
                  : kind === "collection"
                    ? "Create collection and open auction"
                    : source === "new"
                      ? "Create token and open auction"
                      : "Open auction"}
            </Button>
            <p className="hint">
              {walletSteps()}
              {action.busy && step === "key" ? " Waiting for your wallet to sign…" : ""}
              {action.busy && step === "pay" ? " Waiting for you to approve the storage payment…" : ""}
              {action.busy && step === "credit" ? " Waiting for Turbo to count the payment…" : ""}
              {action.busy && step === "upload"
                ? uploadProgress && uploadProgress[1] > 1
                  ? ` ${hidden ? "Sealing and storing" : "Uploading"} ${formatCount(Math.min(uploadProgress[0] + 1, uploadProgress[1]))} of ${formatCount(uploadProgress[1])}…`
                  : " Uploading…"
                : ""}
              {action.busy && step === "token" ? " Creating the token…" : ""}
              {action.busy && step === "auction"
                ? txProgress && txProgress[1] > 1
                  ? ` Sending transaction ${formatCount(Math.min(txProgress[0] + 1, txProgress[1]))} of ${formatCount(txProgress[1])}…`
                  : " Opening the auction…"
                : ""}
            </p>
          </div>
          {action.error ? <Notice tone="error">{action.error}</Notice> : null}
        </form>
        <aside className="launch__preview" aria-label="How the price will be found">
          {collection ? (
            <CollectionCard details={details} linkedArt={linkedArt} count={saleCount} hidden={hidden} preview={preview} />
          ) : tokenArt ? (
            <img
              className={`launch__art launch__art--token${chosenArt && isSmallImage(tokenImage) ? " launch__art--pixels" : ""}`}
              src={tokenArt}
              alt="Token image"
              referrerPolicy="no-referrer"
            />
          ) : null}
          <DemandChart
            priceLabel={`Price per ${unit}`}
            supplyLabel={saleText}
            minLabel={plan.minPriceShown ? `Minimum ${plan.minPriceShown} SOL` : "Minimum price"}
          />
          <p className="muted launch__preview-note">
            Example bids. Buyers name any price at or above your minimum. When bidding closes, the highest bids
            that cover your supply win, and all of them pay the price where they meet it.
          </p>
        </aside>
      </div>
    </main>
  );
}
