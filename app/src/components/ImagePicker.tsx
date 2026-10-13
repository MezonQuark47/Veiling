import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { formatCount } from "../lib/format";
import { IMAGE_ACCEPT, type PreparedImage, byFileName, formatKb, formatSize, prepareImage } from "../lib/images";

/** A temporary link to an image's bytes, for previews; released when no longer shown. */
export function useImageUrl(image: PreparedImage | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image) {
      setUrl(null);
      return;
    }
    const link = URL.createObjectURL(new Blob([image.bytes], { type: image.type }));
    setUrl(link);
    return () => URL.revokeObjectURL(link);
  }, [image]);
  return url;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Small images, such as pixel art, are enlarged with hard edges rather than blurred. */
export const isSmallImage = (image: PreparedImage | null) => Boolean(image && Math.max(image.width, image.height) < 128);

function Thumb({ image, caption }: { image: PreparedImage | null; caption?: string }) {
  const url = useImageUrl(image);
  return (
    <span className="picker__thumb">
      {url ? (
        <img src={url} alt="" className={isSmallImage(image) ? "picker__img--pixels" : undefined} />
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <circle cx="9" cy="10" r="1.75" />
          <path d="M4 17.5l5-5 3.5 3.5 2.5-2.5 5 5" />
        </svg>
      )}
      {caption ? <span className="picker__caption">{caption}</span> : null}
    </span>
  );
}

function useDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      },
    },
  };
}

function Actions({ id, label, chosen, multiple, onFiles, onClear, children }: {
  id: string;
  label: string;
  chosen: boolean;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  onClear: () => void;
  children?: ReactNode;
}) {
  return (
    <span className="picker__actions">
      <input
        id={id}
        className="sr-only"
        type="file"
        accept={IMAGE_ACCEPT}
        multiple={multiple}
        aria-label={label}
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <label htmlFor={id} className="btn btn--secondary picker__choose" aria-hidden="true">
        {chosen ? "Change" : multiple ? "Choose images" : "Choose image"}
      </label>
      {chosen ? (
        <button type="button" className="btn btn--quiet" onClick={onClear}>
          Remove
        </button>
      ) : null}
      {children}
    </span>
  );
}

/** Picks one image and gets it ready to upload. */
export function ImagePicker({
  id,
  label,
  value,
  onChange,
  showOriginal = false,
}: {
  id: string;
  label: string;
  value: PreparedImage | null;
  onChange: (image: PreparedImage | null) => void;
  /** Also give the original file's size, where originals can be stored. */
  showOriginal?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await prepareImage(files[0]));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const drop = useDrop(choose);
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className={`picker${drop.over ? " picker--over" : ""}`} {...drop.handlers}>
        <Thumb image={value} />
        <span className="picker__body">
          {busy ? (
            <span className="picker__meta">Preparing the image…</span>
          ) : value ? (
            <>
              <span className="picker__name">{value.name}</span>
              <span className="picker__meta">
                {value.width} × {value.height}.{" "}
                {showOriginal && value.original.ok ? `${formatSize(value.original.size)} as it is, ` : ""}
                {formatKb(value.bytes.length)} compressed{value.shrunk ? ", made smaller to fit" : ""}.
              </span>
            </>
          ) : (
            <span className="picker__meta">PNG, JPEG or WebP. Drop it here or choose a file.</span>
          )}
          <Actions id={id} label={label} chosen={Boolean(value)} onFiles={choose} onClear={() => onChange(null)} />
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

const STRIP = 6;

/** Picks one image per NFT, numbered in file-name order. */
export function ImageSetPicker({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: PreparedImage[];
  onChange: (images: PreparedImage[]) => void;
}) {
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (files: File[]) => {
    if (files.length === 0) return;
    const sorted = byFileName(files);
    setError(null);
    const prepared: PreparedImage[] = [];
    const failed: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
      setProgress([i, sorted.length]);
      try {
        prepared.push(await prepareImage(sorted[i]));
      } catch (e) {
        failed.push(message(e));
      }
    }
    setProgress(null);
    if (failed.length > 0) {
      setError(
        failed.length === 1 ? failed[0] : `${formatCount(failed.length)} files could not be used. The first: ${failed[0]}`
      );
      return;
    }
    onChange(prepared);
  };
  const drop = useDrop(choose);
  const total = value.reduce((sum, image) => sum + image.bytes.length, 0);
  const originals = value.every((image) => image.original.ok)
    ? value.reduce((sum, image) => sum + (image.original.ok ? image.original.size : 0), 0)
    : null;
  const last = value.length - 1;
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className={`picker picker--set${drop.over ? " picker--over" : ""}`} {...drop.handlers}>
        {value.length > 0 ? (
          <span className="picker__strip">
            {value.slice(0, STRIP).map((image, i) => (
              <Thumb key={i} image={image} caption={`#${i + 1}`} />
            ))}
            {value.length > STRIP ? <span className="picker__more">+{formatCount(value.length - STRIP)}</span> : null}
          </span>
        ) : (
          <Thumb image={null} />
        )}
        <span className="picker__body">
          {progress ? (
            <span className="picker__meta">
              Preparing {formatCount(progress[0] + 1)} of {formatCount(progress[1])}…
            </span>
          ) : value.length > 0 ? (
            <span className="picker__meta">
              {formatCount(value.length)} {value.length === 1 ? "image" : "images"}:{" "}
              {originals !== null ? `${formatSize(originals)} as they are, ` : ""}
              {formatSize(total)} compressed. #1 is {value[0].name}
              {last > 0 ? `, #${last + 1} is ${value[last].name}` : ""}.
            </span>
          ) : (
            <span className="picker__meta">
              PNG, JPEG or WebP. Select them all at once, or drop them here.
            </span>
          )}
          <Actions
            id={id}
            label={label}
            chosen={value.length > 0}
            multiple
            onFiles={choose}
            onClear={() => onChange([])}
          />
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
