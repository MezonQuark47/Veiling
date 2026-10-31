// Runs after `vite build`. Most search and AI crawlers (ChatGPT's
// OAI-SearchBot, Claude, Perplexity) do not run JavaScript, so a page that
// only fills itself in the browser looks empty to them. This script renders
// the front page and the docs into static HTML, and writes the files crawlers
// look for: robots.txt, sitemap.xml, llms.txt and llms-full.txt.
//
//   SITE_URL=https://veiling.example npm run build
//
// SITE_URL is the site's public address. Without it the pages still render,
// but the sitemap, canonical links and absolute URLs are left out.
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(app, "dist");
const work = join(app, "dist-ssr");
const SITE = (process.env.SITE_URL ?? "").trim().replace(/\/+$/, "");
const url = (path) => (SITE ? `${SITE}${path}` : path);
const today = new Date().toISOString().slice(0, 10);

const NAME = "Veiling";
const PAGES = [
  {
    route: "",
    file: "index.html",
    path: "/",
    title: "Veiling, future of launchpads · Private bids. Public price.",
    description:
      "Veiling sells new tokens and NFT collections on Solana by sealed-bid auction. Bids stay private, every winner pays one final price, and a new token is made only if its sale sells out.",
  },
  {
    route: "docs",
    file: "docs/index.html",
    path: "/docs/",
    title: "How Veiling works · Sealed-bid auctions on Solana",
    description:
      "How Veiling's sealed-bid auctions work: bidding, the final price, new token launches with a locked Meteora pool, NFT drops and collections, fees, privacy and refunds.",
  },
  {
    // Invite links (/invite/?ref=<X name or wallet>) open here: on X they show
    // their own card, then the app takes the visitor to Season 0.
    route: "invite",
    file: "invite/index.html",
    path: "/invite/",
    title: "You're invited to Veiling Season 0",
    description:
      "Join Veiling's Season 0: bid in sealed-bid launches on Solana, launch your own and invite friends to earn points. Bids stay hidden and every winner pays one fair price.",
    image: "/og-invite.png",
    imageAlt: "You're invited to Veiling Season 0. Sealed-bid launches on Solana.",
    noindex: true,
  },
];

// ---------------------------------------------------------------------------
// Render the app's pages ahead of time.

await rm(work, { recursive: true, force: true });
await build({
  entryPoints: [join(app, "src/prerender.tsx")],
  outfile: join(work, "prerender.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  define: {
    "import.meta.env.DEV": "false",
    "import.meta.env.VITE_RPC_URL": "undefined",
    "import.meta.env.VITE_STATS_URL": "undefined",
    "import.meta.env.VITE_PLAUSIBLE_DOMAIN": "undefined",
    "import.meta.env.VITE_PLAUSIBLE_SRC": "undefined",
    "import.meta.env.VITE_SENTRY_DSN": "undefined",
  },
  // Some dependencies are CommonJS and expect these.
  banner: {
    js: [
      "import { createRequire } from 'node:module';",
      "import { fileURLToPath as __toPath } from 'node:url';",
      "const require = createRequire(import.meta.url);",
      "const __filename = __toPath(import.meta.url);",
      "const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));",
    ].join(" "),
  },
  logLevel: "error",
});
const ssr = await import(pathToFileURL(join(work, "prerender.mjs")).href);

// The fees come from the chain; a page without them says "…" in their place.
const live = await Promise.race([
  ssr.loadLiveData(),
  new Promise((resolve) => setTimeout(() => resolve({ fees: false, crank: false }), 20_000)),
]);
if (!live.fees || !live.crank) console.warn("prerender: the platform's fees could not be loaded; the static pages leave them out.");
const faq = await ssr.faq();

const escape = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

function structuredData(page) {
  if (page.route === "docs") {
    return [
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faq.map(({ question, answer }) => ({
          "@type": "Question",
          name: question,
          acceptedAnswer: { "@type": "Answer", text: answer },
        })),
      },
    ];
  }
  const site = SITE ? { url: url("/") } : {};
  return [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: NAME,
      ...site,
      ...(SITE ? { logo: url("/favicon.svg") } : {}),
      sameAs: [ssr.GITHUB_URL, ssr.PROJECT_X_URL].filter(Boolean),
    },
    { "@context": "https://schema.org", "@type": "WebSite", name: NAME, description: page.description, ...site },
    {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: NAME,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      description: page.description,
      ...site,
    },
  ];
}

const shell = await readFile(join(dist, "index.html"), "utf8");
if (!shell.includes('<div id="root"></div>')) throw new Error("prerender: dist/index.html is already filled in; run vite build first (npm run build does both)");
const rendered = {};

for (const page of PAGES) {
  const body = ssr.render(page.route);
  rendered[page.route] = body;
  const head = [
    `<link rel="canonical" href="${escape(url(page.path))}" />`,
    `<meta property="og:url" content="${escape(url(page.path))}" />`,
  ].filter(() => SITE);
  const html = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${escape(page.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escape(page.description)}" />`)
    .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${escape(page.title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${escape(page.description)}" />`)
    // Link previews need the image's full address (public/og.png, or the page's own).
    .replaceAll('content="/og.png"', `content="${escape(url(page.image ?? "/og.png"))}"`)
    .replace(/<meta property="og:image:alt" content="[^"]*" \/>/, (tag) =>
      page.imageAlt ? `<meta property="og:image:alt" content="${escape(page.imageAlt)}" />` : tag
    )
    .replace("</head>", page.noindex ? '<meta name="robots" content="noindex" />\n  </head>' : "</head>")
    .replace("</head>", `${[...head, ...structuredData(page).map(jsonLd)].join("\n    ")}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${body}</div>`);
  await mkdir(dirname(join(dist, page.file)), { recursive: true });
  await writeFile(join(dist, page.file), html);
}

// ---------------------------------------------------------------------------
// The docs as Markdown, for llms-full.txt.

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#x27": "'", "#39": "'" };
const decode = (text) => text.replace(/&(#x27|#39|amp|lt|gt|quot|apos|nbsp);/g, (_, e) => entities[e]);
const inline = (html) =>
  decode(
    html
      .replace(/<!-- -->/g, "")
      .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g, (_, href, text) => `[${text}](${href.startsWith("#/docs/") ? url("/docs/") : href})`)
      .replace(/<\/?strong>/g, "**")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\s+/g, " ")
    .trim();

function markdown(html) {
  const start = html.indexOf('<div class="docs__body">');
  const docs = html.slice(start, html.indexOf("<footer", start));
  const out = [];
  // A paragraph or heading after a list or table starts a new block.
  const gap = () => {
    const last = out[out.length - 1] ?? "";
    if (last.startsWith("- ") || last.startsWith("|")) out.push("");
  };
  const blocks = docs.matchAll(/<(h2|h3|p|li|tr|dt|dd)[^>]*>(.*?)<\/\1>/gs);
  let header = false;
  for (const [, tag, inner] of blocks) {
    if (tag === "h2") out.push("", `## ${inline(inner)}`, "");
    else if (tag === "h3") out.push("", `### ${inline(inner)}`, "");
    else if (tag === "p") {
      gap();
      out.push(inline(inner), "");
    }
    else if (tag === "li") {
      // A list item of the timeline has its own heading and text.
      const title = inner.match(/<h3[^>]*>(.*?)<\/h3>/s);
      out.push(title ? `- **${inline(title[1])}**: ${inline(inner.replace(title[0], ""))}` : `- ${inline(inner)}`);
    } else if (tag === "dt") out.push(`- **${inline(inner)}**`);
    else if (tag === "dd") out[out.length - 1] += `: ${inline(inner)}`;
    else if (tag === "tr") {
      const cells = [...inner.matchAll(/<(th|td)[^>]*>(.*?)<\/\1>/gs)].map((c) => inline(c[2]));
      out.push(`| ${cells.join(" | ")} |`);
      if (!header) {
        out.push(`| ${cells.map(() => "---").join(" | ")} |`);
        header = true;
      }
    }
    if (tag !== "tr") header = false;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const summary =
  "Veiling is a launchpad on Solana that sells new tokens and NFT collections by sealed-bid auction. Bids are encrypted in the bidder's browser and settled on Arcium's encrypted compute network, so no one sees them; when bidding closes, one final price (the clearing price) is made public and every winner pays it.";

const llms = `# ${NAME}

> ${summary}

Key facts:

- A new token sells 50% of its supply by sealed bid over 1, 2 or 5 hours. It is made only if the sale sells out; then everything raised, less the platform fee, opens a Meteora pool at the final price, locked forever, and nobody can ever make more of the token. If it does not sell out, no token is made and every deposit comes back.
- The token's creator gets no tokens and none of the SOL raised; they earn a share of the pool's trading fees.
- NFT collections (drops of up to 10,000 NFTs, or collections built item by item) sell the same way; NFTs are minted only for winners, assigned at random, and the art can stay hidden until the sale ends.
- Every winner pays the same final price, never more than their own bid; bids below it are refunded in full.
- If settlement stalls, every unsettled deposit can be returned one day after bidding ends for a new token, or three days for an NFT collection.

## Docs

- [How Veiling works](${url("/docs/")}): bidding, the final price, new tokens and their pool, drops and collections, fees, privacy, refunds and FAQ
- [Full docs as text](${url("/llms-full.txt")}): the same docs in one Markdown file
- [Source code](${ssr.GITHUB_URL}): the Solana program, the Arcium circuits and the app

## App

- [Auctions](${url("/#/auctions")}): live, upcoming and ended sales
- [Launch](${url("/#/launch")}): open a sale of a new token, a drop or a collection
`;

await writeFile(join(dist, "llms.txt"), llms);
await writeFile(
  join(dist, "llms-full.txt"),
  `# ${NAME}: how it works\n\n> ${summary}\n\nSource: ${url("/docs/")}\n\n${markdown(rendered.docs)}\n`
);

// ---------------------------------------------------------------------------
// robots.txt and the sitemap.

// Search and answer engines, and the fetches people make through them, are
// welcome everywhere. Training crawlers are too; to keep the site out of
// model training, change their "Allow: /" to "Disallow: /".
const bots = [
  ["Search and answer engines", ["OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Googlebot", "Bingbot"]],
  ["Model training", ["GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended", "CCBot"]],
];
const robots = [
  ...bots.flatMap(([label, agents]) => [`# ${label}`, ...agents.map((a) => `User-agent: ${a}`), "Allow: /", ""]),
  "User-agent: *",
  "Allow: /",
  ...(SITE ? ["", `Sitemap: ${url("/sitemap.xml")}`] : []),
  "",
].join("\n");
await writeFile(join(dist, "robots.txt"), robots);

if (SITE) {
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.filter((p) => !p.noindex).map((p) => `  <url><loc>${escape(url(p.path))}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`;
  await writeFile(join(dist, "sitemap.xml"), sitemap);
} else {
  await rm(join(dist, "sitemap.xml"), { force: true });
  console.warn("prerender: SITE_URL is not set, so there is no sitemap and no canonical links.");
}

await rm(work, { recursive: true, force: true });
console.log(`prerender: ${PAGES.map((p) => p.path).join(", ")}, robots.txt, llms.txt, llms-full.txt${SITE ? ", sitemap.xml" : ""}`);
process.exit(0);
