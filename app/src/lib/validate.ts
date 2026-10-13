// Mirrors the program's checks on collection details, so problems show up
// before the wallet is asked to sign.

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Control characters and invisible or text-direction characters. */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/;

/** Non-blank text of at most `maxBytes` bytes without hidden characters. */
export function isDisplayText(text: string, maxBytes: number): boolean {
  return text.trim().length > 0 && bytes(text) <= maxBytes && !HIDDEN.test(text);
}

export const METADATA_SCHEMES = ["https://", "ipfs://", "ar://"];

/** An https, ipfs or ar link of at most `maxBytes` bytes without spaces. */
export function isMetadataUri(uri: string, maxBytes: number): boolean {
  return (
    bytes(uri) <= maxBytes &&
    METADATA_SCHEMES.some((scheme) => uri.length > scheme.length && uri.startsWith(scheme)) &&
    !/[\s\u0085 ]/.test(uri) &&
    !HIDDEN.test(uri)
  );
}

export function byteLength(text: string): number {
  return bytes(text);
}
