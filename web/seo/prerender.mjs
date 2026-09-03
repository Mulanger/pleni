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

import { clipPath, normalizeClip } from "./lib.mjs";
import { ORIGIN, renderClipPage, renderShellPage } from "./templates.mjs";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WEB_ROOT, "dist");
const PAGE_SIZE = 500;
const RELATED_PER_CLIP = 6;

const CLIP_SELECT = [
  "id",
  "title",
  "transcript",
  "duration_s",
  "url_540x960",
  "thumb_url",
  "published_at",
  "speeches(speaker_name,party,anforandetyp,politician_id," +
    "politicians(id,name,role)," +
    "sources(dokid,title,debate_type,debate_date,source_url))"
].join(",");

/**
 * Shells for the routes the SPA owns.
 *
 * Mirrors `APP_SHELL_ROUTES` in `web/src/navigation.ts`; the prerender test
 * asserts the two lists agree, because a pushable path without a file 404s on
 * reload and on share.
 */
const APP_SHELLS = [
  { path: "/senaste", title: "Senaste klippen | Pleni", description: "De senaste klippen från svenska riksdagsdebatter — talare, parti och debatt för varje klipp." },
  { path: "/sok", title: "Sök i riksdagsdebatter | Pleni", description: "Sök bland klipp från svenska riksdagsdebatter på politiker, parti, ämne eller datum." },
  { path: "/foljer", title: "Följer | Pleni", description: "Politiker och partier du följer på Pleni.", robots: "noindex, follow" },
  { path: "/profil", title: "Profil | Pleni", description: "Ditt konto, dina intressen och dina inställningar på Pleni.", robots: "noindex, follow" },
  { path: "/sparade", title: "Sparade klipp | Pleni", description: "Klipp du sparat på Pleni.", robots: "noindex, follow" },
  { path: "/sparade/klipp", title: "Sparade klipp | Pleni", description: "Klipp du sparat på Pleni.", robots: "noindex, follow" },
  { path: "/legal/terms", title: "Användarvillkor | Pleni", description: "Villkoren för att använda Pleni." },
  { path: "/legal/privacy", title: "Integritetspolicy | Pleni", description: "Hur Pleni behandlar personuppgifter." },
  { path: "/legal/storage", title: "Lagring och cookies | Pleni", description: "Vad Pleni lagrar i din webbläsare och varför." },
  { path: "/legal/about", title: "Om Pleni", description: "Pleni klipper svenska riksdagsdebatter till korta videor med länk till originalet." }
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
 * Entity shells keep `/politiker/<id>` and `/parti/<code>` from 404ing on
 * direct entry. They are `noindex` until SEO3 gives them real hub content.
 */
async function writeEntityShells(builtHtml, politicianIds) {
  let written = 0;
  const targets = [
    ...politicianIds.flatMap((id) => {
      const base = `/politiker/${encodeURIComponent(id)}`;
      return [base, `${base}/klipp`];
    }),
    ...PARTY_CODES.flatMap((code) => [`/parti/${code}`, `/parti/${code}/klipp`])
  ];

  for (const path of targets) {
    const html = renderShellPage(builtHtml, {
      title: "Pleni — riksdagsdebatter som korta klipp",
      description:
        "Klipp från svenska riksdagsdebatter, med talare, parti, debatt och länk till originalet.",
      canonical: `${ORIGIN}${path}`,
      robots: "noindex, follow"
    });
    await writePage(path, html);
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
    await writePage(clipPath(clip), renderClipPage(clip, neighbours));
    written += 1;
  }

  const politicianIds = [...new Set(clips.map((clip) => clip.politicianId).filter(Boolean))];
  const entityCount = await writeEntityShells(builtHtml, politicianIds);

  log("clip watch pages written", { pages: written, skipped, debates: byDebate.size });
  log("entity shells written", { pages: entityCount, politicians: politicianIds.length });
}

main().catch((error) => {
  // Never fail the build. A missing SEO surface is recoverable; a failed deploy
  // takes the site down.
  log(`unexpected failure, leaving the build intact: ${error.message}`);
});
