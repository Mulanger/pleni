/**
 * SEO3 — hub pages.
 *
 * Politician and party hubs are app shells carrying prerendered content, so a
 * direct visit still gets the real Pleni screen while a crawler gets identity,
 * counts and real links to watch pages. Debate pages are fully static, because
 * the app has no debate route to hand over to.
 *
 * Hubs list the most recent clips rather than paginating. The sitemap is the
 * complete index (SEO5); a hub's job is topical clustering and crawl depth. Note
 * that query-string pagination cannot work at all on a host that serves files —
 * `/parti/m?sida=2` and `/parti/m` are the same file — so a paginated hub would
 * need real `/sida/<n>` paths, which is only worth building if the sitemap
 * proves insufficient.
 */

import {
  PARTY_NAMES,
  cleanName,
  clipHeading,
  clipPath,
  escapeHtml,
  formatSwedishDate,
  jsonLd,
  metaDescription,
  partyPath,
  partyPathForCode,
  politicianPath,
  slugify
} from "./lib.mjs";
import { ORIGIN, renderShellPage, renderStaticPage } from "./templates.mjs";

const HUB_CLIP_LIMIT = 60;

/** `/debatt/<slug>/<dokid>/` — the dokid gets its own segment, as clip ids do. */
export function debatePath(debate) {
  return `/debatt/${slugify(debate.title)}/${encodeURIComponent(debate.dokid)}/`;
}

function clipListItems(clips) {
  return clips
    .map((clip) => {
      const label = clip.title ? metaDescription(clip.title, 80) : clipHeading(clip);
      const context = [
        clip.name,
        clip.party ? `(${clip.party})` : "",
        formatSwedishDate(clip.debateDate)
      ]
        .filter(Boolean)
        .join(" · ");
      return `          <li>
            <a href="${escapeHtml(clipPath(clip))}">${escapeHtml(label)}</a>
            <span>${escapeHtml(context)}</span>
          </li>`;
    })
    .join("\n");
}

function itemList(clips) {
  return {
    "@type": "ItemList",
    numberOfItems: clips.length,
    itemListElement: clips.map((clip, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url: `${ORIGIN}${clipPath(clip)}`,
      name: clipHeading(clip)
    }))
  };
}

function breadcrumbs(name, canonical) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Pleni", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name, item: canonical }
    ]
  };
}

/** A politician hub: identity, counts and their most recent clips. */
export function renderPoliticianHub(builtHtml, politician, clips) {
  const canonical = `${ORIGIN}${politicianPath(politician)}`;
  const name = cleanName(politician.name) || politician.name;
  const party = politician.party ? ` (${politician.party})` : "";
  const roleText = politician.role === "minister" ? "Statsråd" : "Riksdagsledamot";
  const title = `${name}${party} — klipp från riksdagsdebatter | Pleni`;
  const description = metaDescription(
    `${name}${party}, ${roleText.toLowerCase()}. ${clips.length} klipp från svenska ` +
      "riksdagsdebatter, med transkript och länk till originalet hos Riksdagen."
  );
  const shown = clips.slice(0, HUB_CLIP_LIMIT);

  const graph = [
    {
      "@type": "ProfilePage",
      "@id": `${canonical}#page`,
      url: canonical,
      inLanguage: "sv-SE",
      mainEntity: {
        "@type": "Person",
        name,
        jobTitle: roleText,
        // `avatar_url` only — `avatar_source_url` is provenance and must never
        // be requested by a page.
        ...(politician.avatar_url ? { image: politician.avatar_url } : {}),
        ...(politician.party
          ? { affiliation: { "@type": "Organization", name: politician.party } }
          : {}),
        ...(politician.intressent_id
          ? {
              sameAs:
                "https://www.riksdagen.se/sv/ledamoter-och-partier/ledamot/" +
                `_${politician.intressent_id}/`
            }
          : {})
      }
    },
    itemList(shown),
    breadcrumbs(name, canonical)
  ];

  const partySection = politician.party
    ? `      <h2>Parti</h2>
      <ul class="seo-inline">
        <li><a href="${escapeHtml(partyPathForCode(politician.party))}">${escapeHtml(
          PARTY_NAMES[politician.party] ?? politician.party
        )}</a></li>
      </ul>`
    : "";

  const prerender = `<div class="seo-hub">
      <h1>${escapeHtml(`${name}${party}`)}</h1>
      <p>${escapeHtml(`${roleText} · ${clips.length} klipp på Pleni`)}</p>
      <h2>Klipp med ${escapeHtml(name)}</h2>
      <ul>
${clipListItems(shown)}
      </ul>
${partySection}
    </div>`;

  return renderShellPage(builtHtml, { title, description, canonical, graph, prerender });
}

/** A party hub: mark, counts, roster and recent clips. */
export function renderPartyHub(builtHtml, party, politicians, clips) {
  const canonical = `${ORIGIN}${partyPath(party)}`;
  const title = `${party.name} — klipp från riksdagsdebatter | Pleni`;
  const description = metaDescription(
    `${party.name} i riksdagen: ${clips.length} klipp från ${politicians.length} politiker, ` +
      "med transkript och länk till originalet hos Riksdagen."
  );
  const shown = clips.slice(0, HUB_CLIP_LIMIT);

  const graph = [
    {
      // schema.org has no `PoliticalParty` type; `Organization` is the correct
      // general one and is what Google understands.
      "@type": "Organization",
      "@id": `${canonical}#organization`,
      name: party.name,
      alternateName: party.code,
      url: canonical,
      ...(party.logo_url ? { logo: party.logo_url } : {})
    },
    {
      "@type": "CollectionPage",
      url: canonical,
      inLanguage: "sv-SE",
      about: { "@id": `${canonical}#organization` }
    },
    itemList(shown),
    breadcrumbs(party.name, canonical)
  ];

  const roster = politicians
    .map(
      (person) =>
        `        <li><a href="${escapeHtml(politicianPath(person))}">${escapeHtml(
          cleanName(person.name) || person.name
        )}</a></li>`
    )
    .join("\n");

  const rosterSection = roster
    ? `      <h2>Politiker</h2>
      <ul class="seo-inline">
${roster}
      </ul>`
    : "";

  const prerender = `<div class="seo-hub">
      <h1>${escapeHtml(party.name)}</h1>
      <p>${escapeHtml(`${clips.length} klipp · ${politicians.length} politiker`)}</p>
      <h2>Senaste klippen</h2>
      <ul>
${clipListItems(shown)}
      </ul>
${rosterSection}
    </div>`;

  return renderShellPage(builtHtml, { title, description, canonical, graph, prerender });
}

/**
 * A debate page, fully static.
 *
 * `sources.title` is a real human-written subject for an interpellation debate,
 * so these are the pages most likely to match a Swedish topical search — which
 * matters more than usual while `clips.topic` is empty and SEO4 is deferred.
 */
export function renderDebatePage(debate, clips) {
  const canonical = `${ORIGIN}${debatePath(debate)}`;
  const date = formatSwedishDate(debate.debate_date);
  const heading = `${debate.title} — riksdagsdebatt ${date}`;
  const title = `${heading} | Pleni`;
  const speakers = [...new Set(clips.map((clip) => clip.name))];
  const description = metaDescription(
    `Riksdagsdebatten om ${debate.title} den ${date}. ${clips.length} klipp med ` +
      `${speakers.length} talare, med transkript och länk till originalet.`
  );

  const graph = [
    {
      "@type": "CollectionPage",
      url: canonical,
      name: heading,
      description,
      inLanguage: "sv-SE",
      ...(debate.debate_date ? { datePublished: debate.debate_date } : {}),
      ...(debate.source_url ? { isBasedOn: debate.source_url } : {})
    },
    itemList(clips),
    breadcrumbs(debate.title, canonical)
  ];

  const extraHead = `    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Pleni" />
    <meta property="og:locale" content="sv_SE" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta property="og:title" content="${escapeHtml(heading)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta name="twitter:card" content="summary" />
    <script type="application/ld+json">
${jsonLd({ "@context": "https://schema.org", "@graph": graph })}
    </script>
`;

  const bySpeaker = new Map();
  for (const clip of clips) {
    const key = `${clip.name}||${clip.party ?? ""}||${clip.politicianId ?? ""}`;
    const bucket = bySpeaker.get(key);
    if (bucket) {
      bucket.push(clip);
    } else {
      bySpeaker.set(key, [clip]);
    }
  }

  const sections = [...bySpeaker.entries()]
    .map(([key, speakerClips]) => {
      const [name, party, politicianId] = key.split("||");
      const label = `${name}${party ? ` (${party})` : ""}`;
      const link = politicianId
        ? `<a href="/politiker/${encodeURIComponent(politicianId)}/">${escapeHtml(label)}</a>`
        : escapeHtml(label);
      const items = speakerClips
        .map((clip) => {
          const text = clip.title ? metaDescription(clip.title, 80) : clipHeading(clip);
          return `        <li>
          <a href="${escapeHtml(clipPath(clip))}">${escapeHtml(text)}</a>
          <span>${escapeHtml(`${Math.round(clip.durationS)} sekunder`)}</span>
        </li>`;
        })
        .join("\n");
      return `      <h2>${link}</h2>
      <ul class="related">
${items}
      </ul>`;
    })
    .join("\n");

  const sourceNote = debate.source_url
    ? `      <p class="source">
        Källa: <a href="${escapeHtml(
          debate.source_url
        )}" rel="nofollow noopener">hela debatten hos Sveriges riksdag</a>.
      </p>`
    : "";

  const body = `      <nav class="crumbs">
        <a href="/">Pleni</a> › ${escapeHtml(debate.title)}
      </nav>
      <h1>${escapeHtml(debate.title)}</h1>
      <p class="byline">${escapeHtml(
        [date, `${clips.length} klipp`, `${speakers.length} talare`].filter(Boolean).join(" · ")
      )}</p>
${sections}
${sourceNote}
      <a class="cta" href="/senaste/">Öppna Pleni</a>`;

  return renderStaticPage({ title, description, canonical, extraHead, body });
}
