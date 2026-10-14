// Gets images ready to upload, with nothing but the picture in them. Photos
// often carry hidden details such as where they were taken, and uploads are
// public for good.
//
// Each chosen image is ready in two forms: compressed, small enough for free
// storage, and original, the file as it was chosen minus those details, for
// sellers who pay to store their art at full quality.
//
// The work itself (`imageCore.ts`) runs in a small pool of Web Workers
// (`imageWorker.ts`), a few images at a time, so that preparing a large
// collection keeps the page responsive and uses more than one core. Where
// workers cannot draw (no OffscreenCanvas), it runs on the page as before.
import { MAX_IMAGE_BYTES, MAX_ORIGINAL_BYTES } from "../config";
import { type ImageLimits, IMAGE_TYPES, NoCanvasError, type ProcessedImage, formatMb, processImage, stripOriginal } from "./imageCore";
import type { ImageJob, ImageReply } from "./imageWorker";

export { IMAGE_TYPES, type OriginalImage, formatMb, sniffImageType, stripJpeg, stripOriginal, stripPng, stripWebp } from "./imageCore";
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");

type Bytes = Uint8Array<ArrayBuffer>;

export type PreparedImage = ProcessedImage & {
  /** The file name it was chosen as. */
  name: string;
  /** The chosen file, read again when the original is uploaded. */
  file: File;
};

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

type Task = {
  job: ImageJob;
  resolve: (image: ProcessedImage) => void;
  reject: (error: Error) => void;
};
type Slot = { worker: Worker; task: Task | null };

/** Workers stop after this long without work, to give their memory back. */
const IDLE_MS = 30_000;
/**
 * Each worker holds about one decoded image at a time; a few use the cores
 * without using too much memory. The page itself only waits while they work,
 * so they can have every core.
 */
const MAX_WORKERS = 4;

let slots: Slot[] | null = null;
/** Set once workers turn out not to work here; everything then runs on the page. */
let workersUnusable = false;
const queue: Task[] = [];
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Development only: `?noworkers` prepares everything on the page, to compare. */
const forceMainThread =
  import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("noworkers");

/** Development only: `?workers=N` sets how many workers run, to measure. */
const forcedWorkers =
  import.meta.env.DEV && typeof location !== "undefined" ? Number(new URLSearchParams(location.search).get("workers")) || 0 : 0;

function workerCount(): number {
  if (forcedWorkers > 0) return Math.min(forcedWorkers, 16);
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores));
}

function startWorkers(): Slot[] | null {
  if (workersUnusable || forceMainThread || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return null;
  }
  if (slots) return slots;
  try {
    slots = Array.from({ length: workerCount() }, () => {
      const slot: Slot = { worker: new Worker(new URL("./imageWorker.ts", import.meta.url), { type: "module" }), task: null };
      slot.worker.onmessage = (event: MessageEvent<ImageReply>) => finish(slot, event.data);
      slot.worker.onerror = (event) => {
        event.preventDefault();
        giveUpOnWorkers();
      };
      return slot;
    });
  } catch {
    workersUnusable = true;
    slots = null;
  }
  return slots;
}

/** Stops the workers and moves their work, and everything queued, onto the page. */
function giveUpOnWorkers() {
  workersUnusable = true;
  const stranded = (slots ?? []).flatMap((slot) => (slot.task ? [slot.task] : []));
  for (const slot of slots ?? []) slot.worker.terminate();
  slots = null;
  for (const task of [...stranded, ...queue.splice(0)]) runOnPage(task);
}

function finish(slot: Slot, reply: ImageReply) {
  const task = slot.task;
  slot.task = null;
  if (task) {
    if (reply.ok) task.resolve(reply.result);
    else if (reply.noCanvas) {
      // This browser's workers cannot draw: do this one, and the rest, on the page.
      queue.unshift(task);
      giveUpOnWorkers();
      return;
    } else task.reject(new Error(reply.error));
  }
  pump();
}

function pump() {
  if (!slots) return;
  for (const slot of slots) {
    if (slot.task || queue.length === 0) continue;
    const task = queue.shift()!;
    slot.task = task;
    slot.worker.postMessage(task.job);
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (slots.every((slot) => !slot.task) && queue.length === 0) {
    idleTimer = setTimeout(() => {
      if (slots && slots.every((slot) => !slot.task) && queue.length === 0) {
        for (const slot of slots) slot.worker.terminate();
        slots = null;
      }
    }, IDLE_MS);
  }
}

/** Work done on the page runs one image at a time, each awaiting the browser's encoder. */
let pageChain: Promise<unknown> = Promise.resolve();

function onPage(file: File, limits: ImageLimits): Promise<ProcessedImage> {
  const run = pageChain.then(() => processImage(file, limits));
  pageChain = run.catch(() => undefined);
  return run.catch((e) => {
    throw e instanceof NoCanvasError ? new Error(e.message) : e;
  });
}

function runOnPage(task: Task) {
  onPage(task.job.file, task.job.limits).then(task.resolve, task.reject);
}

/** Prepares one image in the pool, or on the page where workers cannot. */
function process(file: File, limits: ImageLimits): Promise<ProcessedImage> {
  if (!startWorkers()) return onPage(file, limits);
  return new Promise((resolve, reject) => {
    queue.push({ job: { file, limits }, resolve, reject });
    pump();
  });
}

const LIMITS: ImageLimits = { maxBytes: MAX_IMAGE_BYTES, maxOriginalBytes: MAX_ORIGINAL_BYTES };

/**
 * Reads a PNG, JPEG or WebP file and gets it ready to upload: its original,
 * kept as it is minus hidden details, and a compressed still image at most
 * `maxBytes` long (see `processImage`).
 */
export async function prepareImage(file: File, maxBytes = MAX_IMAGE_BYTES): Promise<PreparedImage> {
  const result = await process(file, { ...LIMITS, maxBytes });
  return { ...result, name: file.name, file };
}

/** What became of each file of a set, in the order given. */
export type PreparedSet = { images: PreparedImage[]; failed: { name: string; error: string }[] };

/**
 * Prepares many images at once across the worker pool, keeping their order.
 * `onProgress` hears how many are done, at most every 100 ms and at the end,
 * so a large set does not flood the page with updates.
 */
export async function prepareImages(files: File[], onProgress?: (done: number, total: number) => void): Promise<PreparedSet> {
  let done = 0;
  let last = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (onProgress && (force || now - last >= 100)) {
      last = now;
      onProgress(done, files.length);
    }
  };
  report(true);
  const settled = await Promise.allSettled(
    files.map((file) =>
      prepareImage(file).finally(() => {
        done++;
        report(done === files.length);
      })
    )
  );
  const images: PreparedImage[] = [];
  const failed: PreparedSet["failed"] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") images.push(outcome.value);
    else failed.push({ name: files[i].name, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  });
  return { images, failed };
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
  const kept = stripOriginal(bytes, MAX_ORIGINAL_BYTES);
  if (kept.bytes.length !== image.original.size || kept.type !== image.original.type) {
    throw new Error(`${image.name} changed after you chose it. Choose it again.`);
  }
  return kept;
}

export function formatKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A file size in KB below a megabyte, in MB or GB above. */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return formatKb(bytes);
  if (bytes < 1024 * 1024 * 1024) return formatMb(bytes);
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Sorts files the way people number them: "2.png" before "10.png". */
export function byFileName<T extends { name: string }>(files: T[]): T[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...files].sort((a, b) => collator.compare(a.name, b.name));
}
