# SEO_PLAN.md — Indexable pages for every clip

Chunked implementation plan for making Pleni's catalogue discoverable in Google
and Bing. Read this together with `AGENTS.md`, `PROGRESS.md` and
`docs/BUILD_PLAN.md`. The chunk format, the seven rules, the scope discipline and
the handoff template all apply here unchanged.

---

## 1. The diagnosis

**Pleni currently has exactly one indexable URL.**

`web/src/navigation.ts` parses routes out of the URL *fragment*
(`routeFromHash`, documented in the source as "static-host-safe"). That choice
was correct for a static host with no rewrite rules, and it is why deep links
work at all today. But search engines discard everything after `#`. To Googlebot,
`pleni.se/#/person/<uuid>` and `pleni.se/#/klipp/abc` are the same URL as
`pleni.se`.

Everything else follows from that. `web/index.html` ships one `<title>Pleni</title>`,
no `<meta name="description">`, no canonical link, no Open Graph tags and no
structured data. There is no `robots.txt` and no sitemap in `web/public/`. The
catalogue — thousands of clips, each with a named politician, a party, a date, a
debate, a transcript and a primary-source link — is invisible.

The fix is the architecture the TikTok comparison describes: **one real,
crawlable watch page per clip, generated from the database, plus entity hub pages
that connect them.** The swipe feed stays exactly as it is for humans.

### What we already have that makes this cheap

The hard part of a project like this is usually the metadata. We have it:

| Need | Source |
|---|---|
| Title, transcript, topic, duration, MP4, thumbnail, publish time | `public.clips` |
| Speaker name, party, `anforandetyp`, official text | `public.speeches` |
| Stable politician identity, role, constituency, portrait | `public.politicians` |
| Debate title, type, date, **Riksdagen source URL** | `public.sources` |
| Party name, colour, verified logo | `public.party_profiles` |

All of it is readable with the **publishable (anon) key** under the existing RLS
policies — `clips_public_read` already restricts to
`moderation <> 'rejected' and published_at is not null`, which is exactly the
correct publication gate. No secret ever has to enter the SEO surface.

---

## 2. Goal and definition of complete

**Complete** means all of the following are true in production:

1. Every published clip has its own permanent URL that returns a complete HTML
   document containing the video, the transcript, the speaker, the party, the
   date and a link to the Riksdagen source — with **no JavaScript execution
   required** to see any of it.
2. Politician, party and debate hub pages exist and link the clips together, so
   crawlers see a connected site rather than an infinite feed.
3. Every watch page carries valid `VideoObject` and `BreadcrumbList` structured
   data.
4. A sitemap index covering clips, politicians, parties and debates is submitted
   and read in Google Search Console, and refreshes without a human when the
   pipeline publishes new clips.
5. Account-bound routes (Profile, Saved, Following) are excluded from indexing.
6. Google Search Console's Video indexing report shows watch pages indexed, and
   the coverage report shows growth from one URL to the catalogue.

**Not complete** means anything less. In particular, a page that only renders its
video after the SPA boots does not count — Google's own video documentation says
the video must be discoverable when the watch page is rendered and must not
depend on user interaction such as swiping.

---

## 3. Locked decisions

These are decided. Do not re-litigate them inside a chunk; if one is genuinely
wrong, write an ADR.

### 3.1 Rendering strategy: build-time prerendered static HTML

The InstaPods pod is a **static runtime**. There is no server to render on.
Therefore each public URL is a real file written into `web/dist/` by a post-build
generator that reads Supabase over HTTPS with the publishable key, and is then
copied to the pod root by the existing deploy command.

This is not a compromise. It gives crawlers a fully-formed document with zero
render budget spent, it survives a Supabase outage (the pages are already on
disk), and it adds no runtime cost.

**Amended during SEO2:** a clip watch page is a standalone document and does
not boot the SPA. It carries inlined CSS, a real `<video controls poster src>`,
the transcript, the facts, the Riksdagen link and links into the app — no
`<div id="root">`, no module script. That removes the cloaking risk entirely
and makes the poster the LCP element. Shell pages for app routes do boot the
SPA, because that is all they are for. See ADR 014's amendment; closing the
swipe-feed gap for a Google visitor is SEO2b, below.

### 3.2 URL scheme

Swedish paths, matching the app's own vocabulary (`hem`, `foljer`, `sok`,
`profil`). Identity is always a separate final path segment, never fused into a
slug.

```
/klipp/<beskrivande-slug>/<clip_id>
/politiker/<politicians.id>
/politiker/<politicians.id>/klipp
/parti/<kod>
/parti/<kod>/klipp
/debatt/<beskrivande-slug>/<dokid>      (SEO3)
/amne/<amnes-slug>                      (SEO4, deferred)
```

**Amended during SEO1** (see ADR 014's amendment): politician and party paths
carry **no decorative slug**. The app pushes those URLs itself and only holds
the id, so a slug would give one entity two URLs and one page two history
entries — and every pushed URL needs a generated file, because the pod 404s the
rest. Clip paths keep their slug because nothing in the app pushes them.

**Why the id gets its own segment.** `clip_id` is `{dokid}_{anforande_id}_c{NN}`.
We do not control `anforande_id`'s character set, so we cannot assume the id is
free of hyphens and parse `slug-id` from the right. A separate segment is
unambiguous whatever Riksdagen sends. The slug is decorative: a request with a
stale or wrong slug still resolves, and its canonical link points at the correct
form.

**Why politicians key on the uuid.** `public.politicians.id` is the identity gate
(`Q-2`). The old name-slug scheme split the five most-clipped ministers into two
identities each — 380 clips, 21.6% of the catalogue, measured 2026-08-04. A name
in a URL is a display string that changes when a minister changes portfolio. It
is never the key. The name still ranks — it is in the title, the heading and the
body, which is where the signal comes from.

### 3.3 Canonical host

`https://pleni.se` (apex, no `www`) is canonical. `www.pleni.se` and the pod
hostname `rikettv.nbg1-3.instapods.app` must not compete for the same content.
Every generated page carries an absolute `<link rel="canonical">` to the apex
form, which resolves the duplication even if the host cannot issue redirects.

### 3.4 Freshness

The pipeline publishes clips continuously from the owner's workstation; InstaPods
only rebuilds on a push to `main`. New clips would therefore have no page until
the next deploy. The freshness mechanism is a **scheduled rebuild** (SEO6), not a
dynamic sitemap — a static host cannot route `/sitemap.xml` to a function, and a
sitemap must live on the host it describes.

### 3.5 Editorial and legal boundary

Riksdagen debates are public record and the clips are primary source material.
That does not make an indexed page about a named person consequence-free.

- A watch page must always show the **transcript** and a link to the **Riksdagen
  source** (`sources.source_url`). The page is a pointer to the primary source,
  never a replacement for it.
- Page titles and `<meta name="description">` are built from the politician's own
  words plus neutral factual metadata (name, party, debate, date). They must not
  introduce a characterisation the speaker did not make. The clip title comes
  from `src/scoring/titles.py`, which is machine-generated; SEO2 must verify that
  what it produces is safe to publish as an indexed headline under a real
  person's name, and fall back to `"<Name> (<Party>) om <topic> — <debate>,
  <date>"` where it is not.
- The `moderation <> 'rejected'` and `published_at is not null` gate is the
  publication boundary. Nothing else may be prerendered or listed in a sitemap.
- Account-bound and legal-utility routes are `noindex`.

### 3.6 What must not change

- `src/contracts.py`, any pipeline stage, any migration in `001`–`031`, the
  rendering geometry, Bunny paths or the publish transaction.
- The mobile feed's gesture, media-scheduling and snap behaviour
  (`web/src/feed/snap-policy.ts`, `media-policy.ts`).
- The service worker's nine-entry precache and its media/private bypasses.
- The 700–1099 px phone gate and the desktop parity work from UI20.

---

## 4. Status dashboard

Allowed states: `NOT STARTED`, `IN PROGRESS`, `DONE`, `BLOCKED`. A row becomes
`DONE` only when its production evidence is recorded.

| Chunk | Deliverable | Status | Production evidence |
|---|---|---|---|
| SEO0 | Crawl foundation, host facts, baseline | IN PROGRESS | Implemented locally 2026-09-03; host facts measured against production and recorded in ADR 014. Awaiting deploy and owner Search Console verification |
| SEO1 | Path routing alongside hash | IN PROGRESS | Implemented locally 2026-09-03; ships with SEO2 in one deploy |
| SEO2 | Prerendered clip watch pages | IN PROGRESS | Implemented locally 2026-09-03; 5 514 watch pages + 624 shells generated from production data, 0 skipped |
| SEO2b | In-app clip route so a watch page can open the feed | NOT STARTED | — |
| SEO3 | Politician, party and debate hubs | IN PROGRESS | Implemented locally 2026-09-03; 307 hubs and 377 debate pages generated from production data |
| SEO4 | Topic pages | DEFERRED | `clips.topic` is null for all 5 514 clips; needs a pipeline taxonomy first. Nothing depends on it |
| SEO5 | Sitemaps and search-engine submission | IN PROGRESS | Implemented locally 2026-09-03; index plus 7 children, 6 205 URLs, all well-formed and inside spec limits. Submission needs the owner |
| SEO6 | Scheduled rebuild and stale-page cleanup | IN PROGRESS | Workflow and deploy-command cleanup written 2026-09-03; needs an InstaPods deploy-hook URL from the owner |
| SEO7 | Watch-page performance and Core Web Vitals | IN PROGRESS | Watch pages ship inlined CSS, a preloaded poster and `preload="metadata"`; PageSpeed evidence needs the live site |
| SEO8 | Measurement, guardrails and closeout | IN PROGRESS | All six guardrails exist as tests plus a CI precache assertion; the four-week measurement needs the live site |

**Current completion:** 0 of 10 `DONE`. Every chunk except SEO4 and SEO2b is
implemented and locally verified; each is held at `IN PROGRESS` because the
remaining acceptance is deployment and owner action, not code. SEO4 is deferred
on missing data, so the reachable target is 9 of 10.

Update this table in the same commit as the chunk's `PROGRESS.md` handoff.
Production evidence must name the live URL checked and what was observed. A local
screenshot is not production evidence.

---

## 5. Chunks

### SEO0 — Crawl foundation, host facts and baseline

**Depends on:** nothing. **Size:** medium. Do this first and do not skip it —
three of the later chunks are shaped by what it finds.

**Objective:** establish what the static host can actually do, make the single
existing URL properly crawlable, and record a measured baseline so later chunks
can prove they changed something.

**Scope — may modify:** `web/index.html`, `web/public/robots.txt` (new),
`web/src/` only for a shared metadata module if one is needed,
`docs/adr/014-prerendered-seo-surface.md` (new), this file, `PROGRESS.md`.
**Must not modify:** routing, the service worker, any pipeline code, any
migration.

**Host facts — MEASURED 2026-09-03.** All answers are recorded with their
evidence in `docs/adr/014-prerendered-seo-surface.md`. Do not re-derive them;
re-measure only if something looks wrong.

1. **An unknown deep path returns HTTP 404.** `https://pleni.se/klipp/test`
   → 404. nginx 1.24.0 serving files, **no SPA fallback rewrite**. This is the
   most consequential fact in the plan: a path with no file cannot be indexed or
   even deep-linked, so SEO1 must not ship before SEO2.
2. **No redirects and no custom headers.** The apex, `www` and the pod hostname
   all return 200 with byte-identical bodies (md5 `ee351be0…`) and no
   `Location`. No `Cache-Control`, no `X-Robots-Tag`. Absolute canonical links
   carry the entire deduplication load.
3. **No deploy webhook confirmed.** InstaPods deploys from `origin/main`. SEO6
   must establish the refresh mechanism; check the panel while signed in.
4. **5 514 published clips**, 364 politicians, 377 debates — roughly 6 260 pages
   including hubs. A tractable build-time budget, not a scale problem.
5. **`topic` is null for all 5 514 clips.** SEO4 has no data. See that chunk.
6. **Bunny is crawlable.** `https://riketnlooigm.b-cdn.net/robots.txt` → 404,
   which grants access rather than denying it.
7. **Answered by fact 2** — all three hostnames serve identical content.

**Build.** Add `web/public/robots.txt` allowing all crawlers and disallowing
`/profil`, `/sparade` and `/foljer`. The `Sitemap:` line is **not** added here:
it lands in SEO5 with the sitemap index it names, because pointing a crawler at
a 404 is worse than saying nothing. Extend
`web/index.html` with `<link rel="canonical">`, a Swedish `<meta
name="description">`, Open Graph and Twitter card defaults, `<meta
property="og:locale" content="sv_SE">`, and site-level JSON-LD for `WebSite`
(with a `SearchAction` pointing at the existing search route) and `Organization`.
Verify the property in Google Search Console and Bing Webmaster Tools.

**ADR.** Write `docs/adr/014-prerendered-seo-surface.md` recording section 3 of
this document as the decided architecture, with the host facts as its evidence.

**Acceptance:** `robots.txt` is live at `https://pleni.se/robots.txt`. The
homepage returns a title, description, canonical and valid `WebSite` +
`Organization` JSON-LD (checked with Google's Rich Results Test). Search Console
ownership is verified for the apex, and the current indexed-URL count is recorded
in `PROGRESS.md` as the baseline. All seven host facts are answered in the ADR.
Frontend tests, TypeScript, the Vite build and PWA verification pass, and the
worker still precaches exactly nine entries.

---

### SEO1 — Path routing alongside hash

**Depends on:** SEO0. **Size:** large. This is the riskiest chunk in the plan —
it touches the navigation module every screen depends on.

**Objective:** teach the app to read and write real paths, without breaking the
existing hash routes, the PWA, the back button, or the desktop route outlet.

**Scope — may modify:** `web/src/navigation.ts`, `web/src/App.tsx` and
`web/src/desktop/route-outlet.ts` only where routes are parsed or written,
`web/tests/`. **Must not modify:** `snap-policy.ts`, `media-policy.ts`,
`library-store.ts`, the Clerk integration, the service worker.

**Design.** Add `routeFromPath(pathname, search)` next to the existing
`routeFromHash`, sharing one internal route model, and make `AppRoute` round-trip
through a new `pathFromRoute(route)`. Navigation switches to `history.pushState`
with real paths. Hash URLs remain permanently supported as legacy inbound links:
on load, a recognised hash route is rewritten once with `history.replaceState` to
its path equivalent — a client-side redirect, since a static host cannot issue a
301 — and the destination's canonical tag closes the loop for crawlers.

`AppRoute` gains the new public views (`clip`, `debate`) but keeps its existing
shape for everything else, so the desktop outlet's exhaustive route descriptors
stay exhaustive. The `?from=` and `?feed=` query parameters keep working.

**Two things that will break if you are not careful.** First, deep paths only
resolve if the host serves something at them — either the SPA fallback found in
SEO0, or the real files SEO2 generates. If SEO0 found no fallback, **SEO1 cannot
ship alone**; land it together with SEO2 in one deploy. Second, the service
worker is network-first for navigations and falls back to the cached shell
offline; that shell must be able to route from `location.pathname`, which is
precisely what this chunk adds. Verify the offline path explicitly.

**Acceptance:** every existing route survives a path round-trip
(`pathFromRoute(routeFromPath(p)) === p`) under test. Legacy hash URLs for every
view land on the correct path. Back and forward restore the correct route, active
tab and focus key. Installed PWA scope still covers the new paths. Offline
navigation to a path route boots the shell and routes correctly. Frontend tests,
TypeScript, build and PWA verification pass, worker precache still nine entries,
and `python tasks.py test lint typecheck` is green.

---

### SEO2 — Prerendered clip watch pages

**Depends on:** SEO1. **Size:** large. The centrepiece.

**Objective:** one complete, crawlable HTML document per published clip.

**Scope — may create/modify:** `web/seo/` (new: the generator and its templates),
`web/package.json` scripts, `web/tests/`, `README.md` and the InstaPods build
command documented in `AGENTS.md`. **Must not modify:** `web/vite.config.ts`'s
`injectManifest` globs, the service worker, any Supabase migration, any pipeline
code.

**The generator.** `web/seo/prerender.mjs`, plain Node with built-in `fetch` —
**no new dependency**. `web/package.json` has no `@supabase/supabase-js`; the app
talks to PostgREST with raw fetch and the generator does the same. It reads
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from the environment,
pages through published clips with their joined speech, politician and source
rows, and writes `web/dist/klipp/<slug>/<clip_id>/index.html`.

**It must run as a separate step *after* `vite build`, never inside it.** This is
the trap that will cost a session if it is missed:
`web/vite.config.ts` precaches `**/*.{html,js,css,json,png,svg,woff2}`. If the
generator writes its HTML before VitePWA builds the manifest, the service
worker's precache jumps from nine entries to one per clip, and every install
downloads the entire catalogue's HTML. The build command becomes
`vite build && node seo/prerender.mjs`, and a test must assert the generated
worker still contains exactly nine entries.

**Degradation is mandatory.** CI builds with no `VITE_*` secrets on purpose
(ADR 006 — the build must survive a misconfigured deploy). If the environment is
missing or Supabase is unreachable, the generator logs, writes nothing and exits
zero. **A failed prerender must never fail the deploy or take pleni.se down.**

**Page contents.** Each page is a complete document before any script runs:

- `<head>`: `<title>` in the form `<Name> (<Party>) om <topic> — <debate>,
  <date> | Pleni`, a description built from the clip's opening transcript
  sentence, absolute canonical to the apex URL, `og:` and `twitter:` tags
  including `og:video` and `twitter:card=player`, and `og:locale=sv_SE`.
- JSON-LD `VideoObject`. Google requires `name`, `thumbnailUrl` and `uploadDate`;
  supply those plus `description`, `duration` (ISO 8601, e.g. `PT42S`),
  `contentUrl` (the Bunny MP4), `transcript`, `inLanguage: "sv-SE"`, `creator`
  as a `Person` with the politician's name and `affiliation`, and `isBasedOn`
  pointing at `sources.source_url`.
- JSON-LD `BreadcrumbList`: Pleni → politician → clip.
- `<body>`: an `<h1>`, a real `<video controls playsinline preload="metadata">`
  with `src` set to the Bunny MP4 and `poster` set to the thumbnail, the speaker
  name, party, role, `anforandetyp`, debate title, date, a visible link to the
  Riksdagen source, **the full transcript as readable text**, and internal links
  to the politician page, party page, debate page and a handful of related
  clips.

Then the normal `<script type="module">` boots the SPA, which replaces the static
body with the Pleni player for the same clip.

**Slug and canonical.** The slug is `<name>-<topic-or-title>` slugified for
Swedish (`å`/`ä` → `a`, `ö` → `o`, lowercase, hyphen-separated, truncated to a
sane length). A request whose slug does not match the current canonical still
renders the correct clip and canonicalises to the right URL.

**Acceptance:** for a sample of at least twenty real production clips, the served
HTML contains the video element, transcript and Riksdagen link **with JavaScript
disabled**. Google's Rich Results Test reports a valid `VideoObject` with no
errors on three sampled pages. The hydrated SPA shows the same clip as the static
markup (no cloaking). The generated service worker still precaches exactly nine
entries and no clip HTML. A build with no Supabase environment succeeds and ships
the SPA unchanged. Build wall-clock time for the full catalogue is recorded in
`PROGRESS.md`. Frontend tests, TypeScript, build, PWA verification and
`python tasks.py test lint typecheck` are green.

---

### SEO2b — In-app clip route

**Depends on:** SEO2. **Size:** medium. **Optional for indexing, wanted for the
product.**

**Objective:** let a visitor who lands on a watch page from Google continue into
the swipe feed, instead of following a link back to `/senaste`.

**Why it is its own chunk.** SEO2's watch pages are deliberately standalone: no
`<div id="root">`, no module script, so there is no hydration and no way for the
static and dynamic views to disagree. Giving the app a `clip` route means a new
`AppRoute` member, a single-clip collection loader, a branch in `App.tsx`'s
render tree, a new descriptor in the desktop route outlet, and a content-parity
guarantee between the prerendered markup and the hydrated view. That is real
product work and it must not be squeezed into the chunk that makes the catalogue
indexable.

**Build.** Add `{ view: "clip"; clipId: string }` to `AppRoute` with
`/klipp/<slug>/<clip_id>` as its path — the slug is already decorative and
ignored by the parser. Load the clip by id through `web/src/supabase.ts` and
mount it in the existing bounded `CollectionScreen`, the same way the search
feed hands off a scoped collection today. Then make the watch page boot the SPA,
and keep the static markup as the pre-hydration view.

**Acceptance:** the hydrated view shows the same clip the static markup shows,
verified on three real production clips. A clip whose `politicianId` is null
still works. The desktop route outlet stays exhaustive. Watch-page LCP does not
regress past the SEO7 budget. The feed's four-source media window is unchanged.

---

### SEO3 — Politician, party and debate hub pages

**Depends on:** SEO2. **Size:** medium.

**Objective:** turn a pile of watch pages into a connected site, so a crawler can
see *Ulf Kristersson → Moderaterna → this debate → fourteen clips* instead of
isolated leaves.

**Scope — may modify:** `web/seo/`, `web/tests/`. **Must not modify:** anything
outside the generator and its tests.

**What SEO2 already left behind.** `/politiker/<uuid>`, `/politiker/<uuid>/klipp`,
`/parti/<kod>` and `/parti/<kod>/klipp` already have generated **shells** — the
built `index.html` patched with their own canonical and `noindex, follow`. They
exist so the router's paths do not 404. This chunk replaces them with real
content and removes the `noindex`. 614 shells were written for 299 politicians
with clips plus the eight parties.

**Build.** Extend the generator to emit:

- `/politiker/<uuid>` — portrait, name, party, role, constituency,
  clip count, a paginated list of that politician's clips as real links, JSON-LD
  `ProfilePage` + `Person` (with `affiliation` and `sameAs` pointing at the
  Riksdagen profile), and `ItemList` of the clips.
- `/parti/<partinamn-slug>` — verified logo, party name, clip count, politician
  roster as links, recent clips, JSON-LD `Organization` + `ItemList`.
- `/debatt/<slug>/<dokid>` — debate title, type, date, link to the Riksdagen
  source, and every clip from that debate grouped by speaker, JSON-LD
  `CollectionPage` + `ItemList`.

Every hub carries `BreadcrumbList`. Every watch page links up to its three hubs;
every hub links down to its clips. Paginate any list above 100 entries with real
`<a>` links to `?sida=N` variants that are themselves prerendered — crawlers must
not need JavaScript to reach page two.

**Portrait and logo boundary.** Hubs use `avatar_url` and `logo_url` only —
the verified Bunny mirrors. `avatar_source_url` and `logo_source_url` are
provenance and must never be requested by a page. A politician without a verified
portrait keeps the existing initials fallback; that is a correct outcome, not a
gap to paper over.

**Acceptance:** every published politician, party and debate with at least one
published clip has a page reachable from the homepage in at most three clicks
with JavaScript disabled. Rich Results Test reports no structured-data errors on
one page of each type. No page references a `*_source_url`. Pagination is
crawlable without JavaScript. All gates from SEO2 stay green.

---

### SEO4 — Topic pages

**Depends on:** a topic taxonomy that does not yet exist. **Size:** medium.
**Status: DEFERRED — the data is empty. Do not attempt this chunk.**

**Objective (unchanged, for whenever the data arrives):** `/amne/karnkraft`,
`/amne/invandring`, `/amne/forsvar` — the pages that answer the long-tail
Swedish queries the plan is aimed at.

**Why it is deferred.** SEO0 measured `clips.topic` as **null for all 5 514
published clips**. There is nothing to group on. Deriving topics inside an SEO
chunk — by keyword-matching transcripts, say — would invent a taxonomy in the
wrong layer, produce near-duplicate thin pages (`kärnkraft`, `Kärnkraften`,
`kärnkraft och energi`) and bind the public URL space to a heuristic nobody
reviewed. That is worse than having no topic pages.

**What would unblock it.** A populated, controlled `topic` (or a dedicated topic
table) written by the pipeline, as C-series work under its own ADR. Note that
`private.clip_search_documents` already holds per-clip semantic material from the
OPT search work; a taxonomy chunk should look there before inventing anything.

**Do not treat this as blocking the plan.** Nothing else depends on SEO4.
Debate hubs (SEO3) already give crawlers a subject-shaped entry point, because
`sources.title` is a real human-written subject — "Stöd till kollektivtrafiken",
for example. Go straight from SEO3 to SEO5.

**Acceptance (if it is ever unblocked):** every emitted topic page has at least
ten clips, one canonical URL per topic concept, `CollectionPage` + `ItemList`
JSON-LD, crawlable pagination, and links from each clip's watch page to its
topic. No topic page is generated for a variant spelling.

---

### SEO5 — Sitemaps and search-engine submission

**Depends on:** SEO2, and SEO3/SEO4 for their URL sets. **Size:** medium.

**Objective:** tell Google and Bing what exists, in the format Google recommends
for video specifically.

**Scope — may modify:** `web/seo/`, `web/public/robots.txt`, `web/tests/`.

**Build.** The generator emits a sitemap index at `/sitemap.xml` referencing:

- `/sitemap-klipp-<n>.xml` — a **video sitemap** with the `video` namespace. Per
  URL: `video:thumbnail_loc`, `video:title`, `video:description`,
  `video:content_loc` (the Bunny MP4), `video:duration` in seconds,
  `video:publication_date`, `video:family_friendly`. Google recommends video
  sitemaps precisely because they surface videos its ordinary crawl might miss.
- `/sitemap-politiker.xml`, `/sitemap-parti.xml`, `/sitemap-debatt.xml`, and
  `/sitemap-amne.xml` if SEO4 shipped.

Respect the limits: 50,000 URLs and 50 MB uncompressed per file — shard the clip
sitemap accordingly. Set `lastmod` from `published_at`. Add the `Sitemap:` line
to `robots.txt`. Submit the index in Search Console and Bing Webmaster Tools.

**One thing to verify rather than assume.** Our thumbnails are WebP. Confirm in
the Search Console video report that the thumbnails are accepted; if they are
rejected, the fix is a JPEG thumbnail variant in the C10 render — a small,
additive change, but pipeline work under its own chunk, not a drive-by edit here.

**Acceptance:** `/sitemap.xml` validates, every child sitemap is under both
limits, and every URL in them returns a page (spot-check twenty, including the
last URL of the last shard). Search Console reads the index with zero errors.
`robots.txt` names it. Nothing that fails the publication gate appears in any
sitemap — assert this in a test.

---

### SEO6 — Scheduled rebuild and stale-page cleanup

**Depends on:** SEO5 and host fact 3 from SEO0. **Size:** medium.

**Objective:** new clips get pages without a human, and unpublished clips lose
theirs.

**Build.** A scheduled GitHub Actions workflow (`.github/workflows/seo-refresh.yml`)
runs daily and triggers an InstaPods rebuild. The mechanism depends on SEO0's
finding: a deploy webhook if one exists, otherwise a scheduled empty commit to
`main` — which is uglier but honest, and must be clearly labelled in the commit
message so it is never mistaken for a code change.

**Stale pages.** The deploy command's cleanup is
`rm -rf ./assets ./index.html ./dist`. It does not remove previously generated
route directories at the pod root, so a clip that is unpublished or rejected
keeps a live page indefinitely. Extend the cleanup to remove the generated route
roots (`./klipp ./politiker ./parti ./debatt ./amne ./sitemap*.xml`) before the
copy, and update the command in both `AGENTS.md` and `README.md` **and in the
InstaPods panel** — the panel is the one that actually runs.

A clip that legitimately disappears should return 404. Do not build a redirect
scheme for it; a removed clip is not a moved clip.

**Acceptance:** a clip published after the last manual deploy has a live watch
page and a sitemap entry within 24 hours, evidenced by the URL and the timestamps.
A clip removed from publication no longer has a page after the next scheduled
run. The workflow does not run on pull requests and cannot deploy a broken build:
if the prerender writes zero pages, it must not replace a good deploy.

---

### SEO7 — Watch-page performance and Core Web Vitals

**Depends on:** SEO2. **Size:** small.

**Objective:** a visitor arriving cold from Google gets a fast, stable page.

**Build.** The poster image is the LCP element: `preload` it, give it explicit
dimensions, and never let the SPA's hydration shift it (`CLS`). Keep the watch
page's video at `preload="metadata"` so a cold visit does not pull megabytes
before intent — this is a *watch page*, not the feed, and the feed's four-source
directional scheduler in `media-policy.ts` is not involved and must not be
changed. Defer non-critical work: Clerk, the recommendation layer and the service
worker registration should not block first paint on a watch page.

**Acceptance:** PageSpeed Insights mobile scores are recorded for three watch
pages, with LCP under 2.5 s and CLS under 0.1 on a throttled mobile profile. The
feed's own media behaviour is unchanged — no change to the four-source window,
the ±3 poster bound, or the request-count characteristics. A local 1440×900 and
390×844 check shows no layout shift when the SPA takes over.

---

### SEO8 — Measurement, guardrails and closeout

**Depends on:** all of the above. **Size:** medium.

**Objective:** prove it worked, and make it hard to silently break.

**Guardrails to land as tests.** These are the regressions that would go
unnoticed for months:

1. The service worker precaches exactly nine entries.
2. No URL failing `published_at is not null and moderation <> 'rejected'` appears
   in any sitemap or prerendered page.
3. `/profil`, `/sparade` and `/foljer` are `noindex` and absent from sitemaps.
4. Every prerendered page carries exactly one canonical link, pointing at the
   apex host.
5. The prerender degrades to a successful no-op with no Supabase environment.
6. No page references `avatar_source_url` or `logo_source_url`.

**Measurement.** Record in `PROGRESS.md`, four weeks after SEO5 is submitted:
indexed URL count against the SEO0 baseline, video-indexing status counts, top
queries and impressions, and the count of watch pages receiving impressions.

**Kill switch.** Document in `docs/RUNBOOK.md` how to withdraw the SEO surface if
something goes wrong: set the generator to no-op, deploy, and the site returns to
its current single-page behaviour with the sitemaps 404ing. Search engines will
drop the pages. Nothing in the pipeline, the database or the feed is involved.

**Acceptance:** all six guardrail tests exist and pass. The runbook section is
written. The four-week measurement is recorded. Every dashboard row is `DONE`
with named live URLs as evidence, and the chunk's handoff closes the plan.

---

## 6. Traps that will cost a session

Read this list before starting any chunk.

1. **The precache explosion.** `injectManifest` globs `**/*.html`. Prerender
   after `vite build`, never during. Assert nine entries.
2. **Hash routes are not URLs.** Any work that leaves navigation on `#` produces
   zero indexable pages regardless of how good the metadata is.
3. **Deep paths need a file or a fallback.** SEO0 fact 1 decides whether SEO1 can
   ship before SEO2.
4. **The build must survive without Supabase.** CI builds with no `VITE_*` values
   on purpose. A generator that throws takes the site down.
5. **Name slugs are not identity.** This repo has already paid for that mistake
   once, at 21.6% of the catalogue.
6. **Content parity.** The static markup and the hydrated app must show the same
   clip. Do not "optimise" the crawler view.
7. **The InstaPods panel is the source of truth for the build command.** Editing
   `AGENTS.md` and `README.md` changes documentation, not the deploy.
8. **Do not touch the feed's media scheduler.** Watch-page loading rules are
   separate from feed loading rules. Mixing them reintroduces the 119-request
   regression.

---

## 7. Out of scope

- Any change to `src/contracts.py`, the pipeline stages, the render geometry or
  the publish transaction.
- Server-side rendering, a Node runtime, or moving off the static host.
- Captions or a VTT artifact — ADR 004 stands. The transcript is published as
  page text, which is what search engines read anyway.
- Comments — UI19 keeps them globally hidden.
- Paid acquisition, backlink work, social scheduling, or anything that is not
  a property of the site itself.
- Rewriting the mobile feed. Humans keep the swipe experience unchanged.

---

## 8. Working protocol for each session

1. Re-read `AGENTS.md`, then `PROGRESS.md`, then this file. Read only your chunk
   and its dependencies.
2. Do not start a chunk whose dependency is not `DONE`.
3. Stay inside the chunk's declared scope. Anything else wrong goes in
   `PROGRESS.md` under Observations, unfixed.
4. Run `python tasks.py test lint typecheck`, plus `node --test` and the Vite
   build in `web/`, before finishing. All of them, not just yours.
5. Update this dashboard and append a `PROGRESS.md` handoff in the same commit.
6. Commit format: `chunk(SEO2): short description`.
