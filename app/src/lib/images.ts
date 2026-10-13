// Gets images ready to upload, with nothing but the picture in them. Photos
// often carry hidden details such as where they were taken, and uploads are
// public for good.
//
// Each chosen image is ready in two forms: compressed, small enough for free
// storage, and original, the file as it was chosen minus those details, for
// sellers who pay to store their art at full quality.
import { MAX_IMAGE_BYTES, MAX_ORIGINAL_BYTES } from "../config";

/** Still images only: animations (GIF, animated PNG or WebP) are not supported. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");

type Bytes = Uint8Array<ArrayBuffer>;

/** The original file as it would be uploaded, or why it cannot be. */
export type OriginalImage = { ok: true; size: number; type: string } | { ok: false; problem: string };

export type PreparedImage = {
  /** The file name it was chosen as. */
  name: string;
  /** The compressed image. */
  bytes: Bytes;
  type: string;
  /** The compressed image's size in pixels. */
  width: number;
  height: number;
  /** The original's size in pixels. */
  originalWidth: number;
  originalHeight: number;
  /** Whether it had to be made smaller than the original's dimensions. */
  shrunk: boolean;
  /** The chosen file, read again when the original is uploaded. */
  file: File;
  original: OriginalImage;
};

/** Larger images are scaled down to this before anything else. */
const MAX_DIMENSION = 2048;
/** Images with more pixels than this are refused rather than decoded. */
const MAX_PIXELS = 40_000_000;
const QUALITIES = [0.92, 0.82, 0.72, 0.62];
const SHRINK = 0.75;
const MIN_DIMENSION = 96;

let webp: boolean | null = null;
/** Whether this browser can write WebP (Safari could not until recently). */
function canWriteWebp(): boolean {
  if (webp === null) {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    webp = probe.toDataURL("image/webp").startsWith("data:image/webp");
  }
  return webp;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function draw(bitmap: ImageBitmap, width: number, height: number, background: string | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare images.");
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

function concat(parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Whether `bytes` holds the ASCII `text` at `offset`. */
function hasText(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** The image type the bytes really are, whatever the file name says. */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (hasText(bytes, 0, "RIFF") && hasText(bytes, 8, "WEBP")) return "image/webp";
  return null;
}

/**
 * PNG chunks that shape a still picture: pixels, palette, transparency, color
 * and scale. Animation chunks are dropped, so an animated PNG keeps only its
 * still image.
 */
const PNG_KEEP = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "cICP",
  "mDCv",
  "cLLi",
  "sBIT",
  "pHYs",
  "bKGD",
]);

/**
 * The same PNG without its text, date, EXIF and animation chunks (and
 * anything else that is not part of the still picture), so the pixels stay
 * exactly as they were.
 * Null if the bytes are not a well-formed PNG.
 */
export function stripPng(bytes: Uint8Array): Bytes | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (PNG_KEEP.has(type)) kept.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended) return null;
  return concat(kept);
}

// JPEG markers.
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const COM = 0xfe;

const isRestart = (marker: number) => marker >= 0xd0 && marker <= 0xd7;

/** The orientation (1 to 8) in a JPEG's EXIF block, if it gives one. */
function exifOrientation(payload: Uint8Array): number | null {
  if (!hasText(payload, 0, "Exif\0\0")) return null;
  const tiff = payload.subarray(6);
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, little) !== 42) return null;
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return null;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    // Tag 0x0112 is the orientation, stored as one SHORT.
    if (view.getUint16(entry, little) === 0x0112 && view.getUint16(entry + 2, little) === 3) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** An EXIF block (big-endian TIFF) holding nothing but an orientation. */
function orientationSegment(orientation: number): Bytes {
  return Uint8Array.of(
    0xff, APP1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM", 42, first directory at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // orientation, SHORT, 1 value
    0x00, 0x00, 0x00, 0x00 // no further directory
  );
}

/**
 * The same JPEG without its hidden details, so the picture stays exactly as
 * it was: EXIF (location, camera, date), XMP, comments, Photoshop and IPTC
 * data, thumbnails, and any further images stored after the first (as phones
 * do for depth maps). Kept: what decoding needs, the color profile and, when
 * the photo is rotated, a fresh EXIF block holding only its orientation.
 * Null if the bytes are not a well-formed JPEG.
 */
export function stripJpeg(bytes: Uint8Array): Bytes | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return null;
  const parts: Uint8Array[] = [];
  let jfif: Uint8Array | null = null;
  let orientation = 1;
  let offset = 2;
  for (;;) {
    // A marker is 0xFF and a code, possibly after more 0xFF fill bytes.
    if (offset >= bytes.length || bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === EOI) break;
    if (marker === 0x00 || marker === SOI) return null;
    if (isRestart(marker) || marker === 0x01) {
      parts.push(Uint8Array.of(0xff, marker));
      continue;
    }
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    const segment = bytes.subarray(offset - 2, offset + length);
    const payload = bytes.subarray(offset + 2, offset + length);
    offset += length;

    if (marker === SOS) {
      parts.push(segment);
      // The scan's data runs to the next marker that is not a restart; inside
      // it, 0xFF is always followed by 0x00.
      const start = offset;
      while (offset + 1 < bytes.length && !(bytes[offset] === 0xff && bytes[offset + 1] !== 0x00 && !isRestart(bytes[offset + 1]))) {
        offset++;
      }
      if (offset + 1 >= bytes.length) return null;
      parts.push(bytes.subarray(start, offset));
      continue;
    }
    if (marker === APP0) {
      // JFIF's header, without the thumbnail it may carry.
      if (hasText(payload, 0, "JFIF\0") && payload.length >= 14 && parts.length === 0 && !jfif) {
        jfif = concat([Uint8Array.of(0xff, APP0, 0x00, 0x10), payload.subarray(0, 12), Uint8Array.of(0, 0)]);
      }
      continue;
    }
    if (marker === APP1) {
      orientation = exifOrientation(payload) ?? orientation;
      continue;
    }
    if (marker === APP2) {
      if (hasText(payload, 0, "ICC_PROFILE\0")) parts.push(segment);
      continue;
    }
    if (marker === APP14) {
      // Adobe's block says how the colors are encoded.
      if (hasText(payload, 0, "Adobe")) parts.push(segment);
      continue;
    }
    if ((marker > APP0 && marker <= 0xef) || marker === COM) continue;
    // Everything else (tables, frame and scan headers) is needed to decode.
    parts.push(segment);
  }
  const head: Uint8Array[] = [Uint8Array.of(0xff, SOI)];
  if (jfif) head.push(jfif);
  if (orientation !== 1) head.push(orientationSegment(orientation));
  return concat([...head, ...parts, Uint8Array.of(0xff, EOI)]);
}

/** WebP's flags for EXIF and XMP blocks, in its extended header. */
const WEBP_EXIF_FLAG = 0x08;
const WEBP_XMP_FLAG = 0x04;
const WEBP_ANIMATION_FLAG = 0x02;

function littleEndian32(value: number): Bytes {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/**
 * The same WebP without its EXIF and XMP blocks (or anything else that is not
 * the picture), so the pixels stay exactly as they were. "animated" for an
 * animated WebP, null if the bytes are not a well-formed WebP.
 */
export function stripWebp(bytes: Uint8Array): Bytes | "animated" | null {
  if (bytes.length < 20 || !hasText(bytes, 0, "RIFF") || !hasText(bytes, 8, "WEBP")) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = 8 + view.getUint32(4, true);
  if (end > bytes.length || end < 20) return null;
  const kept: Uint8Array[] = [];
  let picture = false;
  let offset = 12;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset + 4, true);
    const dataEnd = offset + 8 + size;
    if (dataEnd > end) return null;
    // Chunks are padded to an even length.
    const chunk = bytes.subarray(offset, dataEnd);
    const padded = size % 2 === 1 ? concat([chunk, Uint8Array.of(0)]) : chunk;
    if (hasText(bytes, offset, "ANIM") || hasText(bytes, offset, "ANMF")) return "animated";
    if (hasText(bytes, offset, "VP8X")) {
      if (size < 10) return null;
      if (bytes[offset + 8] & WEBP_ANIMATION_FLAG) return "animated";
      const header = padded.slice();
      header[8] &= ~(WEBP_EXIF_FLAG | WEBP_XMP_FLAG);
      kept.push(header);
    } else if (hasText(bytes, offset, "VP8 ") || hasText(bytes, offset, "VP8L")) {
      picture = true;
      kept.push(padded);
    } else if (hasText(bytes, offset, "ALPH") || hasText(bytes, offset, "ICCP")) {
      kept.push(padded);
    }
    offset = dataEnd + (size % 2);
  }
  if (!picture) return null;
  const body = concat(kept);
  return concat([Uint8Array.of(0x52, 0x49, 0x46, 0x46), littleEndian32(4 + body.length), Uint8Array.of(0x57, 0x45, 0x42, 0x50), body]);
}

/**
 * An original image file without its hidden details, and its real type.
 * Throws with a reason, worded to follow the file's name, when it cannot be
 * kept as it is.
 */
export function stripOriginal(bytes: Uint8Array): { bytes: Bytes; type: string } {
  const type = sniffImageType(bytes);
  if (!type) throw new Error("is not a PNG, JPEG or WebP image");
  const kept = type === "image/png" ? stripPng(bytes) : type === "image/jpeg" ? stripJpeg(bytes) : stripWebp(bytes);
  if (kept === "animated") throw new Error("is animated; only still images can be kept as they are");
  if (!kept) throw new Error(`could not be read as a ${type === "image/png" ? "PNG" : type === "image/jpeg" ? "JPEG" : "WebP"} file`);
  if (kept.length > MAX_ORIGINAL_BYTES) throw new Error(`is over ${formatMb(MAX_ORIGINAL_BYTES)}`);
  return { bytes: kept, type };
}

/** Checks what an original would upload as: its size and type, or why it cannot be kept. */
async function describeOriginal(file: File, width: number, height: number): Promise<OriginalImage> {
  if (file.size > MAX_ORIGINAL_BYTES * 2) return { ok: false, problem: `is over ${formatMb(MAX_ORIGINAL_BYTES)}` };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kept = stripOriginal(bytes);
    // Make sure what is left still opens as the same picture.
    if (kept.bytes.length !== bytes.length) {
      const check = await createImageBitmap(new Blob([kept.bytes], { type: kept.type }));
      const same = check.width === width && check.height === height;
      check.close();
      if (!same) return { ok: false, problem: "could not be kept as it is" };
    }
    return { ok: true, size: kept.bytes.length, type: kept.type };
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : "could not be read" };
  }
}

/** Reads an original again for upload, checking it is the file that was chosen. */
export async function loadOriginal(image: PreparedImage): Promise<{ bytes: Bytes; type: string }> {
  if (!image.original.ok) throw new Error(`${image.name} ${image.original.problem}.`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await image.file.arrayBuffer());
  } catch {
    throw new Error(`${image.name} could not be read again. Choose it again.`);
  }
  const kept = stripOriginal(bytes);
  if (kept.bytes.length !== image.original.size || kept.type !== image.original.type) {
    throw new Error(`${image.name} changed after you chose it. Choose it again.`);
  }
  return kept;
}

export function formatKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** A file size in KB below a megabyte, in MB or GB above. */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return formatKb(bytes);
  if (bytes < 1024 * 1024 * 1024) return formatMb(bytes);
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Reads a PNG, JPEG or WebP file and gets it ready to upload: its original,
 * kept as it is minus hidden details, and a compressed still image at most
 * `maxBytes` long. A PNG that fits keeps its exact pixels, minus its text,
 * date, EXIF and animation chunks. Everything else is redrawn, which leaves
 * such details (and any animation) behind: as a PNG if that fits, otherwise
 * as WebP (JPEG on browsers that cannot write WebP) at falling quality and
 * then falling size until it fits.
 */
export async function prepareImage(file: File, maxBytes = MAX_IMAGE_BYTES): Promise<PreparedImage> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error(`${file.name} is not a PNG, JPEG or WebP image.`);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} could not be read as an image.`);
  }
  try {
    const { width, height } = bitmap;
    if (width * height > MAX_PIXELS) throw new Error(`${file.name} is too large (${width}×${height} pixels).`);
    const original = await describeOriginal(file, width, height);
    const base = { name: file.name, width, height, originalWidth: width, originalHeight: height, shrunk: false, file, original };

    // A small enough PNG keeps its exact pixels; only its other chunks go.
    if (file.type === "image/png" && file.size <= maxBytes) {
      const stripped = stripPng(new Uint8Array(await file.arrayBuffer()));
      if (stripped) return { ...base, bytes: stripped, type: "image/png" };
    }

    let scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    const lossy = canWriteWebp() ? "image/webp" : "image/jpeg";
    for (;;) {
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const shrunk = w < width || h < height;
      // A PNG redrawn at its own size loses nothing, so try that first.
      if (file.type === "image/png") {
        const canvas = draw(bitmap, w, h, null);
        const png = await toBlob(canvas, "image/png");
        if (png && png.size <= maxBytes) {
          return { ...base, width: w, height: h, shrunk, bytes: new Uint8Array(await png.arrayBuffer()), type: "image/png" };
        }
      }
      // JPEG has no transparency, so transparent parts turn white rather than black.
      const canvas = draw(bitmap, w, h, lossy === "image/jpeg" ? "#ffffff" : null);
      for (const quality of QUALITIES) {
        const blob = await toBlob(canvas, lossy, quality);
        if (blob && blob.size <= maxBytes) {
          return { ...base, width: w, height: h, shrunk, bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type || lossy };
        }
      }
      if (Math.max(w, h) * SHRINK < MIN_DIMENSION) break;
      scale *= SHRINK;
    }
    throw new Error(`${file.name} could not be made small enough to upload.`);
  } finally {
    bitmap.close();
  }
}

/** Sorts files the way people number them: "2.png" before "10.png". */
export function byFileName<T extends { name: string }>(files: T[]): T[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...files].sort((a, b) => collator.compare(a.name, b.name));
}
