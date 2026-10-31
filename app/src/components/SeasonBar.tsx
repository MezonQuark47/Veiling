import { useState } from "react";
import { SEASON } from "../config";
import { nowSecs } from "../lib/format";

const KEY = "veiling:season-bar";

/** A thin line under the header while a season runs, pointing to its page. */
export function SeasonBar({ route }: { route: string }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return typeof sessionStorage !== "undefined" && sessionStorage.getItem(KEY) === SEASON?.name;
    } catch {
      return false;
    }
  });
  const now = nowSecs();
  if (!SEASON || hidden || route.startsWith("season") || route.startsWith("invite") || now < SEASON.start - 7 * 86_400 || now >= SEASON.end) return null;
  const days = Math.ceil((SEASON.end - now) / 86_400);
  const live = now >= SEASON.start;
  return (
    <div className="season-bar">
      <a href="#/season" className="season-bar__link">
        <span className="season-bar__dot" aria-hidden="true" />
        <strong>{SEASON.name}</strong>
        <span>
          {live
            ? `is live: try Veiling with free test SOL and earn points. ${days} ${days === 1 ? "day" : "days"} left.`
            : "starts soon: try Veiling with free test SOL and earn points."}
        </span>
        <span className="season-bar__go">Join →</span>
      </a>
      <button
        type="button"
        className="season-bar__close"
        aria-label="Hide"
        onClick={() => {
          setHidden(true);
          try {
            sessionStorage.setItem(KEY, SEASON?.name ?? "");
          } catch {
            // Hidden for this page view only.
          }
        }}
      >
        ×
      </button>
    </div>
  );
}
