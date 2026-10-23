// Renders the pages search and AI crawlers read into static HTML at build
// time (`scripts/prerender.mjs`). Most of those crawlers do not run
// JavaScript, so without this they would see an empty page. In the browser
// the app replaces this HTML as soon as it starts.
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { App } from "./App";
import { seedLoader } from "./components/ui";
import { fetchCrankRewards, fetchFeeConfig } from "./lib/chain";
import { WalletProvider } from "./lib/wallet";
import { FAQ } from "./pages/Docs";

/** Loads the platform's fees once, so the static pages show them. */
export async function loadLiveData(): Promise<{ fees: boolean; crank: boolean }> {
  const fees = await fetchFeeConfig().catch(() => null);
  const crank = await fetchCrankRewards().catch(() => null);
  if (fees) seedLoader(fetchFeeConfig, fees);
  if (crank) seedLoader(fetchCrankRewards, crank);
  return { fees: Boolean(fees), crank: Boolean(crank) };
}

/** A page of the app as HTML, for the route it would have in the browser ("" or "docs"). */
export function render(route: string): string {
  return renderToString(
    <StrictMode>
      <WalletProvider>
        <App route={route} />
      </WalletProvider>
    </StrictMode>
  );
}

/** The docs' questions and answers, as plain text, for the FAQ structured data. */
export async function faq(): Promise<{ question: string; answer: string }[]> {
  const fees = await fetchFeeConfig().catch(() => null);
  return FAQ(fees).map(({ question, answer }) => ({ question, answer }));
}
