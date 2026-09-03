# ADR 014 — The SEO surface is prerendered static HTML

- **Status:** Accepted
- **Date:** 2026-09-03
- **Chunk:** SEO0
- **Supersedes / amends:** nothing. Complements ADR 005 (serving boundary and
  runtime) and ADR 006 (Clerk as sole identity provider, and the rule that the
  build must succeed without any `VITE_*` secret).

## Context

Pleni's catalogue is invisible to search engines. `web/src/navigation.ts` parses
routes out of the URL *fragment* (`routeFromHash`, described in the source as
"static-host-safe"). Search engines discard everything after `#`, so every route
in the app resolves to a single crawlable URL: `https://pleni.se/`.

That is not a metadata problem, it is an addressing problem. Before this ADR the
site also shipped no `robots.txt`, no canonical link, no description, no social
tags and no structured data, but fixing those alone would still have left exactly
one indexable page.

The catalogue behind that single URL is large and unusually well described.
Measured against production on 2026-09-03 with the publishable key:

| Measurement | Value |
|---|---|
| Published clips (`published_at is not null`, `moderation <> 'rejected'`) | 5 514 |
| Politicians | 364 |
| Debates (`sources`) | 377 |
| Clips with a non-null `topic` | **0** |

Each clip carries a title, a full Swedish transcript, duration, a Bunny MP4, a
WebP thumbnail, a publish timestamp, the speaker's name and party, the
`anforandetyp`, the debate title and date, and `sources.source_url` — the link
back to the primary source at riksdagen.se.

## Host facts established in SEO0

These were measured, not assumed. Each one constrains the implementation.

1. **An unknown deep path returns HTTP 404.** `https://pleni.se/klipp/test`
   returns 404, not the SPA shell. The pod is nginx 1.24.0 serving files, with
   **no SPA fallback rewrite**.
2. **No redirect and no custom headers are available.** `https://pleni.se/`,
   `https://www.pleni.se/` and `https://rikettv.nbg1-3.instapods.app/` all
   return HTTP 200 with byte-identical bodies (md5 `ee351be0…`) and no
   `Location`. The response carries no `Cache-Control` and no `X-Robots-Tag`.
   Host-level redirects and header injection are therefore assumed unavailable.
3. **InstaPods deploys from `origin/main` only.** No deploy webhook or scheduled
   build has been confirmed; SEO6 must establish the refresh mechanism.
4. **5 514 published clips**, so roughly 6 260 pages including hubs. That is a
   tractable build-time budget for a generator, not a scale problem.
5. **`clips.topic` is null for every published clip.** Topic pages have no data
   to stand on.
6. **Bunny is crawlable.** `https://riketnlooigm.b-cdn.net/robots.txt` returns
   404, which grants access rather than denying it, so Googlebot may fetch the
   MP4s referenced as `contentUrl`.
7. `https://pleni.se/robots.txt` returned 404 before this chunk.

## Decision

**Every public URL is a real static HTML file, written into `web/dist/` by a
generator that runs after `vite build` and is copied to the pod root by the
existing deploy command.**

Consequences of fact 1 make this the only workable shape: a path that has no file
404s, so a path-routed SPA cannot be indexed — or even deep-linked — unless a
file exists at that path. What SEO needs (a complete document per URL) and what
this host requires (a file per URL) are the same thing.

Four supporting decisions follow.

**The generator holds no secret.** It reads `public.clips`, `speeches`,
`politicians`, `sources` and `party_profiles` over PostgREST with the
publishable key under existing RLS. `clips_public_read` already restricts to
`moderation <> 'rejected' and published_at is not null`, which is exactly the
publication gate the SEO surface needs. Nothing more privileged is required, so
nothing more privileged is used.

**The generator degrades to a no-op.** CI builds with no `VITE_*` values on
purpose (ADR 006), and a deploy may be misconfigured. With no environment or an
unreachable Supabase, the generator logs, writes nothing and exits zero. A
failed prerender must never fail a deploy.

**Identity stays in its own path segment.** `clip_id` is
`{dokid}_{anforande_id}_c{NN}`, and `anforande_id` is a Riksdagen GUID
containing hyphens — a real sampled id is
`HD10533_47a16b6f-7d66-f111-8b6f-6805cafea079_c01`. A `slug-id` scheme parsed
from the right is therefore not decidable. URLs are
`/klipp/<slug>/<clip_id>` and `/politiker/<namn-slug>/<politicians.id>`, with
the slug decorative and the final segment authoritative. Politicians key on the
uuid because `politicians.id` is the identity gate (`Q-2`): the old name-slug
scheme split the five most-clipped ministers into two identities each — 380
clips, 21.6% of the catalogue, measured 2026-08-04.

**`pleni.se` apex is canonical.** Fact 2 means no redirect can enforce it, so
every generated page carries an absolute `<link rel="canonical">` to the apex
form. That is the only mechanism available and it is sufficient.

## Two things deliberately not done

**No `SearchAction` / sitelinks searchbox.** Pleni's search keeps the query text
in React memory and out of the URL by design
(`web/src/search/route.ts`: "query text and results stay in React memory").
There is no query-string search endpoint to point a searchbox at, and inventing
one would contradict that privacy choice for a minor rich-result feature.

**No `Sitemap:` line in `robots.txt` yet.** It lands in SEO5 together with the
sitemap index it names. Referring a crawler to a 404 is worse than saying
nothing.

## Consequences

- **Topic pages (SEO4) have no data.** With `topic` null across the catalogue,
  `/amne/*` cannot be built without a topic taxonomy in the pipeline. That is
  C-series work with its own ADR. SEO4 stays unbuilt rather than generating
  thin pages; nothing else in the plan depends on it.
- **Clip titles need review before they become indexed headlines.** The titles
  `src/scoring/titles.py` produces are truncated sentence fragments — a sampled
  one is "Kriget i Iran och stängningen av Hormuzsundet har inneburit". That
  reads acceptably as a feed overlay and poorly as a `<title>` under a named
  politician's byline. SEO2 must compose page titles from the speaker, party and
  debate title (`sources.title`, e.g. "Stöd till kollektivtrafiken") rather than
  trusting the clip title alone.
- **`speaker_name` carries a title prefix and the party** — for example
  "Infrastruktur- och bostadsministern Andreas Carlson (KD)". Name slugs must be
  derived after stripping the role prefix and the parenthesised party, and the
  result is still display text, never identity.
- **SEO1 cannot ship before SEO2.** Path routing without generated files would
  turn every deep link into a 404. They land in one deploy.
- **The service worker's precache is a hard constraint.** `web/vite.config.ts`
  globs `**/*.{html,js,css,json,png,svg,woff2}`. The generator must run after
  `vite build` so its thousands of HTML files never enter the manifest, and no
  future glob may add `xml` or `txt`.
- **Withdrawal is cheap.** Making the generator a no-op and deploying returns the
  site to its current single-page behaviour. Nothing in the pipeline, the
  database, Bunny or the feed participates.

## Alternatives rejected

**Server-side rendering.** There is no server. Adopting one would mean leaving
the InstaPods static runtime, which ADR 005 settled for reasons unrelated to SEO.

**Relying on Googlebot to render the SPA.** Google executes JavaScript, but its
video documentation is explicit that the video must be discoverable when the
watch page is rendered and must not depend on user interaction such as swiping.
A feed is exactly the pattern that guidance excludes. Prerendering removes the
question.

**A dynamic sitemap from a Supabase Edge Function.** A sitemap must be served
from the host it describes, and fact 1 shows the pod cannot route a path to a
function. Freshness is handled by a scheduled rebuild instead (SEO6).

**Keeping hash routes and adding metadata.** Produces one indexable URL with
better metadata. It does not address the problem.

---

## Amendment, SEO1/SEO2 implementation — 2026-09-03

Two decisions in the original text changed while the chunks were built. Both
were driven by facts that only surfaced in implementation.

### Politician and party paths carry no decorative slug

The original scheme was `/politiker/<namn-slug>/<uuid>`. It does not survive
contact with the router. The app pushes these URLs itself and only ever holds
the id — a route is `{ view: "person", personId }`, with no name in it — so a
slug would have to be either invented at navigation time or threaded through
the route model. Either way one entity gets two URLs and one page gets two
history entries, and every pushed URL needs a generated file behind it because
the pod 404s the rest.

The paths are therefore `/politiker/<politicians.id>` and `/parti/<code>`, and
the SEO hub page lives at exactly the URL the app pushes. One URL per entity.
The name still ranks: it is in the title, the heading and the body, which is
where the signal actually comes from. Clip paths keep their slug
(`/klipp/<slug>/<clip_id>`) because nothing in the app pushes them.

### Watch pages do not boot the SPA

The original text said the SPA would boot on top of a prerendered watch page
and upgrade it. That would require a `clip` route in the app, a single-clip
collection loader, a new branch in `App.tsx`'s render tree, a new descriptor in
the desktop route outlet, and a guarantee that the hydrated view shows the same
clip as the static markup or the page is cloaking.

A watch page is instead a standalone document: inlined CSS, a real
`<video controls poster src>`, the transcript, the facts, the Riksdagen link,
and links into the app. It has no `<div id="root">` and loads no module script,
which is asserted by test. This is strictly better for the indexing goal — a
complete document, no render budget, no JavaScript dependency, the poster as
the LCP element — and it removes the parity risk entirely.

What it costs is the swipe feed for a visitor arriving from Google: they can
play the clip immediately but must follow a link to reach the feed. Closing
that gap is a product change worth doing deliberately, as its own chunk, not
squeezed into the chunk that makes the catalogue indexable.

### Titles say "om" for a subject and "i" for a sitting

`sources.title` is a subject for interpellation debates and the format itself
for a chamber sitting. Measured 2026-09-03: 335 of 377 debates carry a subject,
38 are "Frågestund". "Andreas Carlson om Frågestund" is wrong, so a session
title takes "i" instead. Detection is a small title list plus Riksdagen's
`kam-*` debate-type family; an unknown type keeps the subject reading, which is
correct for the large majority.
