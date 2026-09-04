/**
 * HTML templates for the prerendered SEO surface.
 *
 * Every page produced here is a complete document: the video, the transcript,
 * the speaker and the link to the primary source are all present before any
 * script runs. Google's video guidance requires the video to be discoverable
 * when the watch page is rendered and not to depend on user interaction such
 * as swiping, which is exactly what a feed cannot promise.
 *
 * Watch pages deliberately do not boot the SPA. They are standalone documents
 * that link into the app. See ADR 014's amendment.
 */

import {
  clipDescription,
  clipHeading,
  clipPath,
  clipTitle,
  escapeHtml,
  formatSwedishDate,
  isoDuration,
  jsonLd,
  metaDescription,
  partyPathForCode,
  politicianPath
} from "./lib.mjs";

export const ORIGIN = "https://pleni.se";

/** Shared, inlined stylesheet. No external CSS request on a cold Google visit. */
const STYLES = `
:root{color-scheme:dark;--bg:#050608;--panel:#101319;--line:#232833;--text:#f4f5f7;--muted:#9aa1ad;--accent:#7fb2ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent)}
.wrap{max-width:720px;margin:0 auto;padding:20px 20px 64px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em;text-decoration:none;color:var(--text);padding:8px 0}
.brand span{font-size:18px}
nav.crumbs{font-size:13px;color:var(--muted);margin:8px 0 20px}
nav.crumbs a{color:var(--muted)}
h1{font-size:clamp(22px,5vw,30px);line-height:1.25;margin:0 0 12px;letter-spacing:-.01em}
.byline{color:var(--muted);font-size:14px;margin:0 0 20px}
.player{background:#000;border:1px solid var(--line);border-radius:14px;overflow:hidden;margin:0 0 20px}
.player video{display:block;width:100%;max-height:80vh;background:#000}
dl.facts{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 24px;font-size:14px}
dl.facts dt{color:var(--muted)}
dl.facts dd{margin:0}
h2{font-size:17px;margin:28px 0 10px}
.transcript{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0}
.transcript p{margin:0 0 12px}
.transcript p:last-child{margin:0}
.source{font-size:14px;color:var(--muted);margin:20px 0 0}
ul.links{list-style:none;padding:0;margin:14px 0 0;display:flex;flex-wrap:wrap;gap:10px}
ul.related{list-style:none;padding:0;margin:14px 0 0;display:grid;gap:10px}
ul.related li{border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:12px 14px}
ul.related a{display:block;text-decoration:none;font-weight:600}
ul.related span{display:block;color:var(--muted);font-size:13px;margin-top:3px}
ul.links a{display:inline-block;border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:8px 14px;font-size:14px;text-decoration:none}
.cta{display:inline-block;margin:22px 0 0;background:var(--accent);color:#08131f;font-weight:600;border-radius:999px;padding:11px 20px;text-decoration:none}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
`.trim();

/**
 * Styles for prerendered content injected into the app shell.
 *
 * Every selector is `seo-` prefixed. The app's own stylesheet owns `#root`
 * once React mounts, so these rules must not be in a position to fight it.
 */
const SEO_CONTENT_STYLES = `
.seo-hub{max-width:720px;margin:0 auto;padding:20px 20px 64px;color:#f4f5f7;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.seo-hub a{color:#7fb2ff}
.seo-hub h1{font-size:clamp(22px,5vw,30px);line-height:1.25;margin:0 0 8px}
.seo-hub p{color:#9aa1ad;font-size:14px;margin:0 0 18px}
.seo-hub h2{font-size:17px;margin:24px 0 10px}
.seo-hub ul{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.seo-hub li{border:1px solid #232833;background:#101319;border-radius:10px;padding:10px 12px}
.seo-hub li a{display:block;text-decoration:none;font-weight:600;font-size:15px}
.seo-hub li span{display:block;color:#9aa1ad;font-size:13px;margin-top:2px}
.seo-hub .seo-inline{display:flex;flex-wrap:wrap;gap:8px}
.seo-hub .seo-inline li{padding:7px 12px;border-radius:999px}
.seo-hub .seo-inline li a{font-weight:500;font-size:14px}
`.trim();

const PREVIEW_ROBOTS = "max-snippet:-1, max-image-preview:large, max-video-preview:-1";

function head({ title, description, canonical, robots, extraHead = "" }) {
  return `    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#050608" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="${escapeHtml(robots ?? PREVIEW_ROBOTS)}" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <link rel="icon" type="image/png" sizes="96x96" href="/favicon-pleni-20260904.png" />
    <link rel="manifest" href="/manifest.json" />
${extraHead}    <style>${STYLES}</style>`;
}

function document_({ title, description, canonical, robots, extraHead, body }) {
  return `<!doctype html>
<html lang="sv">
  <head>
${head({ title, description, canonical, robots, extraHead })}
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function brandHeader() {
  return `      <a class="brand" href="/"><span>Pleni</span></a>`;
}

function footer() {
  return `      <footer>
        <p>
          Pleni klipper svenska riksdagsdebatter till korta videor. Materialet
          kommer från Sveriges riksdag och varje klipp länkar till originalet.
        </p>
        <ul class="links">
          <li><a href="/legal/about/">Om Pleni</a></li>
          <li><a href="/legal/privacy/">Integritet</a></li>
          <li><a href="/legal/terms/">Villkor</a></li>
        </ul>
      </footer>`;
}

/**
 * A fully static page: brand header, the caller's body, footer.
 *
 * Used for pages the app has no route for — watch pages and debate pages — so
 * nothing hydrates and there is no second version of the content to keep in
 * agreement.
 */
export function renderStaticPage({ title, description, canonical, robots, extraHead, body }) {
  return document_({
    title,
    description,
    canonical,
    robots,
    extraHead,
    body: `    <div class="wrap">
${brandHeader()}
${body}
${footer()}
    </div>`
  });
}

function paragraphs(text) {
  return String(text)
    .split(/\n{2,}|(?<=\.)\s{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => `          <p>${escapeHtml(chunk)}</p>`)
    .join("\n");
}

/**
 * A clip watch page.
 *
 * `related` is a short list of other clips from the same debate, so a crawler
 * arriving here has somewhere to go and a reader has context.
 */
export function renderClipPage(clip, related = []) {
  const canonical = `${ORIGIN}${clipPath(clip)}`;
  const title = clipTitle(clip);
  const description = clipDescription(clip);
  const heading = clipHeading(clip);
  const date = formatSwedishDate(clip.debateDate);
  const uploadDate = clip.publishedAt ?? clip.debateDate;

  const video = {
    "@type": "VideoObject",
    name: heading,
    description,
    thumbnailUrl: [clip.thumbUrl],
    uploadDate,
    duration: isoDuration(clip.durationS),
    contentUrl: clip.videoUrl,
    url: canonical,
    inLanguage: "sv-SE",
    isFamilyFriendly: true,
    creator: {
      "@type": "Person",
      name: clip.name,
      ...(clip.party ? { affiliation: { "@type": "Organization", name: clip.party } } : {})
    },
    publisher: { "@type": "Organization", name: "Pleni", url: `${ORIGIN}/` },
    ...(clip.transcript ? { transcript: clip.transcript } : {}),
    ...(clip.sourceUrl ? { isBasedOn: clip.sourceUrl } : {})
  };

  const crumbs = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Pleni", item: `${ORIGIN}/` },
      ...(clip.politicianId
        ? [
            {
              "@type": "ListItem",
              position: 2,
              name: clip.name,
              item: `${ORIGIN}${politicianPath({ id: clip.politicianId, name: clip.name })}`
            }
          ]
        : []),
      {
        "@type": "ListItem",
        position: clip.politicianId ? 3 : 2,
        name: heading,
        item: canonical
      }
    ]
  };

  const extraHead = `    <meta property="og:type" content="video.other" />
    <meta property="og:site_name" content="Pleni" />
    <meta property="og:locale" content="sv_SE" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta property="og:title" content="${escapeHtml(heading)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${escapeHtml(clip.thumbUrl)}" />
    <meta property="og:image:type" content="image/webp" />
    <meta property="og:image:alt" content="${escapeHtml(heading)}" />
    <meta property="og:video" content="${escapeHtml(clip.videoUrl)}" />
    <meta property="og:video:type" content="video/mp4" />
    <meta property="og:video:width" content="540" />
    <meta property="og:video:height" content="960" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(heading)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(clip.thumbUrl)}" />
    <meta name="twitter:image:alt" content="${escapeHtml(heading)}" />
    <link rel="preload" as="image" href="${escapeHtml(clip.thumbUrl)}" />
    <script type="application/ld+json">
${jsonLd({ "@context": "https://schema.org", "@graph": [video, crumbs] })}
    </script>
`;

  const facts = [
    ["Talare", clip.displayName || clip.name],
    ["Parti", clip.party],
    ["Typ", clip.anforandetyp],
    ["Debatt", clip.debateTitle],
    ["Datum", date]
  ]
    .filter(([, value]) => Boolean(value))
    .map(
      ([label, value]) =>
        `        <dt>${escapeHtml(label)}</dt>\n        <dd>${escapeHtml(value)}</dd>`
    )
    .join("\n");

  // Anchor text is a real ranking signal and a real usability one, so each
  // neighbour is labelled by what is said in it. Several clips from one speaker
  // in one debate is the normal case; `name (party)` alone would repeat.
  const relatedList = related.length
    ? `      <h2>Fler klipp från samma debatt</h2>
      <ul class="related">
${related
  .map((other) => {
    const label = other.title ? metaDescription(other.title, 70) : clipHeading(other);
    const who = `${other.name}${other.party ? ` (${other.party})` : ""}`;
    return `        <li>
          <a href="${escapeHtml(clipPath(other))}">${escapeHtml(label)}</a>
          <span>${escapeHtml(who)}</span>
        </li>`;
  })
  .join("\n")}
      </ul>`
    : "";

  const navLinks = [
    clip.politicianId
      ? `        <li><a href="${escapeHtml(
          politicianPath({ id: clip.politicianId, name: clip.name })
        )}">Alla klipp med ${escapeHtml(clip.name)}</a></li>`
      : "",
    clip.party
      ? `        <li><a href="${escapeHtml(partyPathForCode(clip.party))}">${escapeHtml(clip.party)}</a></li>`
      : "",
    `        <li><a href="/senaste/">Senaste klippen</a></li>`
  ]
    .filter(Boolean)
    .join("\n");

  const body = `    <div class="wrap">
${brandHeader()}
      <nav class="crumbs">
        <a href="/">Pleni</a> ›${
          clip.politicianId
            ? ` <a href="${escapeHtml(
                politicianPath({ id: clip.politicianId, name: clip.name })
              )}">${escapeHtml(clip.name)}</a> ›`
            : ""
        } ${escapeHtml(clip.debateTitle || "Klipp")}
      </nav>
      <h1>${escapeHtml(heading)}</h1>
      <p class="byline">${escapeHtml(
        [clip.displayName || clip.name, clip.anforandetyp, date].filter(Boolean).join(" · ")
      )}</p>
      <div class="player">
        <video
          controls
          playsinline
          preload="metadata"
          width="540"
          height="960"
          poster="${escapeHtml(clip.thumbUrl)}"
          src="${escapeHtml(clip.videoUrl)}"
        ></video>
      </div>
      <dl class="facts">
${facts}
      </dl>
      <h2>Vad som sägs</h2>
      <div class="transcript">
${clip.transcript ? paragraphs(clip.transcript) : "          <p>Transkript saknas för det här klippet.</p>"}
      </div>
${
  clip.sourceUrl
    ? `      <p class="source">
        Källa: <a href="${escapeHtml(clip.sourceUrl)}" rel="nofollow noopener">${escapeHtml(
          clip.debateTitle || "debatten hos Sveriges riksdag"
        )} hos Sveriges riksdag</a>.
        Klippet är ett utdrag; hela debatten finns hos riksdagen.
      </p>`
    : ""
}
      <a class="cta" href="/senaste/">Öppna Pleni</a>
      <h2>Gå vidare</h2>
      <ul class="links">
${navLinks}
      </ul>
${relatedList}
${footer()}
    </div>`;

  return document_({ title, description, canonical, extraHead, body });
}

/**
 * A shell page for a route the SPA owns, derived from the built `index.html`.
 *
 * The pod 404s any path without a file, so every pushable path needs one of
 * these. Patching the real built document — rather than reconstructing one —
 * is what guarantees the hashed asset URLs, the icons, the manifest link and
 * the PWA metadata stay correct as the build changes.
 *
 * Entity shells are `noindex` until SEO3 replaces them with real hub content: a
 * page whose only content arrives via JavaScript is thin, and 744 identical
 * ones would be duplicate thin pages.
 */
export function renderShellPage(
  builtHtml,
  { title, description, canonical, robots, graph, prerender }
) {
  let html = builtHtml;

  html = replaceOnce(html, /<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  html = replaceOnce(
    html,
    /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
    `<meta name="description" content="${escapeHtml(description)}" />`
  );
  html = replaceOnce(
    html,
    /<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/,
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`
  );
  html = replaceOnce(
    html,
    /<meta\s+property="og:url"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`
  );
  html = replaceOnce(
    html,
    /<meta\s+property="og:title"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:title" content="${escapeHtml(title)}" />`
  );
  html = replaceOnce(
    html,
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:description" content="${escapeHtml(description)}" />`
  );
  html = replaceOnce(
    html,
    /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/>/,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`
  );
  html = replaceOnce(
    html,
    /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/>/,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`
  );

  if (robots) {
    html = replaceOnce(
      html,
      /<meta\s+name="robots"\s+content="[^"]*"\s*\/>/,
      `<meta name="robots" content="${escapeHtml(robots)}" />`
    );
  }

  if (graph) {
    const block = jsonLd({ "@context": "https://schema.org", "@graph": graph });
    html = html.replace(
      "</head>",
      `  <script type="application/ld+json">\n${block}\n    </script>\n  </head>`
    );
  }

  // Content placed inside `#root` is what a crawler sees before the bundle
  // runs, and it is what gives the watch pages a crawl path that does not
  // depend on JavaScript. React clears the container on mount, so the app's
  // own screen replaces it. Both render the same entity from the same rows, so
  // this is progressive enhancement rather than a second version of the page.
  if (prerender) {
    html = replaceOnce(html, /<div id="root"><\/div>/, `<div id="root">${prerender}</div>`);
    html = html.replace("</head>", `  <style>${SEO_CONTENT_STYLES}</style>\n  </head>`);
  }

  return html;
}

/**
 * Replace the first match, or throw.
 *
 * A silent no-op here would ship a shell carrying the home page's canonical and
 * title, which is exactly the duplicate-content bug the shells exist to avoid.
 * Failing loudly means a future change to `index.html`'s head is caught by the
 * prerender tests instead of in Search Console weeks later.
 */
function replaceOnce(html, pattern, replacement) {
  if (!pattern.test(html)) {
    throw new Error(`prerender: built index.html no longer matches ${pattern}`);
  }
  return html.replace(pattern, replacement);
}
