import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isoDate, normalizeClip } from "../seo/lib.mjs";
import { debatePath, renderDebatePage, renderPartyHub, renderPoliticianHub } from "../seo/hubs.mjs";
import { URLS_PER_SITEMAP, clipSitemaps, sitemapIndex, urlSitemap } from "../seo/sitemaps.mjs";

/**
 * SEO3 and SEO5 — hubs, debate pages and sitemaps.
 *
 * The sitemap assertions matter most: a malformed file is rejected wholesale by
 * Google, and an entry for an unpublished clip would leak a page that must not
 * exist.
 */

const BUILT = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

function row(overrides = {}, speech = {}, source = {}) {
  return {
    id: "HD10533_47a16b6f-7d66-f111-8b6f-6805cafea079_c01",
    title: "Kriget i Iran och stängningen av Hormuzsundet har inneburit",
    transcript: "Kriget i Iran har inneburit en betydande störning på energimarknaderna.",
    duration_s: 44.97,
    url_540x960: "https://riketnlooigm.b-cdn.net/clips/2026/06/x_540x960.mp4",
    thumb_url: "https://riketnlooigm.b-cdn.net/thumbs/2026/06/x.webp",
    published_at: "2026-08-09T04:25:03.516168+00:00",
    ...overrides,
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
      ...speech,
      sources: {
        dokid: "HD10533",
        title: "Stöd till kollektivtrafiken",
        debate_type: "ip",
        debate_date: "2026-06-12",
        source_url: "https://www.riksdagen.se/sv/webb-tv/video/x_hd10533/",
        ...source
      }
    }
  };
}

const CLIP = normalizeClip(row());
const POLITICIAN = {
  id: "490b6787-c178-42e1-9ab8-e9d233939643",
  intressent_id: "0339358847",
  name: "Infrastruktur- och bostadsministern Andreas Carlson (KD)",
  party: "KD",
  role: "minister",
  constituency: null,
  avatar_url: "https://riketnlooigm.b-cdn.net/portraits/0339358847/abc.jpg"
};
const PARTY = {
  code: "KD",
  name: "Kristdemokraterna",
  short_name: "Kristdemokr.",
  color: "#005CA9",
  logo_url: "https://riketnlooigm.b-cdn.net/party-logos/kd/abc.png",
  display_order: 6
};

function graphOf(html, index = -1) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const block = blocks.at(index);
  assert.ok(block, "page must carry JSON-LD");
  return JSON.parse(block[1])["@graph"];
}

test("a politician hub carries identity, its own canonical and real clip links", () => {
  const html = renderPoliticianHub(BUILT, POLITICIAN, [CLIP]);

  assert.match(html, /<title>Andreas Carlson \(KD\) — klipp från riksdagsdebatter \| Pleni<\/title>/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/pleni\.se\/politiker\/490b6787-c178-42e1-9ab8-e9d233939643" \/>/
  );
  assert.equal(html.includes('href="/klipp/andreas-carlson-stod-till-kollektivtrafiken/'), true);

  // Crawlable content sits inside `#root`; the app replaces it on mount.
  assert.match(html, /<div id="root"><div class="seo-hub">/);
  assert.match(html, /<script type="module"/);

  const [profile, list, crumbs] = graphOf(html);
  assert.equal(profile["@type"], "ProfilePage");
  assert.equal(profile.mainEntity.name, "Andreas Carlson");
  assert.equal(profile.mainEntity.jobTitle, "Statsråd");
  assert.equal(profile.mainEntity.image, POLITICIAN.avatar_url);
  assert.match(profile.mainEntity.sameAs, /riksdagen\.se.*0339358847/);
  assert.equal(list["@type"], "ItemList");
  assert.equal(list.numberOfItems, 1);
  assert.equal(crumbs["@type"], "BreadcrumbList");
});

test("hubs never reference a provenance URL", () => {
  const withSource = {
    ...POLITICIAN,
    avatar_source_url: "https://bilder.riksdagen.se/publishedmedia/x.jpg"
  };
  const politicianHtml = renderPoliticianHub(BUILT, withSource, [CLIP]);
  const partyHtml = renderPartyHub(
    BUILT,
    { ...PARTY, logo_source_url: "https://bilder.riksdagen.se/publishedmedia/logo.png" },
    [POLITICIAN],
    [CLIP]
  );

  for (const html of [politicianHtml, partyHtml]) {
    assert.equal(html.includes("bilder.riksdagen.se"), false);
    assert.equal(html.includes("_source_url"), false);
  }
});

test("a party hub lists its roster and uses the verified logo", () => {
  const html = renderPartyHub(BUILT, PARTY, [POLITICIAN], [CLIP]);

  assert.match(html, /<title>Kristdemokraterna — klipp från riksdagsdebatter \| Pleni<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/pleni\.se\/parti\/kd" \/>/);
  assert.match(html, /href="\/politiker\/490b6787-c178-42e1-9ab8-e9d233939643"/);

  const graph = graphOf(html);
  const organization = graph.find((node) => node["@type"] === "Organization");
  assert.equal(organization.name, "Kristdemokraterna");
  assert.equal(organization.alternateName, "KD");
  assert.equal(organization.logo, PARTY.logo_url);
  assert.ok(graph.some((node) => node["@type"] === "CollectionPage"));
});

test("a debate page is fully static and groups clips by speaker", () => {
  const second = normalizeClip(
    row(
      { id: "HD10533_other_c01", title: "Ett annat klipp" },
      {
        speaker_name: "Zara Leghissa (S)",
        party: "S",
        politician_id: "aaa",
        politicians: { id: "aaa", name: "Zara Leghissa (S)", role: "ledamot" }
      }
    )
  );
  const debate = {
    dokid: "HD10533",
    title: "Stöd till kollektivtrafiken",
    debate_type: "ip",
    debate_date: "2026-06-12",
    source_url: "https://www.riksdagen.se/sv/webb-tv/video/x_hd10533/"
  };

  const html = renderDebatePage(debate, [CLIP, second]);

  assert.equal(debatePath(debate), "/debatt/stod-till-kollektivtrafiken/HD10533");
  assert.match(html, /<h1>Stöd till kollektivtrafiken<\/h1>/);
  assert.match(html, /2 klipp · 2 talare/);
  assert.ok(html.includes("Andreas Carlson (KD)"));
  assert.ok(html.includes("Zara Leghissa (S)"));
  assert.ok(html.includes(debate.source_url));

  // No app route exists for a debate, so nothing may hydrate here.
  assert.equal(/<script type="module"/.test(html), false);
  assert.equal(html.includes('id="root"'), false);

  const graph = graphOf(html);
  assert.equal(graph[0]["@type"], "CollectionPage");
  assert.equal(graph[1].numberOfItems, 2);
});

test("clip sitemaps shard at the configured size and stay inside the spec limits", () => {
  const many = Array.from({ length: URLS_PER_SITEMAP + 3 }, (_, index) => ({
    ...CLIP,
    id: `HD10533_x_c${index}`
  }));
  const shards = clipSitemaps(many);

  assert.equal(shards.length, 2);
  assert.equal(shards[0].path, "/sitemap-klipp-1.xml");
  assert.equal(shards[1].path, "/sitemap-klipp-2.xml");
  assert.ok(URLS_PER_SITEMAP <= 50000, "a sitemap may hold at most 50 000 URLs");
  assert.equal((shards[0].xml.match(/<url>/g) ?? []).length, URLS_PER_SITEMAP);
  assert.equal((shards[1].xml.match(/<url>/g) ?? []).length, 3);
  assert.ok(Buffer.byteLength(shards[0].xml) < 50 * 1024 * 1024);
});

test("a clip sitemap entry carries every field Google needs", () => {
  const [shard] = clipSitemaps([CLIP]);

  assert.match(shard.xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(shard.xml, /xmlns:video="http:\/\/www\.google\.com\/schemas\/sitemap-video\/1\.1"/);
  for (const element of [
    "video:thumbnail_loc",
    "video:title",
    "video:description",
    "video:content_loc",
    "video:duration",
    "video:publication_date",
    "video:family_friendly"
  ]) {
    assert.match(shard.xml, new RegExp(`<${element}>`), `${element} is missing`);
  }
  assert.match(shard.xml, /<video:duration>45<\/video:duration>/);
  assert.match(shard.xml, /<loc>https:\/\/pleni\.se\/klipp\//);
});

test("duration is clamped to the 1-28800 second range the spec allows", () => {
  assert.match(clipSitemaps([{ ...CLIP, durationS: 0 }])[0].xml, /<video:duration>1</);
  assert.match(clipSitemaps([{ ...CLIP, durationS: 99999 }])[0].xml, /<video:duration>28800</);
});

test("XML-hostile text cannot break a sitemap", () => {
  const nasty = normalizeClip(
    row({ transcript: "5 < 6 & \"citat\" 'x'" }, {}, { title: "A & B <tag>" })
  );
  const [shard] = clipSitemaps([nasty]);

  assert.equal(shard.xml.includes("<tag>"), false);
  assert.match(shard.xml, /&amp;/);
  assert.doesNotThrow(() => {
    // A malformed sitemap is rejected wholesale, so well-formedness is the
    // property that matters, not prettiness.
    const openTags = (shard.xml.match(/<url>/g) ?? []).length;
    const closeTags = (shard.xml.match(/<\/url>/g) ?? []).length;
    assert.equal(openTags, closeTags);
  });
});

test("the index lists every child and only sitemap files", () => {
  const children = [
    ...clipSitemaps([CLIP]),
    urlSitemap("/sitemap-parti.xml", [{ loc: "https://pleni.se/parti/kd" }])
  ];
  const index = sitemapIndex(children, "2026-09-03T00:00:00.000Z");

  assert.match(index, /<sitemapindex/);
  assert.equal((index.match(/<sitemap>/g) ?? []).length, 2);
  assert.match(index, /<loc>https:\/\/pleni\.se\/sitemap-klipp-1\.xml<\/loc>/);
  assert.match(index, /<lastmod>2026-09-03T00:00:00\.000Z<\/lastmod>/);
});

test("dates serialize without inventing a time the row never had", () => {
  assert.equal(isoDate("2026-06-12"), "2026-06-12");
  assert.equal(isoDate("2026-08-09T04:25:03.516168+00:00"), "2026-08-09T04:25:03.516Z");
  assert.equal(isoDate(null), "");
  assert.equal(isoDate("not a date"), "");
});

test("the generator's sitemaps exclude account routes", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../seo/prerender.mjs", import.meta.url)),
    "utf8"
  );
  const pages = source.match(/urlSitemap\("\/sitemap-sidor\.xml",[\s\S]*?\]\)/);
  assert.ok(pages, "the page sitemap must exist");
  for (const account of ["/profil", "/sparade", "/foljer"]) {
    assert.equal(
      pages[0].includes(`${account}\``) || pages[0].includes(`${account}"`),
      false,
      `${account} must never be listed in a sitemap`
    );
  }
});
