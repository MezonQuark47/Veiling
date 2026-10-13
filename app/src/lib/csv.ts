// The metadata sheet a drop can come with, in the format OpenSea uses for its
// drops: one row per NFT with its name, description, image file and traits.
//
//   tokenID,name,description,file_name,external_url,attributes[Background],attributes[Eyes]
//   1,Tulip #1,A red tulip.,tulip-1.png,,Red,Open
//
// Every column is optional. Spreadsheets saved with semicolons or tabs
// instead of commas (Excel does that in many languages) are read too.

/** A trait as NFT metadata lists it. */
export type Trait = { trait_type: string; value: string };

export type SheetRow = {
  /** NFT number from 0: from the tokenID column, or the row's order. */
  number: number;
  /** Empty when the sheet names no NFTs. */
  name: string;
  description: string;
  /** The image file this NFT shows; empty when the sheet has no file column. */
  fileName: string;
  externalUrl: string;
  traits: Trait[];
  /** The row's line in the file, for messages. */
  line: number;
};

export type Sheet = {
  /** In NFT-number order. */
  rows: SheetRow[];
  traitTypes: string[];
  /** Whether every row names its NFT. */
  hasNames: boolean;
  /** Whether rows say which image file they use. */
  hasFiles: boolean;
  /** Columns this app does not use. */
  ignored: string[];
};

/** Limits that keep traits readable on marketplaces. */
export const MAX_TRAITS = 50;
export const MAX_TRAIT_TYPE_LEN = 64;
export const MAX_TRAIT_VALUE_LEN = 128;
const MAX_ROWS = 10_000;
const MAX_CELL_LEN = 2_000;

/** The delimiter of a sheet: whichever of comma, semicolon or tab its first line uses most. */
function delimiterOf(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).reduce((best, entry) => (entry[1] > best[1] ? entry : best), [",", 0] as [string, number])[0];
}

/** Splits CSV text into rows of cells (RFC 4180: quoted cells may hold delimiters, quotes and line breaks). */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error("The sheet has a quote that is never closed.");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

type Column =
  | { kind: "number" | "name" | "description" | "file" | "url" }
  | { kind: "trait"; type: string }
  | { kind: "ignored" };

const SIMPLE_COLUMNS: Record<string, Column["kind"]> = {
  tokenid: "number",
  id: "number",
  name: "name",
  description: "description",
  filename: "file",
  file: "file",
  image: "file",
  externalurl: "url",
  externallink: "url",
};

function columnOf(header: string): Column {
  const trait = header.trim().match(/^attributes?\s*\[(.*)\]$/i);
  if (trait) return { kind: "trait", type: trait[1].trim() };
  const simple = SIMPLE_COLUMNS[header.trim().toLowerCase().replace(/[\s_-]/g, "")];
  return simple ? ({ kind: simple } as Column) : { kind: "ignored" };
}

/** Text without control characters, as metadata stores it. */
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}

/**
 * Reads a metadata sheet. Throws an error worded for the person who made it
 * when the sheet cannot be used.
 */
export function readSheet(text: string): Sheet {
  const all = parseCsv(text).filter((cells) => cells.some((cell) => cell.trim() !== ""));
  if (all.length === 0) throw new Error("The sheet is empty.");
  const [header, ...body] = all;
  if (body.length === 0) throw new Error("The sheet has a header row but no NFTs under it.");
  if (body.length > MAX_ROWS) throw new Error(`The sheet has ${body.length} rows; a drop holds at most ${MAX_ROWS} NFTs.`);

  const columns = header.map(columnOf);
  const seen = new Set<string>();
  for (const [i, column] of columns.entries()) {
    const key = column.kind === "trait" ? `trait:${column.type.toLowerCase()}` : column.kind;
    if (column.kind === "ignored") continue;
    if (column.kind === "trait") {
      if (!column.type) throw new Error(`Column ${i + 1} is a trait without a name; write it as attributes[Background].`);
      if (column.type.length > MAX_TRAIT_TYPE_LEN) throw new Error(`The trait "${column.type.slice(0, 20)}…" has too long a name.`);
    }
    if (seen.has(key)) throw new Error(`The sheet has two "${header[i].trim()}" columns.`);
    seen.add(key);
  }
  const traitColumns = columns.filter((c): c is { kind: "trait"; type: string } => c.kind === "trait");
  if (traitColumns.length > MAX_TRAITS) throw new Error(`The sheet has ${traitColumns.length} traits; up to ${MAX_TRAITS} are supported.`);
  const has = (kind: Column["kind"]) => columns.some((c) => c.kind === kind);

  type Draft = SheetRow & { id: string };
  const rows: Draft[] = body.map((cells, r) => {
    const line = r + 2;
    const row: Draft = { number: r, id: "", name: "", description: "", fileName: "", externalUrl: "", traits: [], line };
    columns.forEach((column, c) => {
      const value = clean(cells[c] ?? "");
      if (value.length > MAX_CELL_LEN) throw new Error(`Line ${line} has a cell over ${MAX_CELL_LEN} characters.`);
      switch (column.kind) {
        case "number":
          row.id = value;
          break;
        case "name":
          row.name = value;
          break;
        case "description":
          row.description = value;
          break;
        case "file":
          row.fileName = value;
          break;
        case "url":
          row.externalUrl = value;
          break;
        case "trait":
          if (value === "") break;
          if (value.length > MAX_TRAIT_VALUE_LEN) throw new Error(`Line ${line}: the ${column.type} trait is too long.`);
          row.traits.push({ trait_type: column.type, value });
          break;
      }
    });
    if (row.externalUrl && !/^https:\/\/\S+$/.test(row.externalUrl)) {
      throw new Error(`Line ${line}: the external link must start with https://.`);
    }
    if (has("file") && !row.fileName) throw new Error(`Line ${line} names no image file.`);
    return row;
  });

  // Token ids number the NFTs: 1 to N (or 0 to N - 1), each once.
  if (has("number")) {
    const ids = rows.map((row) => {
      if (!/^\d{1,6}$/.test(row.id)) throw new Error(`Line ${row.line}: the tokenID must be a whole number.`);
      return Number(row.id);
    });
    const base = Math.min(...ids) === 0 ? 0 : 1;
    const taken = new Set<number>();
    rows.forEach((row, i) => {
      const number = ids[i] - base;
      if (number < 0 || number >= rows.length) {
        throw new Error(`Line ${row.line}: tokenIDs must run from ${base} to ${rows.length - 1 + base} with none missing.`);
      }
      if (taken.has(number)) throw new Error(`Line ${row.line}: tokenID ${ids[i]} is used twice.`);
      taken.add(number);
      row.number = number;
    });
    rows.sort((a, b) => a.number - b.number);
  }

  const named = rows.filter((row) => row.name !== "").length;
  if (named > 0 && named < rows.length) {
    const unnamed = rows.find((row) => row.name === "")!;
    throw new Error(`Line ${unnamed.line} has no name. Name every NFT in the sheet, or none, to number them instead.`);
  }

  return {
    rows: rows.map(({ number, name, description, fileName, externalUrl, traits, line }) => ({
      number,
      name,
      description,
      fileName,
      externalUrl,
      traits,
      line,
    })),
    traitTypes: traitColumns.map((c) => c.type),
    hasNames: named === rows.length,
    hasFiles: has("file"),
    ignored: header.filter((_, i) => columns[i].kind === "ignored").map((h) => h.trim()).filter(Boolean),
  };
}

function csvCell(value: string): string {
  return /[",;\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A sheet to fill in: one row per image, numbered in the order given, with two example traits. */
export function sheetTemplate(fileNames: string[], traitTypes: string[] = ["Background", "Eyes"]): string {
  const header = ["tokenID", "name", "description", "file_name", "external_url", ...traitTypes.map((t) => `attributes[${t}]`)];
  const rows = (fileNames.length > 0 ? fileNames : ["1.png", "2.png", "3.png"]).map((file, i) =>
    [String(i + 1), "", "", file, "", ...traitTypes.map(() => "")]
  );
  return [header, ...rows].map((cells) => cells.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
