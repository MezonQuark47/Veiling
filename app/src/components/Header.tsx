import { useEffect, useRef, useState } from "react";
import { NETWORK_LABEL } from "../config";
import { shortAddress } from "../lib/format";
import { CONNECT_EVENT, useWallet } from "../lib/wallet";
import { errorMessage } from "../lib/tx";

/**
 * A sealed bid seen from above, the clearing price drawn in light under it,
 * and the refunded layer below.
 */
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 34 34" aria-hidden="true">
      <path d="M17 3 30 10.5 17 18 4 10.5Z" className="logo__plate" />
      <path d="M4 17.5 17 25 30 17.5" className="logo__line" />
      <path d="M4 23.5 17 31 30 23.5" className="logo__line logo__line--out" />
    </svg>
  );
}

export function Header({ route }: { route: string }) {
  const { wallets, wallet, publicKey, connect, disconnect, connecting } = useWallet();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // A "Connect wallet" button elsewhere on the page opens this menu.
  useEffect(() => {
    const show = () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
      setOpen(true);
    };
    window.addEventListener(CONNECT_EVENT, show);
    return () => window.removeEventListener(CONNECT_EVENT, show);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const link = (href: string, label: string, match: (r: string) => boolean) => (
    <a href={href} className={`nav__link${match(route) ? " nav__link--active" : ""}`} aria-current={match(route) ? "page" : undefined}>
      {label}
    </a>
  );

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <a href="#/" className="brand" aria-label="Veiling home">
          <Logo />
          <span className="brand__name">Veiling</span>
        </a>
        <nav className="nav" aria-label="Main">
          {link("#/auctions", "Auctions", (r) => r.startsWith("auction"))}
          {link("#/launch", "Launch", (r) => r.startsWith("launch"))}
          {link("#/bids", "My bids", (r) => r.startsWith("bids"))}
          {/* A real path, so crawlers find the docs from every page. */}
          {link("/docs/", "Docs", (r) => r.startsWith("docs"))}
        </nav>
        <div className="topbar__end">
          {NETWORK_LABEL ? (
            <span className="network" title="Test network: SOL and tokens here have no real value.">
              {NETWORK_LABEL}
            </span>
          ) : null}
          <div className="wallet" ref={menuRef}>
            <button
              className={`btn ${publicKey ? "btn--secondary" : "btn--primary"}`}
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-haspopup="menu"
              disabled={connecting}
            >
              {publicKey ? shortAddress(publicKey.toBase58()) : connecting ? "Connecting…" : "Connect wallet"}
            </button>
            {open ? (
              <div className="menu" role="menu">
                {publicKey ? (
                  <>
                    <p className="menu__note">
                      Connected with {wallet?.name}.{NETWORK_LABEL ? ` Use it on ${NETWORK_LABEL}.` : ""}
                    </p>
                    <button
                      className="menu__item"
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        void disconnect();
                      }}
                    >
                      Disconnect
                    </button>
                  </>
                ) : wallets.length === 0 ? (
                  <p className="menu__note">
                    No Solana wallet found in this browser. Install{" "}
                    <a href="https://phantom.com/download" target="_blank" rel="noreferrer noopener">
                      Phantom
                    </a>{" "}
                    or{" "}
                    <a href="https://solflare.com/download" target="_blank" rel="noreferrer noopener">
                      Solflare
                    </a>
                    , then reload this page.
                  </p>
                ) : (
                  wallets.map((w) => (
                    <button
                      key={w.name}
                      className="menu__item"
                      role="menuitem"
                      onClick={async () => {
                        setError(null);
                        try {
                          await connect(w);
                          setOpen(false);
                        } catch (e) {
                          setError(errorMessage(e));
                        }
                      }}
                    >
                      <img src={w.icon} alt="" width={20} height={20} />
                      {w.name}
                    </button>
                  ))
                )}
                {error ? <p className="menu__error">{error}</p> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}
