// Prepares images off the page, one at a time, so that choosing thousands of
// them does not freeze it. See `images.ts` for the pool that drives these.
import { type ImageLimits, NoCanvasError, processImage } from "./imageCore";

/** A job: one file and the limits it must fit. */
export type ImageJob = { file: File; limits: ImageLimits };
/** The answer: the prepared image, why it could not be, or that this worker cannot draw at all. */
export type ImageReply =
  | { ok: true; result: Awaited<ReturnType<typeof processImage>> }
  | { ok: false; error: string; noCanvas: boolean };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ImageJob>) => void) | null;
  postMessage(message: ImageReply, transfer?: Transferable[]): void;
};

scope.onmessage = async (event) => {
  const { file, limits } = event.data;
  try {
    const result = await processImage(file, limits);
    // The compressed bytes move to the page instead of being copied.
    scope.postMessage({ ok: true, result }, [result.bytes.buffer]);
  } catch (e) {
    scope.postMessage({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      noCanvas: e instanceof NoCanvasError,
    });
  }
};
