// Pieces of the launch page for NFTs: what is being launched, the
// collection's details, a drop's metadata sheet and preview, and the item
// editor of a collection built item by item.
import { useEffect, useMemo, useState } from "react";
import { MAX_ITEM_NAME_LEN, MAX_ITEMS } from "../config";
import { MAX_TRAITS, MAX_TRAIT_TYPE_LEN, MAX_TRAIT_VALUE_LEN, type Sheet, type Trait, readSheet, sheetTemplate } from "../lib/csv";
import { formatCount, plural } from "../lib/format";
import type { PreparedImage } from "../lib/images";
import type { NftFile } from "../lib/uploads";
import { isDisplayText } from "../lib/validate";
import { ImagePicker, isSmallImage, useImageUrl } from "./ImagePicker";
import { Button } from "./ui";

export type Kind = "drop" | "collection" | "token";

/** Longest description stored in metadata. */
export const MAX_DESCRIPTION_LEN = 1_000;

export const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** A trait as a short chip: its value, with the trait's name when the value is a bare number. */
export const traitLabel = (trait: string, value: string) =>
  trait && /^[0-9.,%+-]+$/.test(value) ? `${trait} ${value}` : value;

/** An https link, or empty. */
export const isLinkOrEmpty = (value: string) => value.trim() === "" || /^https:\/\/[^\s]+\.[^\s]+$/.test(value.trim());

// ---------------------------------------------------------------------------
// What is being launched
// ---------------------------------------------------------------------------

function KindIcon({ kind }: { kind: Kind }) {
  if (kind === "drop") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        {[0, 1, 2].flatMap((row) =>
          [0, 1, 2].map((col) => <rect key={`${row}-${col}`} x={4 + col * 9} y={4 + row * 9} width="6" height="6" rx="1" />)
        )}
      </svg>
    );
  }
  if (kind === "collection") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="4" y="5" width="8" height="8" rx="1" />
        <rect x="4" y="19" width="8" height="8" rx="1" />
        <path d="M16 8h12M16 11h8M16 22h12M16 25h8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="11" />
      <circle cx="16" cy="16" r="6" />
    </svg>
  );
}

const KINDS: [Kind, string, string][] = [
  [
    "drop",
    "Drop",
    "A whole collection at once: upload every image, with a sheet of names and traits if you like. The art can stay hidden until the sale ends.",
  ],
  ["collection", "Collection", "Built item by item: each item has its own image, name, traits and number of editions."],
  [
    "token",
    "Token",
    "A new token, made only if its sale sells out: 50% of the supply sold by sealed bid, and what it raises opens its pool.",
  ],
];

/** The choice between a drop, a collection and a token, as cards. */
export function KindChooser({ value, onChange }: { value: Kind; onChange: (kind: Kind) => void }) {
  return (
    <div className="kinds" role="radiogroup" aria-label="What you are launching">
      {KINDS.map(([kind, title, text]) => (
        <label key={kind} className={`kind${value === kind ? " kind--on" : ""}`}>
          <input className="kind__radio" type="radio" name="kind" value={kind} checked={value === kind} onChange={() => onChange(kind)} />
          <span className="kind__icon">
            <KindIcon kind={kind} />
          </span>
          <span className="kind__title">{title}</span>
          <span className="kind__text">{text}</span>
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The collection's details
// ---------------------------------------------------------------------------

export type Details = {
  name: string;
  logo: PreparedImage | null;
  banner: PreparedImage | null;
  description: string;
  website: string;
  x: string;
};

export const emptyDetails: Details = { name: "", logo: null, banner: null, description: "", website: "", x: "" };

/** Name, logo, banner, description and links: what OpenSea calls the collection's details. */
export function DetailsFields({
  value,
  onChange,
  linked,
}: {
  value: Details;
  onChange: (details: Details) => void;
  /** Whether the seller links to metadata they host, so only the name is asked for here. */
  linked: boolean;
}) {
  const set = <K extends keyof Details>(key: K, v: Details[K]) => onChange({ ...value, [key]: v });
  return (
    <>
      <div className="field">
        <label htmlFor="cname">Collection name</label>
        <input id="cname" value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="Delft Tiles" />
      </div>
      {linked ? null : (
        <>
          <ImagePicker id="clogo" label="Logo" value={value.logo} onChange={(image) => set("logo", image)} showOriginal />
          <ImagePicker
            id="cbanner"
            label="Banner (optional)"
            value={value.banner}
            onChange={(image) => set("banner", image)}
            showOriginal
          />
          <p className="hint">The logo shows next to the name everywhere; the banner runs across the top of the sale page, ideally wide (about 3:1).</p>
          <div className="field">
            <label htmlFor="cdesc">Description (optional)</label>
            <textarea
              id="cdesc"
              rows={3}
              maxLength={MAX_DESCRIPTION_LEN}
              value={value.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="What the collection is about. NFTs without a description of their own show this one."
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="cweb">Website (optional)</label>
              <input
                id="cweb"
                value={value.website}
                onChange={(e) => set("website", e.target.value)}
                placeholder="https://…"
                spellCheck={false}
                aria-invalid={!isLinkOrEmpty(value.website)}
              />
            </div>
            <div className="field">
              <label htmlFor="cx">X profile (optional)</label>
              <input
                id="cx"
                value={value.x}
                onChange={(e) => set("x", e.target.value)}
                placeholder="https://x.com/…"
                spellCheck={false}
                aria-invalid={!isLinkOrEmpty(value.x)}
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// A drop's metadata sheet
// ---------------------------------------------------------------------------

export type ChosenSheet = { file: string; sheet: Sheet };

/** A link to download text as a file, released when no longer shown. */
function useDownload(text: string, type: string): string {
  const url = useMemo(() => URL.createObjectURL(new Blob([text], { type })), [text, type]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return url;
}

/** Picks the metadata sheet (CSV) of a drop and offers a template to fill in. */
export function SheetPicker({
  value,
  onChange,
  fileNames,
}: {
  value: ChosenSheet | null;
  onChange: (sheet: ChosenSheet | null) => void;
  /** The chosen images' file names, for the template. */
  fileNames: string[];
}) {
  const [error, setError] = useState<string | null>(null);
  const template = useDownload(sheetTemplate(fileNames), "text/csv");
  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("The sheet is over 5 MB.");
      onChange({ file: file.name, sheet: readSheet(await file.text()) });
    } catch (e) {
      onChange(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const sheet = value?.sheet;
  return (
    <div className="field">
      <span className="field__label">Metadata sheet (optional)</span>
      <div className="sheet">
        <span className="sheet__body">
          {sheet ? (
            <>
              <span className="picker__name">{value.file}</span>
              <span className="picker__meta">
                {plural(sheet.rows.length, "NFT")}
                {sheet.hasNames ? ", each with its own name" : ", numbered"}
                {sheet.traitTypes.length > 0
                  ? `; ${plural(sheet.traitTypes.length, "trait")}: ${sheet.traitTypes.slice(0, 6).join(", ")}${sheet.traitTypes.length > 6 ? "…" : ""}`
                  : "; no traits"}
                .{sheet.ignored.length > 0 ? ` Not used: ${sheet.ignored.join(", ")}.` : ""}
              </span>
            </>
          ) : (
            <span className="picker__meta">
              A CSV file in OpenSea's format: one row per NFT with its tokenID, name, description, file_name,
              external_url and traits as attributes[Trait] columns. Spreadsheets saved with semicolons work too.
            </span>
          )}
          <span className="picker__actions">
            <input
              id="sheet"
              className="sr-only"
              type="file"
              accept=".csv,text/csv"
              aria-label="Metadata sheet"
              onChange={(e) => {
                choose(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <label htmlFor="sheet" className="btn btn--secondary picker__choose" aria-hidden="true">
              {sheet ? "Change" : "Choose sheet"}
            </label>
            {sheet ? (
              <button type="button" className="btn btn--quiet" onClick={() => onChange(null)}>
                Remove
              </button>
            ) : null}
            <a className="btn btn--quiet" href={template} download="metadata.csv">
              Download a template
            </a>
          </span>
        </span>
      </div>
      {error ? (
        <p className="hint hint--error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the NFTs will look like
// ---------------------------------------------------------------------------

function NftCard({ nft, caption }: { nft: NftFile; caption?: string }) {
  const url = useImageUrl(nft.image);
  return (
    <li className="nftcard">
      {url ? <img className={`nftcard__img${isSmallImage(nft.image) ? " nftcard__img--pixels" : ""}`} src={url} alt="" /> : null}
      <span className="nftcard__name">{nft.name}</span>
      {caption ? <span className="nftcard__meta">{caption}</span> : null}
      {nft.attributes.length > 0 ? (
        <span className="nftcard__traits">
          {nft.attributes.slice(0, 3).map((a) => (
            <span key={a.trait_type} className="trait" title={`${a.trait_type}: ${a.value}`}>
              {traitLabel(a.trait_type, a.value)}
            </span>
          ))}
          {nft.attributes.length > 3 ? <span className="trait trait--more">+{nft.attributes.length - 3}</span> : null}
        </span>
      ) : null}
    </li>
  );
}

const PREVIEW_COUNT = 8;

/** The first few NFTs as they will be minted: image, name and traits. */
export function NftPreview({ nfts }: { nfts: NftFile[] }) {
  if (nfts.length === 0) return null;
  return (
    <div className="field">
      <span className="field__label">Preview</span>
      <ul className="nftgrid nftgrid--small">
        {nfts.slice(0, PREVIEW_COUNT).map((nft, i) => (
          <NftCard key={i} nft={nft} caption={`#${i + 1}`} />
        ))}
      </ul>
      {nfts.length > PREVIEW_COUNT ? <p className="hint">And {formatCount(nfts.length - PREVIEW_COUNT)} more.</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A collection built item by item
// ---------------------------------------------------------------------------

export type DraftTrait = { type: string; value: string };

export type DraftItem = {
  id: number;
  image: PreparedImage;
  name: string;
  editions: number;
  description: string;
  externalUrl: string;
  traits: DraftTrait[];
};

/** Traits as metadata stores them: filled rows only. */
export const traitsOf = (rows: DraftTrait[]): Trait[] =>
  rows
    .map((row) => ({ trait_type: row.type.trim(), value: row.value.trim() }))
    .filter((t) => t.trait_type !== "" && t.value !== "");

function TraitRows({ value, onChange }: { value: DraftTrait[]; onChange: (rows: DraftTrait[]) => void }) {
  const update = (i: number, row: DraftTrait) => onChange(value.map((r, k) => (k === i ? row : r)));
  return (
    <fieldset className="field">
      <legend>Traits (optional)</legend>
      {value.length > 0 ? (
        <div className="traits">
          {value.map((row, i) => (
            <div className="traits__row" key={i}>
              <input
                aria-label={`Trait ${i + 1}`}
                value={row.type}
                maxLength={MAX_TRAIT_TYPE_LEN}
                placeholder="Trait, e.g. Background"
                onChange={(e) => update(i, { ...row, type: e.target.value })}
              />
              <input
                aria-label={`Value of trait ${i + 1}`}
                value={row.value}
                maxLength={MAX_TRAIT_VALUE_LEN}
                placeholder="Value, e.g. Blue"
                onChange={(e) => update(i, { ...row, value: e.target.value })}
              />
              <button type="button" className="btn btn--quiet" onClick={() => onChange(value.filter((_, k) => k !== i))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {value.length < MAX_TRAITS ? (
        <span>
          <Button variant="quiet" type="button" onClick={() => onChange([...value, { type: "", value: "" }])}>
            Add a trait
          </Button>
        </span>
      ) : null}
    </fieldset>
  );
}

type EditorState = {
  image: PreparedImage | null;
  name: string;
  editions: string;
  description: string;
  externalUrl: string;
  traits: DraftTrait[];
};

const blankItem: EditorState = { image: null, name: "", editions: "1", description: "", externalUrl: "", traits: [] };

/** Why an item cannot be saved yet, if it cannot. */
function itemProblem(item: EditorState): string | null {
  if (!item.image) return "Choose the item's image.";
  if (!isDisplayText(item.name, MAX_ITEM_NAME_LEN))
    return `Give the item a name of up to ${MAX_ITEM_NAME_LEN} bytes (letters like ç or ğ count as two).`;
  const editions = Number(item.editions);
  if (!Number.isInteger(editions) || editions < 1 || editions > 10_000) return "Editions must be a whole number from 1.";
  if (!isLinkOrEmpty(item.externalUrl)) return "The item's link must start with https://.";
  if (item.description.length > MAX_DESCRIPTION_LEN) return `Keep the description to ${formatCount(MAX_DESCRIPTION_LEN)} characters.`;
  const types = traitsOf(item.traits).map((t) => t.trait_type.toLowerCase());
  if (new Set(types).size !== types.length) return "Each trait can appear once per item.";
  return null;
}

function ItemEditor({
  initial,
  onSave,
  onCancel,
  title,
}: {
  initial: EditorState;
  onSave: (item: EditorState) => void;
  onCancel: () => void;
  title: string;
}) {
  const [item, setItem] = useState<EditorState>(initial);
  const [tried, setTried] = useState(false);
  const problem = itemProblem(item);
  const set = <K extends keyof EditorState>(key: K, v: EditorState[K]) => setItem((current) => ({ ...current, [key]: v }));
  return (
    <div className="editor" role="group" aria-label={title}>
      <p className="editor__title">{title}</p>
      <ImagePicker id="item-image" label="Image" value={item.image} onChange={(image) => set("image", image)} showOriginal />
      <div className="field-row">
        <div className="field">
          <label htmlFor="item-name">Name</label>
          <input id="item-name" value={item.name} onChange={(e) => set("name", e.target.value)} placeholder="Windmill at Dusk" />
        </div>
        <div className="field field--narrow">
          <label htmlFor="item-editions">Editions</label>
          <input
            id="item-editions"
            inputMode="numeric"
            value={item.editions}
            onChange={(e) => set("editions", e.target.value.replace(/[^0-9]/g, ""))}
          />
        </div>
      </div>
      <p className="hint">
        {Number(item.editions) > 1
          ? `${formatCount(Number(item.editions))} copies, named ${item.name.trim() || "Name"} #1, #2 and so on.`
          : "One of a kind. Set more editions to sell copies of it."}
      </p>
      <div className="field">
        <label htmlFor="item-desc">Description (optional)</label>
        <textarea
          id="item-desc"
          rows={2}
          maxLength={MAX_DESCRIPTION_LEN}
          value={item.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Shown with this item; without one, the collection's description is used."
        />
      </div>
      <div className="field">
        <label htmlFor="item-link">External link (optional)</label>
        <input
          id="item-link"
          value={item.externalUrl}
          onChange={(e) => set("externalUrl", e.target.value)}
          placeholder="https://…"
          spellCheck={false}
          aria-invalid={!isLinkOrEmpty(item.externalUrl)}
        />
      </div>
      <TraitRows value={item.traits} onChange={(traits) => set("traits", traits)} />
      {tried && problem ? <p className="hint hint--error">{problem}</p> : null}
      <div className="actions">
        <Button
          variant="primary"
          type="button"
          onClick={() => {
            setTried(true);
            if (!problem) onSave(item);
          }}
        >
          Save item
        </Button>
        <Button variant="quiet" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ItemRow({ item, onEdit, onRemove, onMove }: { item: DraftItem; onEdit: () => void; onRemove: () => void; onMove: (by: -1 | 1) => void }) {
  const url = useImageUrl(item.image);
  const traits = traitsOf(item.traits);
  return (
    <li className="itemrow">
      <span className="picker__thumb">{url ? <img src={url} alt="" /> : null}</span>
      <span className="itemrow__text">
        <span className="itemrow__name">{item.name}</span>
        <span className="picker__meta">
          {item.editions === 1 ? "One of a kind" : `${formatCount(item.editions)} editions`}
          {traits.length > 0 ? ` · ${traits.map((t) => t.value).slice(0, 3).join(", ")}${traits.length > 3 ? "…" : ""}` : ""}
        </span>
      </span>
      <span className="itemrow__actions">
        <button type="button" className="btn btn--quiet" onClick={() => onMove(-1)} aria-label={`Move ${item.name} up`}>
          ↑
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => onMove(1)} aria-label={`Move ${item.name} down`}>
          ↓
        </button>
        <button type="button" className="btn btn--quiet" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn btn--quiet" onClick={onRemove}>
          Remove
        </button>
      </span>
    </li>
  );
}

let nextItemId = 1;

/** The items of a collection built item by item, with an editor to add or change one. */
export function ItemsEditor({ value, onChange }: { value: DraftItem[]; onChange: (items: DraftItem[]) => void }) {
  const [editing, setEditing] = useState<number | "new" | null>(value.length === 0 ? "new" : null);
  const nfts = value.reduce((sum, item) => sum + item.editions, 0);
  const save = (state: EditorState, id: number | null) => {
    const item: DraftItem = {
      id: id ?? nextItemId++,
      image: state.image!,
      name: state.name.trim(),
      editions: Number(state.editions),
      description: state.description,
      externalUrl: state.externalUrl.trim(),
      traits: state.traits,
    };
    onChange(id === null ? [...value, item] : value.map((existing) => (existing.id === id ? item : existing)));
    setEditing(null);
  };
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  };
  return (
    <div className="field">
      {value.length > 0 ? (
        <ul className="items">
          {value.map((item, i) =>
            editing === item.id ? (
              <li key={item.id}>
                <ItemEditor
                  title={`Edit ${item.name}`}
                  initial={{ ...item, editions: String(item.editions) }}
                  onSave={(state) => save(state, item.id)}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <ItemRow
                key={item.id}
                item={item}
                onEdit={() => setEditing(item.id)}
                onRemove={() => onChange(value.filter((other) => other.id !== item.id))}
                onMove={(by) => move(i, by)}
              />
            )
          )}
        </ul>
      ) : null}
      {editing === "new" ? (
        <ItemEditor title="New item" initial={blankItem} onSave={(state) => save(state, null)} onCancel={() => setEditing(null)} />
      ) : value.length < MAX_ITEMS ? (
        <span>
          <Button type="button" onClick={() => setEditing("new")} disabled={editing !== null}>
            Add an item
          </Button>
        </span>
      ) : null}
      <p className="hint">
        {value.length > 0
          ? `${plural(value.length, "item")}, ${plural(nfts, "NFT")} in all. `
          : ""}
        Items are numbered in this order. Up to {formatCount(MAX_ITEMS)} items; editions of the same item share its
        image and traits.
      </p>
    </div>
  );
}
