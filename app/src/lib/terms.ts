import { TERMS_VERSION } from "../config";

/**
 * Whether this browser agreed to the current terms (Terms of Use, Risk
 * disclosure and the restricted regions) before connecting a wallet.
 */
const KEY = "veiling:terms";
export const TERMS_EVENT = "veiling:terms";
/** Kept here too, for browsers without storage, so they are not asked again and again. */
let acceptedNow = false;

export function termsAccepted(): boolean {
  if (acceptedNow) return true;
  try {
    return localStorage.getItem(KEY) === TERMS_VERSION;
  } catch {
    return false;
  }
}

export function acceptTerms() {
  acceptedNow = true;
  try {
    localStorage.setItem(KEY, TERMS_VERSION);
  } catch {
    // Remembered for this visit only.
  }
  window.dispatchEvent(new Event(TERMS_EVENT));
}
