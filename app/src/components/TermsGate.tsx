import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { regionList } from "../pages/Legal";
import { track } from "../lib/analytics";
import { acceptTerms } from "../lib/terms";

/**
 * Asked once before a wallet connects (and again when the terms change):
 * age, where the visitor is, and the terms and risks.
 */
export function TermsGate({ onAccept, onCancel, cancelLabel = "Cancel" }: { onAccept: () => void; onCancel: () => void; cancelLabel?: string }) {
  const [checks, setChecks] = useState([false, false, false]);
  const dialog = useRef<HTMLDivElement>(null);
  const all = checks.every(Boolean);
  useEffect(() => {
    dialog.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", esc);
    document.body.classList.add("is-modal");
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.classList.remove("is-modal");
    };
  }, [onCancel]);
  const items = [
    "I am 18 or older.",
    `I am not a resident of, or located in, ${regionList()}.`,
    null,
  ];
  return createPortal(
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal__box terms-gate" role="dialog" aria-modal="true" aria-labelledby="terms-title" tabIndex={-1} ref={dialog}>
        <h2 id="terms-title" className="modal__title">
          Before you connect
        </h2>
        <p className="modal__text">Veiling is for people who can use it legally. Please confirm:</p>
        <ul className="terms-gate__list">
          {items.map((text, i) => (
            <li key={i}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={checks[i]}
                  onChange={(e) => setChecks((c) => c.map((v, k) => (k === i ? e.target.checked : v)))}
                />
                <span>
                  {text ?? (
                    <>
                      I have read and agree to the{" "}
                      <a href="#/terms" target="_blank" rel="noopener">
                        Terms of Use
                      </a>{" "}
                      and the{" "}
                      <a href="#/risks" target="_blank" rel="noopener">
                        Risk disclosure
                      </a>
                      , and I understand I can lose what I put in.
                    </>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!all}
            onClick={() => {
              acceptTerms();
              track("Terms accepted");
              onAccept();
            }}
          >
            Agree and continue
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
