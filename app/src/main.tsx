import "./polyfills";
import "@fontsource-variable/funnel-sans";
import "@fontsource-variable/funnel-display";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WalletProvider } from "./lib/wallet";
import { pruneNotes } from "./lib/notes";

// Bid notes are a short-lived convenience; drop the ones that have expired.
pruneNotes();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </StrictMode>
);
