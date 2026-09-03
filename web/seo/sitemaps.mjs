/**
 * SEO5 — sitemaps.
 *
 * A sitemap must be served from the host it describes, and the pod serves
 * files, so these are generated alongside the pages. The clip sitemap uses
 * Google's `video` namespace: Google recommends video sitemaps precisely
 * because they surface videos its ordinary crawl might miss, and a swipe feed
 * is exactly the shape that gets missed.
 *
 * Limits are 50 000 URLs and 50 MB uncompressed per file. `URLS_PER_SITEMAP`
 * is far below both, because a video entry carries five child elements and the
 * transcript-derived description is long.
 */

import {
  clipDescription,
  clipHeading,
  clipPath,
  escapeHtml,
  isoDate,
  metaDescription
} from "./lib.mjs";
import { ORIGIN } from "./templates.mjs";
import { debatePath } from "./hubs.mjs";

export const URLS_PER_SITEMAP = 2000;

/** XML text escaping. `escapeHtml` covers the five predefined entities. */
function xml(value) {
  return escapeHtml(value);
}

function urlEntry(loc, lastmod, body = "") {
  return `  <url>
    <loc>${xml(loc)}</loc>${lastmod ? `\n    <lastmod>${xml(lastmod)}</lastmod>` : ""}${body}
  </url>`;
}

function document_(entries, { video = false } = {}) {
  const ns = video
    ? '\n        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"'
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${ns}>
${entries.join("\n")}
</urlset>
`;
}

/**
 * One `<video:video>` block per clip.
 *
 * `content_loc` points at the Bunny MP4 on `riketnlooigm.b-cdn.net`. That host
 * serves no robots.txt (404 grants access), so Googlebot may fetch it — checked
 * 2026-09-03. `duration` is in seconds and must be 1-28800.
 */
function videoBlock(clip) {
  const duration = Math.min(28800, Math.max(1, Math.round(clip.durationS)));
  const publication = isoDate(clip.publishedAt ?? clip.debateDate);
  return `
    <video:video>
      <video:thumbnail_loc>${xml(clip.thumbUrl)}</video:thumbnail_loc>
      <video:title>${xml(metaDescription(clipHeading(clip), 100))}</video:title>
      <video:description>${xml(clipDescription(clip))}</video:description>
      <video:content_loc>${xml(clip.videoUrl)}</video:content_loc>
      <video:duration>${duration}</video:duration>${
        publication ? `\n      <video:publication_date>${xml(publication)}</video:publication_date>` : ""
      }
      <video:family_friendly>yes</video:family_friendly>
      <video:live>no</video:live>
    </video:video>`;
}

/** Shard the clip URLs into video sitemaps. Returns `[{ path, xml }]`. */
export function clipSitemaps(clips) {
  const shards = [];
  for (let index = 0; index < clips.length; index += URLS_PER_SITEMAP) {
    const slice = clips.slice(index, index + URLS_PER_SITEMAP);
    const entries = slice.map((clip) =>
      urlEntry(
        `${ORIGIN}${clipPath(clip)}`,
        isoDate(clip.publishedAt ?? clip.debateDate),
        videoBlock(clip)
      )
    );
    shards.push({
      path: `/sitemap-klipp-${shards.length + 1}.xml`,
      xml: document_(entries, { video: true })
    });
  }
  return shards;
}

/** A plain URL sitemap from `[{ loc, lastmod }]`. */
export function urlSitemap(path, urls) {
  return {
    path,
    xml: document_(urls.map((url) => urlEntry(url.loc, url.lastmod)))
  };
}

/** The index that ties the shards together, listed in `robots.txt`. */
export function sitemapIndex(children, lastmod) {
  const entries = children
    .map(
      (child) => `  <sitemap>
    <loc>${xml(`${ORIGIN}${child.path}`)}</loc>${
        lastmod ? `\n    <lastmod>${xml(lastmod)}</lastmod>` : ""
      }
  </sitemap>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>
`;
}
