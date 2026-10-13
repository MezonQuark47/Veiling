import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const shim = (file: string) => fileURLToPath(new URL(`./src/shims/${file}`, import.meta.url));
const anchorShim = shim("anchor.js");
const fromArcium = (importer?: string) => Boolean(importer && importer.includes("@arcium-hq/client"));

/** Gives @arcium-hq/client the default Anchor export it expects. */
function anchorDefaultExport(): Plugin {
  return {
    name: "anchor-default-export",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@anchor-lang/core" && fromArcium(importer)) return anchorShim;
      return null;
    },
  };
}

// @arcium-hq/client also imports Node's `crypto` and `fs`. The app only uses
// the parts that need SHA-256 and secure randomness, which the shims provide
// with audited browser code; everything else in them throws.
export default defineConfig({
  plugins: [react(), anchorDefaultExport()],
  resolve: {
    alias: {
      crypto: shim("crypto.ts"),
      fs: shim("fs.ts"),
    },
  },
  define: {
    global: "globalThis",
  },
  optimizeDeps: {
    esbuildOptions: {
      define: { global: "globalThis" },
      plugins: [
        {
          name: "anchor-default-export",
          setup(build) {
            build.onResolve({ filter: /^@anchor-lang\/core$/ }, (args) =>
              fromArcium(args.importer) ? { path: anchorShim } : undefined
            );
          },
        },
      ],
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2500,
  },
});
