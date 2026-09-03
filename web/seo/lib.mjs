/**
 * Pure helpers for the SEO prerenderer.
 *
 * Kept free of filesystem and network access so `web/tests/seo-prerender.test.mjs`
 * can assert on the exact markup and metadata that ship, without a build or a
 * Supabase round trip.
 */

/** Escape text for HTML text nodes and double-quoted attribute values. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize JSON-LD for inline embedding.
 *
 * `<` is escaped so a transcript containing `</script>` cannot terminate the
 * block early. JSON string escapes keep it valid JSON either way.
 */
export function jsonLd(value) {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

const TRANSLITERATION = {
  å: "a",
  ä: "a",
  ö: "o",
  á: "a",
  à: "a",
  é: "e",
  è: "e",
  ë: "e",
  í: "i",
  ó: "o",
  ô: "o",
  ú: "u",
  ü: "u",
  ø: "o",
  æ: "ae",
  ß: "ss",
  ñ: "n",
  ç: "c"
};

/**
 * Build a URL slug from Swedish text.
 *
 * Slugs are decorative. Identity always lives in its own path segment, so a
 * stale or truncated slug never makes a URL ambiguous.
 */
export function slugify(value, maxLength = 60) {
  const lowered = String(value ?? "").toLowerCase();
  let out = "";
  for (const character of lowered) {
    out += TRANSLITERATION[character] ?? character;
  }
  const slug = out
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "klipp";
}

/**
 * Strip Riksdagen's role prefix and parenthesised party from a display name.
 *
 * Mirrors `cleanName` in `web/src/App.tsx`, because a politician's slug and the
 * name shown in the app must not disagree. "Infrastruktur- och
 * bostadsministern Andreas Carlson (KD)" becomes "Andreas Carlson".
 */
export function cleanName(name) {
  return String(name ?? "")
    .replace(/\([^)]*\)/g, "")
    .replace(/^.*ministern\s+/i, "")
    .replace(/^(Statsrådet|Ledamoten|Talmannen)\s+/i, "")
    .trim();
}

/** Swedish long-form date, e.g. "12 juni 2026". Falls back to the raw value. */
export function formatSwedishDate(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat("sv-SE", {
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);
}

/**
 * W3C date for `<lastmod>` and `<video:publication_date>`.
 *
 * A full timestamp is passed through as-is; a bare `YYYY-MM-DD` stays a bare
 * date, which the sitemap spec allows and which avoids inventing a time the row
 * never carried.
 */
export function isoDate(value) {
  if (!value) {
    return "";
  }
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** ISO 8601 duration for schema.org, e.g. 44.97 seconds -> "PT45S". */
export function isoDuration(seconds) {
  const total = Math.max(1, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? `PT${minutes}M${rest}S` : `PT${rest}S`;
}

/**
 * Trim text to a meta-description length on a word boundary.
 *
 * Search engines truncate around 155-160 characters, and a description cut
 * mid-word reads as broken.
 */
export function metaDescription(text, maxLength = 155) {
  const collapsed = String(text ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  const cut = collapsed.slice(0, maxLength);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 40 ? cut.slice(0, boundary) : cut).replace(/[.,;:\s]+$/, "")}…`;
}

/** The one embedded row PostgREST may return as an object or a single-item array. */
export function firstEmbedded(value) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

/**
 * Flatten a clip row and its embedded speech/politician/source into the shape
 * the templates use. Returns null when the row cannot make a truthful page.
 */
export function normalizeClip(row) {
  const speech = firstEmbedded(row?.speeches);
  const source = firstEmbedded(speech?.sources);
  const politician = firstEmbedded(speech?.politicians);

  if (!row?.id || !row?.url_540x960 || !row?.thumb_url || !speech || !source) {
    return null;
  }

  const displayName = politician?.name || speech.speaker_name || "";
  const name = cleanName(displayName) || displayName;
  if (!name) {
    return null;
  }

  return {
    id: row.id,
    party: speech.party ?? null,
    anforandetyp: speech.anforandetyp ?? null,
    name,
    displayName,
    politicianId: politician?.id ?? null,
    politicianRole: politician?.role ?? null,
    title: row.title ?? null,
    transcript: (row.transcript ?? "").trim(),
    durationS: Number(row.duration_s) || 0,
    videoUrl: row.url_540x960,
    thumbUrl: row.thumb_url,
    publishedAt: row.published_at ?? null,
    debateTitle: source.title ?? "",
    debateType: source.debate_type ?? null,
    debateDate: source.debate_date ?? null,
    dokid: source.dokid ?? null,
    sourceUrl: source.source_url ?? null
  };
}

/**
 * The canonical path for a clip's watch page.
 *
 * The id is its own final segment because `clip_id` is
 * `{dokid}_{anforande_id}_c{NN}` and Riksdagen's `anforande_id` is a GUID
 * containing hyphens — a `slug-id` form parsed from the right is not decidable.
 * See ADR 014.
 */
export function clipPath(clip) {
  const descriptor = [clip.name, clip.debateTitle].filter(Boolean).join(" ");
  return `/klipp/${slugify(descriptor)}/${encodeURIComponent(clip.id)}`;
}

/**
 * Session titles that name the sitting rather than its subject.
 *
 * `sources.title` is a real human-written subject for interpellation debates —
 * "Stöd till kollektivtrafiken" — which reads correctly as "X om <subject>".
 * For a chamber sitting the title is the format itself, and "Acko Ankarberg
 * Johansson om Frågestund" is simply wrong; it has to be "i Frågestund".
 * Measured 2026-09-03: 335 of 377 debates are subjects, 38 are Frågestund.
 */
const SESSION_TITLES = new Set([
  "frågestund",
  "statsministerns frågestund",
  "partiledardebatt",
  "allmänpolitisk debatt",
  "aktuell debatt",
  "budgetdebatt",
  "utrikespolitisk debatt",
  "debatt om vårändringsbudget",
  "särskild debatt"
]);

/** True when the debate title names the sitting, not a subject. */
export function isSessionTitle(clip) {
  const title = String(clip.debateTitle ?? "").trim().toLowerCase();
  if (!title) {
    return false;
  }
  // `kam-*` is Riksdagen's chamber-sitting family; `ip` is an interpellation,
  // whose title is always a subject. An unknown type keeps the subject
  // reading, which is right for 89% of the catalogue.
  return SESSION_TITLES.has(title) || String(clip.debateType ?? "").startsWith("kam-");
}

function debatePhrase(clip) {
  if (!clip.debateTitle) {
    return "";
  }
  return isSessionTitle(clip) ? ` i ${clip.debateTitle}` : ` om ${clip.debateTitle}`;
}

/** Party names by code. A clip row carries only the code. */
export const PARTY_NAMES = {
  S: "Socialdemokraterna",
  M: "Moderaterna",
  SD: "Sverigedemokraterna",
  C: "Centerpartiet",
  V: "Vänsterpartiet",
  KD: "Kristdemokraterna",
  MP: "Miljöpartiet",
  L: "Liberalerna"
};

/**
 * The canonical path for a politician hub.
 *
 * The name slug is decorative; `politicians.id` in the final segment is the
 * identity (`Q-2`). `/politiker/<id>` without the slug is generated too and
 * canonicalises here, because the app pushes that form before the profile row
 * arrives and a reloaded or shared URL must never 404.
 *
 * `personPathSlug` in `web/src/navigation.ts` must produce the same slug as
 * `slugify` does here; `web/tests/path-routing.test.mjs` fails on drift.
 */
export function politicianPath(politician) {
  const name = cleanName(politician.name) || politician.name || "";
  return `/politiker/${slugify(name)}/${encodeURIComponent(politician.id)}`;
}

/** The party hub path, using the readable name rather than the code. */
export function partyPath(party) {
  const name = party.name || PARTY_NAMES[party.code] || party.code || "";
  return `/parti/${slugify(name)}`;
}

/** The party path for a clip, which carries only the party code. */
export function partyPathForCode(code) {
  return partyPath({ code, name: PARTY_NAMES[code] });
}

/** Page title. Never trusts `clips.title` alone — see the note in ADR 014. */
export function clipTitle(clip) {
  const date = formatSwedishDate(clip.debateDate);
  const dateSuffix = date ? ` — ${date}` : "";
  return `${clipHeading(clip)}${dateSuffix} | Pleni`;
}

/** The visible page heading. Same facts as the title, without the site suffix. */
export function clipHeading(clip) {
  const party = clip.party ? ` (${clip.party})` : "";
  return `${clip.name}${party}${debatePhrase(clip)}`;
}

export function clipDescription(clip) {
  const lead = clip.transcript || clip.debateTitle;
  const date = formatSwedishDate(clip.debateDate);
  const context = date ? `${clip.name} i riksdagsdebatten ${date}. ` : `${clip.name}. `;
  return metaDescription(clip.transcript ? `${context}${lead}` : context.trim());
}
