import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { APP_SHELL_ROUTES } from "../src/navigation.ts";
import {
  clipDescription,
  clipHeading,
  clipPath,
  clipTitle,
  escapeHtml,
  isoDuration,
  isSessionTitle,
  jsonLd,
  metaDescription,
  normalizeClip,
  slugify
} from "../seo/lib.mjs";
import { renderClipPage, renderShellPage } from "../seo/templates.mjs";

/**
 * SEO2 — prerendered watch pages.
 *
 * The properties asserted here are the ones whose breakage is invisible: a page
 * that needs JavaScript to show its video, a transcript that escapes its own
 * JSON-LD block, a shell that inherits the home page's canonical, or a pushable
 * path with no file behind it.
 */

const ROW = {
  id: "HD10533_47a16b6f-7d66-f111-8b6f-6805cafea079_c01",
  title: "Kriget i Iran och stängningen av Hormuzsundet har inneburit",
  transcript:
    "Kriget i Iran och stängningen av Hormuzsundet har inneburit en betydande störning på de globala energimarknaderna. Högre energipriser medför att hushållen förlorar köpkraft.",
  duration_s: 44.972142857142856,
  url_540x960: "https://riketnlooigm.b-cdn.net/clips/2026/06/x_540x960.mp4",
  thumb_url: "https://riketnlooigm.b-cdn.net/thumbs/2026/06/x.webp",
  published_at: "2026-08-09T04:25:03.516168+00:00",
  speeches: {
    speaker_name: "Infrastruktur- och bostadsministern Andreas Carlson (KD)",
    party: "KD",
    anforandetyp: "Svar",
    politician_id: "490b6787-c178-42e1-9ab8-e9d233939643",
    politicians: {
      id: "490b6787-c178-42e1-9ab8-e9d233939643",
      name: "Infrastruktur- och bostadsministern Andreas Carlson (KD)",
      role: "minister"
    },
    sources: {
      dokid: "HD10533",
      title: "Stöd till kollektivtrafiken",
      debate_type: "ip",
      debate_date: "2026-06-12",
      source_url: "https://www.riksdagen.se/sv/webb-tv/video/interpellationsdebatt/x_hd10533/"
    }
  }
};

const CLIP = normalizeClip(ROW);

function ldGraph(html) {
  const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(block, "page must carry JSON-LD");
  return JSON.parse(block[1])["@graph"];
}

test("a clip row flattens into the fields a page needs", () => {
  assert.equal(CLIP.name, "Andreas Carlson");
  assert.equal(CLIP.displayName, "Infrastruktur- och bostadsministern Andreas Carlson (KD)");
  assert.equal(CLIP.party, "KD");
  assert.equal(CLIP.debateTitle, "Stöd till kollektivtrafiken");
  assert.equal(CLIP.dokid, "HD10533");
});

test("rows that cannot make a truthful page are dropped, not guessed at", () => {
  for (const broken of [
    null,
    {},
    { ...ROW, url_540x960: null },
    { ...ROW, thumb_url: null },
    { ...ROW, speeches: null },
    { ...ROW, speeches: { ...ROW.speeches, sources: null } },
    { ...ROW, speeches: { ...ROW.speeches, speaker_name: "", politicians: null } }
  ]) {
    assert.equal(normalizeClip(broken), null);
  }
});

test("PostgREST embeds are accepted as an object or a single-item array", () => {
  const arrayShaped = {
    ...ROW,
    speeches: [{ ...ROW.speeches, politicians: [ROW.speeches.politicians], sources: [ROW.speeches.sources] }]
  };
  assert.deepEqual(normalizeClip(arrayShaped), CLIP);
});

test("the clip id is its own path segment, so a GUID's hyphens stay harmless", () => {
  const path = clipPath(CLIP);
  assert.equal(
    path,
    "/klipp/andreas-carlson-stod-till-kollektivtrafiken/HD10533_47a16b6f-7d66-f111-8b6f-6805cafea079_c01/"
  );
  assert.equal(path.split("/").filter(Boolean).at(-1), CLIP.id);
});

test("titles say 'om' for a subject and 'i' for a sitting", () => {
  assert.equal(
    clipTitle(CLIP),
    "Andreas Carlson (KD) om Stöd till kollektivtrafiken — 12 juni 2026 | Pleni"
  );

  const questionHour = normalizeClip({
    ...ROW,
    speeches: {
      ...ROW.speeches,
      sources: { ...ROW.speeches.sources, title: "Frågestund", debate_type: "kam-fs" }
    }
  });
  assert.equal(isSessionTitle(questionHour), true);
  assert.equal(clipHeading(questionHour), "Andreas Carlson (KD) i Frågestund");
  assert.equal(isSessionTitle(CLIP), false);
});

test("the page title never leans on the truncated clip title alone", () => {
  // `src/scoring/titles.py` emits mid-sentence fragments. They are fine as a
  // feed overlay and wrong as an indexed headline under a real person's byline.
  assert.equal(clipTitle(CLIP).includes(ROW.title), false);
  assert.equal(clipHeading(CLIP).includes("har inneburit"), false);
});

test("descriptions stay inside search-result length and end on a word", () => {
  const description = clipDescription(CLIP);
  assert.ok(description.length <= 156, `too long: ${description.length}`);
  assert.equal(/\s…$|[^\s]$/.test(description), true);
  assert.equal(metaDescription("kort text"), "kort text");
  assert.equal(metaDescription("a".repeat(200)).endsWith("…"), true);
});

test("Swedish characters transliterate rather than vanish from slugs", () => {
  assert.equal(slugify("Stöd till kollektivtrafiken"), "stod-till-kollektivtrafiken");
  assert.equal(slugify("Kärnkraft & Åsa Ödman"), "karnkraft-asa-odman");
  assert.equal(slugify("!!!"), "klipp");
  assert.equal(slugify("a".repeat(200)).length <= 60, true);
});

test("durations serialize as ISO 8601", () => {
  assert.equal(isoDuration(44.97), "PT45S");
  assert.equal(isoDuration(95), "PT1M35S");
  assert.equal(isoDuration(0), "PT1S");
});

test("the watch page shows video, transcript and source without any script", () => {
  const html = renderClipPage(CLIP, []);
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, "");

  assert.match(withoutScripts, /<video[^>]*controls/);
  assert.match(withoutScripts, new RegExp(`src="${CLIP.videoUrl.replace(/[/.]/g, "\\$&")}"`));
  assert.match(withoutScripts, /poster="https:\/\/riketnlooigm/);
  assert.ok(withoutScripts.includes("Högre energipriser medför"), "transcript must be in the body");
  assert.ok(withoutScripts.includes(CLIP.sourceUrl), "Riksdagen source link must be in the body");
  assert.match(withoutScripts, /<h1>Andreas Carlson \(KD\) om Stöd till kollektivtrafiken<\/h1>/);

  // Nothing on a watch page may depend on the SPA bundle.
  assert.equal(/<script type="module"/.test(html), false);
  assert.equal(html.includes('id="root"'), false);
});

test("the watch page publishes a complete VideoObject and BreadcrumbList", () => {
  const [video, crumbs] = ldGraph(renderClipPage(CLIP, []));

  assert.equal(video["@type"], "VideoObject");
  for (const required of ["name", "thumbnailUrl", "uploadDate"]) {
    assert.ok(video[required], `VideoObject.${required} is required by Google`);
  }
  assert.equal(video.duration, "PT45S");
  assert.equal(video.contentUrl, CLIP.videoUrl);
  assert.equal(video.inLanguage, "sv-SE");
  assert.equal(video.creator.name, "Andreas Carlson");
  assert.equal(video.isBasedOn, CLIP.sourceUrl);
  assert.ok(video.transcript.includes("Hormuzsundet"));

  assert.equal(crumbs["@type"], "BreadcrumbList");
  assert.deepEqual(
    crumbs.itemListElement.map((item) => item.position),
    [1, 2, 3]
  );
  assert.equal(crumbs.itemListElement.at(-1).item, `https://pleni.se${clipPath(CLIP)}`);
});

test("a clip with no linked politician still renders and drops the person crumb", () => {
  const orphan = normalizeClip({
    ...ROW,
    speeches: { ...ROW.speeches, politician_id: null, politicians: null }
  });
  assert.equal(orphan.politicianId, null);

  const html = renderClipPage(orphan, []);
  const [, crumbs] = ldGraph(html);
  assert.deepEqual(
    crumbs.itemListElement.map((item) => item.position),
    [1, 2]
  );
  assert.equal(html.includes("/politiker/null"), false);
  assert.equal(html.includes("Alla klipp med"), false);
});

test("hostile text cannot break out of markup or the JSON-LD block", () => {
  const nasty = normalizeClip({
    ...ROW,
    transcript: 'Hon sa "nej" </script><script>alert(1)</script> & <b>fetstil</b>',
    speeches: {
      ...ROW.speeches,
      sources: { ...ROW.speeches.sources, title: '"><img src=x onerror=alert(1)>' }
    }
  });
  const html = renderClipPage(nasty, []);

  // What matters is that no attacker-supplied tag can ever open. Inside the
  // JSON-LD block `<` is escaped to `<`, so the words `onerror=alert`
  // survive as inert text in a JSON string while no element can start.
  assert.equal(/<img/i.test(html), false);
  assert.equal(/<script>\s*alert/i.test(html), false);
  assert.equal(/<b>fetstil<\/b>/.test(html), false);
  assert.equal(html.includes("</script><script>"), false);

  // Exactly one script element, and it is the JSON-LD block.
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.deepEqual(scripts, ['<script type="application/ld+json">']);

  // The JSON-LD must still parse, with the transcript intact inside it.
  const [video] = ldGraph(html);
  assert.ok(video.transcript.includes("</script>"));
  assert.ok(video.name.includes("<img"), "the title survives as data, not markup");
  assert.equal(escapeHtml('<a href="x">'), "&lt;a href=&quot;x&quot;&gt;");
  assert.equal(jsonLd({ a: "</script>" }).includes("</script>"), false);
});

test("related clips link to real neighbouring pages", () => {
  const other = normalizeClip({ ...ROW, id: "HD10533_other_c02" });
  const html = renderClipPage(CLIP, [other]);
  assert.ok(html.includes(clipPath(other)));
  assert.match(html, /Fler klipp från samma debatt/);
});

test("shells inherit the built document and carry their own identity", () => {
  const builtHtml = readFileSync(
    fileURLToPath(new URL("../index.html", import.meta.url)),
    "utf8"
  );
  const shell = renderShellPage(builtHtml, {
    title: "Sök i riksdagsdebatter | Pleni",
    description: "Sök bland klipp från svenska riksdagsdebatter.",
    canonical: "https://pleni.se/sok",
    robots: "noindex, follow"
  });

  assert.match(shell, /<title>Sök i riksdagsdebatter \| Pleni<\/title>/);
  assert.match(shell, /<link rel="canonical" href="https:\/\/pleni\.se\/sok" \/>/);
  assert.match(shell, /<meta property="og:url" content="https:\/\/pleni\.se\/sok" \/>/);
  assert.match(shell, /<meta name="robots" content="noindex, follow" \/>/);

  // The home page's own identity must not survive into a shell.
  assert.equal(shell.includes('href="https://pleni.se/"'), false);
  assert.equal(/<title>Pleni — riksdagsdebatter som korta klipp<\/title>/.test(shell), false);
  // The SPA entry and mount point must survive, or the shell boots nothing.
  assert.match(shell, /<div id="root">/);
  assert.match(shell, /<script type="module"/);
});

test("a head change that breaks shell patching fails loudly", () => {
  assert.throws(
    () => renderShellPage("<!doctype html><html><head></head><body></body></html>", {
      title: "x",
      description: "y",
      canonical: "https://pleni.se/x"
    }),
    /no longer matches/
  );
});

test("every app shell route the router can push is generated", async () => {
  const source = readFileSync(
    fileURLToPath(new URL("../seo/prerender.mjs", import.meta.url)),
    "utf8"
  );
  const generated = [...source.matchAll(/\{ path: "([^"]+)"/g)].map((match) => match[1]);

  // `/` is served by dist/index.html itself and needs no shell.
  for (const route of APP_SHELL_ROUTES.filter((path) => path !== "/")) {
    assert.ok(generated.includes(route), `${route} is pushable but never generated`);
  }
});

test("account surfaces are noindex in the generator, not just in robots.txt", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../seo/prerender.mjs", import.meta.url)),
    "utf8"
  );
  for (const path of ["/profil/", "/sparade/", "/sparade/klipp/", "/foljer/"]) {
    const entry = source.match(new RegExp(`\\{ path: "${path}"[^}]*\\}`));
    assert.ok(entry, `${path} must be generated`);
    assert.match(entry[0], /robots: "noindex/, `${path} must be noindex`);
  }
});
