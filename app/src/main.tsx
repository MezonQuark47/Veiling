import "./polyfills";
import "@fontsource-variable/funnel-sans";
import "@fontsource-variable/funnel-display";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WalletProvider } from "./lib/wallet";
import { pruneNotes } from "./lib/notes";
import { initAnalytics } from "./lib/analytics";
import { captureInvite } from "./lib/keeper";
import { upgradeOldLink } from "./lib/router";

// Bid notes are a short-lived convenience; drop the ones that have expired.
pruneNotes();
// Old links (/#/auctions) open at their new address (/auctions).
upgradeOldLink();
// An invite link's wallet is kept until the visitor connects theirs.
captureInvite();
initAnalytics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </StrictMode>
);
