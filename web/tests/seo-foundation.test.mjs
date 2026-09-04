import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * SEO0 guardrails.
 *
 * These assert on the shipped source files rather than a built bundle, so they
 * run in the ordinary `node --test` gate. The rules they protect are the ones
 * whose breakage is silent: a lost canonical duplicates the site across three
 * hostnames, a crawlable account route indexes signed-in surfaces, and a
 * widened precache glob turns every install into a catalogue download.
 *
 * See docs/adr/014-prerendered-seo-surface.md.
 */

const CANONICAL_ORIGIN = "https://pleni.se";
const HOME_TITLE = "Riksdagsdebatter i kortformat";
const HOME_DESCRIPTION =
  "Upptäck aktuella frågor och uttalanden från Sveriges riksdag genom korta, tydliga videoklipp med källhänvisning.";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const indexHtml = read("../index.html");
const robotsTxt = read("../public/robots.txt");
const viteConfig = read("../vite.config.ts");

test("the home document declares exactly one absolute apex canonical", () => {
  const canonicals = [...indexHtml.matchAll(/<link\s+rel="canonical"\s+href="([^"]+)"/g)];
  assert.equal(canonicals.length, 1);
  assert.equal(canonicals[0][1], `${CANONICAL_ORIGIN}/`);
});

test("the home document is described for search and social results", () => {
  const description = indexHtml.match(/<meta\s+name="description"\s+content="([^"]+)"/s);
  assert.ok(description, "index.html must carry a meta description");
  assert.ok(description[1].length >= 50 && description[1].length <= 160);
  assert.equal(description[1], HOME_DESCRIPTION);

  assert.match(indexHtml, new RegExp(`<title>${HOME_TITLE.replace("|", "\\|")}<\\/title>`));
  assert.match(indexHtml, /property="og:type"\s+content="website"/);
  assert.match(indexHtml, /property="og:locale"\s+content="sv_SE"/);
  assert.match(indexHtml, new RegExp(`property="og:url"\\s+content="${CANONICAL_ORIGIN}/"`));
  assert.match(indexHtml, new RegExp(`property="og:title"\\s+content="${HOME_TITLE.replace("|", "\\|")}"`));
  assert.match(indexHtml, new RegExp(`property="og:description"\\s+content="${HOME_DESCRIPTION}"`));
  assert.match(indexHtml, new RegExp(`name="twitter:title"\\s+content="${HOME_TITLE.replace("|", "\\|")}"`));
  assert.match(indexHtml, new RegExp(`name="twitter:description"\\s+content="${HOME_DESCRIPTION}"`));
  assert.match(indexHtml, /name="twitter:image:alt"\s+content="Plenis logotyp"/);
  assert.match(indexHtml, /property="og:image:type"\s+content="image\/png"/);
  assert.match(
    indexHtml,
    /<link rel="icon" type="image\/png" sizes="96x96" href="\/favicon-pleni-20260904\.png" \/>/
  );
  assert.match(
    indexHtml,
    /name="robots"\s+content="max-snippet:-1, max-image-preview:large, max-video-preview:-1"/
  );
  assert.equal(indexHtml.includes("<html lang=\"sv\">"), true);
});

test("absolute social and structured-data URLs never point off the canonical host", () => {
  const markup = indexHtml.replace(/<!--[\s\S]*?-->/g, "");
  const absolute = [...markup.matchAll(/https?:\/\/[^"\s]+/g)].map((match) => match[0]);
  const offHost = absolute.filter(
    (url) => !url.startsWith(`${CANONICAL_ORIGIN}/`) && !url.startsWith("https://schema.org")
  );
  assert.deepEqual(offHost, [], `unexpected off-host absolute URLs: ${offHost.join(", ")}`);
});

test("the home document publishes a valid WebSite and Organization graph", () => {
  const blocks = [
    ...indexHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)
  ];
  assert.equal(blocks.length, 1);

  const parsed = JSON.parse(blocks[0][1]);
  assert.equal(parsed["@context"], "https://schema.org");

  const types = parsed["@graph"].map((node) => node["@type"]);
  assert.deepEqual([...types].sort(), ["Organization", "WebSite"]);

  const site = parsed["@graph"].find((node) => node["@type"] === "WebSite");
  const organization = parsed["@graph"].find((node) => node["@type"] === "Organization");
  assert.equal(site.url, `${CANONICAL_ORIGIN}/`);
  assert.equal(site.alternateName, "Pleni.se");
  assert.equal(site.description, HOME_DESCRIPTION);
  assert.equal(site.inLanguage, "sv-SE");
  assert.equal(site.publisher["@id"], organization["@id"]);
  assert.ok(organization.logo.url.startsWith(`${CANONICAL_ORIGIN}/`));
});

test("no SearchAction is declared while search keeps its query out of the URL", () => {
  // `web/src/search/route.ts` deliberately holds query text in React memory, so
  // there is no query-string endpoint a sitelinks searchbox could resolve. The
  // markup is checked with comments stripped, because the reason for the
  // omission is itself documented in a comment in this file.
  const markup = indexHtml.replace(/<!--[\s\S]*?-->/g, "");
  assert.equal(markup.includes("SearchAction"), false);
  assert.equal(markup.includes("search_term_string"), false);
});

test("robots.txt opens the catalogue and closes the account routes", () => {
  assert.match(robotsTxt, /^User-agent: \*$/m);
  assert.match(robotsTxt, /^Allow: \/$/m);
  for (const route of ["/profil", "/sparade", "/foljer"]) {
    assert.match(robotsTxt, new RegExp(`^Disallow: ${route}$`, "m"));
  }

  // A bare `Disallow: /` would delist the whole site. It has happened to others.
  const disallowAll = robotsTxt
    .split("\n")
    .some((line) => line.trim() === "Disallow: /");
  assert.equal(disallowAll, false);
});

test("robots.txt names a sitemap only once one exists", () => {
  // `seo/prerender.mjs` appends the `Sitemap:` line to the deployed copy, and
  // only after it has written the index. Absence here is the mechanism: a
  // build that cannot reach Supabase ships no sitemap and no pointer to one.
  assert.equal(/^Sitemap:/m.test(robotsTxt), false);

  const generator = read("../seo/prerender.mjs");
  assert.match(generator, /Sitemap: \$\{ORIGIN\}\/sitemap\.xml/);
});

test("the precache glob stays narrow enough to exclude generated SEO files", () => {
  // SEO2/SEO3 write thousands of HTML files and SEO5 writes sitemap XML into
  // `dist`. The generator runs *after* `vite build` so the HTML never reaches
  // this manifest; adding `xml` or `txt` here would precache the sitemaps and
  // robots.txt regardless of that ordering.
  const glob = viteConfig.match(/globPatterns:\s*\[([^\]]+)\]/s);
  assert.ok(glob, "vite.config.ts must declare injectManifest globPatterns");

  const extensions = glob[1].match(/\{([^}]+)\}/);
  assert.ok(extensions, "globPatterns must keep its explicit extension list");
  assert.deepEqual(extensions[1].split(",").map((value) => value.trim()).sort(), [
    "css",
    "html",
    "js",
    "json",
    "png",
    "svg",
    "woff2"
  ]);
});
