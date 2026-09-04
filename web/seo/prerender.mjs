#!/usr/bin/env node
/**
 * Write Pleni's crawlable SEO surface into `dist/` (SEO2).
 *
 * Run this AFTER `vite build`, never during it. `vite.config.ts` globs
 * `**\/*.html` into the service worker's precache manifest, so HTML written
 * before the Vite build would turn a nine-entry app shell into one entry per
 * clip and make every install download the whole catalogue.
 *
 *   node ./node_modules/vite/bin/vite.js build && node seo/prerender.mjs
 *
 * The generator holds no secret: it reads published rows with the publishable
 * key under existing RLS, where `clips_public_read` already restricts to
 * `moderation <> 'rejected' and published_at is not null`.
 *
 * With no Supabase environment — which is how CI builds on purpose (ADR 006) —
 * it logs, writes only the app shells it can build offline, and exits 0. A
 * failed prerender must never fail a deploy.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  debatePath,
  renderDebatePage,
  renderPartyHub,
  renderPoliticianHub
} from "./hubs.mjs";
import {
  cleanName,
  clipPath,
  isoDate,
  normalizeClip,
  partyPath,
  politicianPath
} from "./lib.mjs";
import { clipSitemaps, sitemapIndex, urlSitemap } from "./sitemaps.mjs";
import { ORIGIN, renderClipPage, renderShellPage } from "./templates.mjs";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WEB_ROOT, "dist");
const PAGE_SIZE = 500;
const RELATED_PER_CLIP = 6;

const CLIP_SELECT = [
  "id",
  "speech_id",
  "rank_in_speech",
  "title",
  "transcript",
  "topic",
  "archetype",
  "duration_s",
  "url_540x960",
  "thumb_url",
  "published_at",
  "speeches(speaker_name,party,anforandetyp,politician_id," +
    "politicians(id,name,role,avatar_url)," +
    "sources(id,dokid,title,debate_type,debate_date,source_url))"
].join(",");

/**
 * Shells for the routes the SPA owns.
 *
 * Mirrors `APP_SHELL_ROUTES` in `web/src/navigation.ts`; the prerender test
 * asserts the two lists agree, because a pushable path without a file 404s on
 * reload and on share.
 */
const APP_SHELLS = [
  { path: "/senaste/", title: "Senaste klippen | Pleni", description: "De senaste klippen från svenska riksdagsdebatter — talare, parti och debatt för varje klipp." },
  { path: "/sok/", title: "Sök i riksdagsdebatter | Pleni", description: "Sök bland klipp från svenska riksdagsdebatter på politiker, parti, ämne eller datum." },
  { path: "/foljer/", title: "Följer | Pleni", description: "Politiker och partier du följer på Pleni.", robots: "noindex, follow" },
  { path: "/profil/", title: "Profil | Pleni", description: "Ditt konto, dina intressen och dina inställningar på Pleni.", robots: "noindex, follow" },
  { path: "/sparade/", title: "Sparade klipp | Pleni", description: "Klipp du sparat på Pleni.", robots: "noindex, follow" },
  { path: "/sparade/klipp/", title: "Sparade klipp | Pleni", description: "Klipp du sparat på Pleni.", robots: "noindex, follow" },
  { path: "/legal/terms/", title: "Användarvillkor | Pleni", description: "Villkoren för att använda Pleni." },
  { path: "/legal/privacy/", title: "Integritetspolicy | Pleni", description: "Hur Pleni behandlar personuppgifter." },
  { path: "/legal/storage/", title: "Lagring och cookies | Pleni", description: "Vad Pleni lagrar i din webbläsare och varför." },
  { path: "/legal/about/", title: "Om Pleni", description: "Pleni klipper svenska riksdagsdebatter till korta videor med länk till originalet." }
];

const PARTY_CODES = ["s", "m", "sd", "c", "v", "kd", "mp", "l"];

function log(message, extra = {}) {
  const detail = Object.entries(extra)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  process.stdout.write(`[prerender] ${message}${detail ? ` ${detail}` : ""}\n`);
}

async function writePage(routePath, html) {
  const target = join(DIST, routePath.replace(/^\//, ""), "index.html");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, html, "utf8");
}

/** Page through PostgREST. Ordered by `id` so paging cannot skip or repeat. */
async function fetchClips(url, key) {
  const clips = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URLSearchParams({
      select: CLIP_SELECT,
      published_at: "not.is.null",
      moderation: "neq.rejected",
      order: "id.asc",
      limit: String(PAGE_SIZE),
      offset: String(offset)
    });
    const response = await fetch(`${url}/rest/v1/clips?${query}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`clips request failed: ${response.status} ${response.statusText}`);
    }
    const batch = await response.json();
    clips.push(...batch);
    if (batch.length < PAGE_SIZE) {
      return clips;
    }
  }
}

/** Group clips by debate so each watch page can offer real neighbours. */
function relatedByDebate(clips) {
  const byDebate = new Map();
  for (const clip of clips) {
    if (!clip.dokid) {
      continue;
    }
    const bucket = byDebate.get(clip.dokid);
    if (bucket) {
      bucket.push(clip);
    } else {
      byDebate.set(clip.dokid, [clip]);
    }
  }
  return byDebate;
}

async function writeAppShells(builtHtml) {
  // `/` needs no shell: `dist/index.html` already serves it.
  let written = 0;
  for (const shell of APP_SHELLS) {
    const html = renderShellPage(builtHtml, {
      title: shell.title,
      description: shell.description,
      canonical: `${ORIGIN}${shell.path}`,
      robots: shell.robots
    });
    await writePage(shell.path, html);
    written += 1;
  }
  return written;
}

/**
 * Politician and party hubs (SEO3), plus the `/klipp` sub-route shells.
 *
 * The hub itself carries real prerendered content and is indexable. The
 * `/klipp` variant is the same entity's in-app clip player, so it stays
 * `noindex, follow` and canonicalises to the hub: it is a route the app
 * pushes, not a second page worth indexing.
 */
async function writeEntityHubs(builtHtml, { politicians, parties, clipsByPolitician, clipsByParty }) {
  let hubs = 0;
  let shells = 0;

  for (const politician of politicians) {
    const clips = clipsByPolitician.get(politician.id) ?? [];
    if (clips.length === 0) {
      continue;
    }
    const canonicalPath = politicianPath(politician);
    const idOnlyPath = `/politiker/${encodeURIComponent(politician.id)}/`;
    const hub = renderPoliticianHub(builtHtml, politician, clips);

    // The slug form is canonical. The id-only form is generated too, because
    // the app pushes it before the profile row arrives; it serves the same
    // content and its canonical link points at the slug form, so a reload or a
    // shared link never 404s and the duplicate never competes.
    await writePage(canonicalPath, hub);
    await writePage(idOnlyPath, hub);
    hubs += 1;
    shells += 1;

    const clipsShell = renderShellPage(builtHtml, {
      title: `${cleanName(politician.name) || politician.name} — klipp | Pleni`,
      description: "Klipp från svenska riksdagsdebatter på Pleni.",
      canonical: `${ORIGIN}${canonicalPath}`,
      robots: "noindex, follow"
    });
    await writePage(`${canonicalPath}klipp/`, clipsShell);
    await writePage(`${idOnlyPath}klipp/`, clipsShell);
    shells += 2;
  }

  for (const party of parties) {
    const partyBase = partyPath(party);
    const clips = clipsByParty.get(party.code) ?? [];
    const roster = politicians
      .filter(
        (person) => person.party === party.code && (clipsByPolitician.get(person.id)?.length ?? 0) > 0
      )
      .sort((a, b) => a.name.localeCompare(b.name, "sv"));

    const partyHub = renderPartyHub(builtHtml, party, roster, clips);
    const partyClipsShell = renderShellPage(builtHtml, {
      title: `${party.name} — klipp | Pleni`,
      description: "Klipp från svenska riksdagsdebatter på Pleni.",
      canonical: `${ORIGIN}${partyBase}`,
      robots: "noindex, follow"
    });

    // Same reasoning as politicians: the readable name is canonical, and the
    // bare code stays a working alias because `navigation.ts` accepts both.
    for (const base of new Set([partyBase, `/parti/${party.code.toLowerCase()}/`])) {
      await writePage(base, partyHub);
      await writePage(`${base}klipp/`, partyClipsShell);
      shells += 2;
    }
    hubs += 1;
  }

  return { hubs, shells };
}

/** Debate pages (SEO3). Fully static — the app has no debate route. */
async function writeDebatePages(clips) {
  const byDebate = new Map();
  for (const clip of clips) {
    if (!clip.dokid) {
      continue;
    }
    const bucket = byDebate.get(clip.dokid);
    if (bucket) {
      bucket.clips.push(clip);
    } else {
      byDebate.set(clip.dokid, {
        debate: {
          dokid: clip.dokid,
          title: clip.debateTitle,
          debate_type: clip.debateType,
          debate_date: clip.debateDate,
          source_url: clip.sourceUrl
        },
        clips: [clip]
      });
    }
  }

  let written = 0;
  for (const { debate, clips: debateClips } of byDebate.values()) {
    if (!debate.title) {
      continue;
    }
    await writePage(debatePath(debate), renderDebatePage(debate, debateClips));
    written += 1;
  }
  return written;
}

async function main() {
  const url = (process.env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

  let builtHtml;
  try {
    builtHtml = await readFile(join(DIST, "index.html"), "utf8");
  } catch {
    log("dist/index.html is missing — run the Vite build first. Writing nothing.");
    return;
  }

  const shellCount = await writeAppShells(builtHtml);
  log("app shells written", { pages: shellCount });

  if (!url || !key) {
    log("no VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY — skipping clip pages.");
    log("the deploy is intact; only the crawlable catalogue is absent.");
    return;
  }

  let rows;
  try {
    rows = await fetchClips(url, key);
  } catch (error) {
    log(`clip fetch failed, skipping clip pages: ${error.message}`);
    return;
  }

  const clips = rows.map(normalizeClip).filter(Boolean);
  const skipped = rows.length - clips.length;
  const byDebate = relatedByDebate(clips);

  let written = 0;
  for (const clip of clips) {
    const neighbours = (byDebate.get(clip.dokid) ?? [])
      .filter((other) => other.id !== clip.id)
      .slice(0, RELATED_PER_CLIP);
    await writePage(clipPath(clip), renderClipPage(builtHtml, clip, neighbours));
    written += 1;
  }
  log("clip watch pages written", { pages: written, skipped, debates: byDebate.size });

  const debatePages = await writeDebatePages(clips);
  log("debate pages written", { pages: debatePages });

  // Hubs need rows the clip join does not carry: portraits, constituency and
  // Riksdagen's `intressent_id` for `sameAs`, plus the verified party marks.
  let politicians = [];
  let parties = [];
  try {
    [politicians, parties] = await Promise.all([
      fetchAll(url, key, "politicians", "id,intressent_id,name,party,role,constituency,avatar_url"),
      fetchAll(url, key, "party_profiles", "code,name,short_name,color,logo_url,display_order")
    ]);
  } catch (error) {
    log(`hub metadata fetch failed, keeping clip pages only: ${error.message}`);
    return;
  }

  const clipsByPolitician = groupBy(clips, (clip) => clip.politicianId);
  const clipsByParty = groupBy(clips, (clip) => clip.party);
  const orderedParties = parties
    .filter((party) => PARTY_CODES.includes(party.code.toLowerCase()))
    .sort((a, b) => (a.display_order ?? 99) - (b.display_order ?? 99));

  const { hubs, shells } = await writeEntityHubs(builtHtml, {
    politicians,
    parties: orderedParties,
    clipsByPolitician,
    clipsByParty
  });
  log("entity hubs written", { hubs, shells, parties: orderedParties.length });

  const sitemapCount = await writeSitemaps({
    clips,
    politicians: politicians.filter(
      (person) => (clipsByPolitician.get(person.id)?.length ?? 0) > 0
    ),
    parties: orderedParties,
    debates: debateIndex(clips)
  });
  log("sitemaps written", { files: sitemapCount });
}

/** Debate descriptors, newest first, for the sitemap and nothing else. */
function debateIndex(clips) {
  const byDokid = new Map();
  for (const clip of clips) {
    if (!clip.dokid || !clip.debateTitle || byDokid.has(clip.dokid)) {
      continue;
    }
    byDokid.set(clip.dokid, {
      dokid: clip.dokid,
      title: clip.debateTitle,
      debate_date: clip.debateDate
    });
  }
  return [...byDokid.values()];
}

/**
 * Write the sitemap index and its children, then name the index in
 * `robots.txt`.
 *
 * `robots.txt` is patched here rather than shipped with a `Sitemap:` line,
 * because until this function runs there is no sitemap to point at, and a
 * crawler sent to a 404 is worse than one sent nowhere.
 */
async function writeSitemaps({ clips, politicians, parties, debates }) {
  const newest = clips
    .map((clip) => isoDate(clip.publishedAt))
    .filter(Boolean)
    .sort()
    .at(-1);

  const children = [
    ...clipSitemaps(clips),
    urlSitemap("/sitemap-debatt.xml", [
      ...debates.map((debate) => ({
        loc: `${ORIGIN}${debatePath(debate)}`,
        lastmod: isoDate(debate.debate_date)
      }))
    ]),
    urlSitemap("/sitemap-politiker.xml", [
      ...politicians.map((person) => ({ loc: `${ORIGIN}${politicianPath(person)}` }))
    ]),
    urlSitemap("/sitemap-parti.xml", [
      ...parties.map((party) => ({ loc: `${ORIGIN}${partyPath(party)}` }))
    ]),
    // Indexable app surfaces only. Account routes are `noindex` and excluded.
    urlSitemap("/sitemap-sidor.xml", [
      { loc: `${ORIGIN}/` },
      { loc: `${ORIGIN}/senaste/` },
      { loc: `${ORIGIN}/sok/` },
      { loc: `${ORIGIN}/legal/about/` },
      { loc: `${ORIGIN}/legal/terms/` },
      { loc: `${ORIGIN}/legal/privacy/` },
      { loc: `${ORIGIN}/legal/storage/` }
    ])
  ];

  for (const child of children) {
    await writeFile(join(DIST, child.path.replace(/^\//, "")), child.xml, "utf8");
  }
  await writeFile(join(DIST, "sitemap.xml"), sitemapIndex(children, newest), "utf8");

  const robotsPath = join(DIST, "robots.txt");
  const robots = await readFile(robotsPath, "utf8");
  if (!/^Sitemap:/m.test(robots)) {
    await writeFile(robotsPath, `${robots.trimEnd()}\n\nSitemap: ${ORIGIN}/sitemap.xml\n`, "utf8");
  }

  return children.length + 1;
}

/** Group rows by a key, skipping rows whose key is null. */
function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) {
      continue;
    }
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return groups;
}

/** Page through a small public table. */
async function fetchAll(url, key, table, select) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URLSearchParams({
      select,
      order: "id.asc",
      limit: String(PAGE_SIZE),
      offset: String(offset)
    });
    if (table === "party_profiles") {
      query.set("order", "display_order.asc");
    }
    const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`${table} request failed: ${response.status} ${response.statusText}`);
    }
    const batch = await response.json();
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) {
      return rows;
    }
  }
}

main().catch((error) => {
  // Never fail the build. A missing SEO surface is recoverable; a failed deploy
  // takes the site down.
  log(`unexpected failure, leaving the build intact: ${error.message}`);
});
