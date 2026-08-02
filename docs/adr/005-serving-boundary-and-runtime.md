# ADR 005: Serving boundary and runtime

Date: 2026-08-02

## Status

Accepted

## Context

Prerequisite `N-1` in `docs/RECOMMENDATION_PREREQUISITES.md`.

The feed is currently a catalogue query: `web/src/supabase.ts` reads 60 rows from
`clips` with the publishable key and renders them. That is fine for `Senaste` and
useless for anything else. Personalization needs to log what was served before it
answers, enforce consent server-side, and hold a signing key — none of which a
static browser bundle can be trusted to do.

Three runtimes were available:

1. **The existing Python pipeline** (C1–C11). It already talks to Supabase with
   the secret key.
2. **A new long-running worker API** (FastAPI or similar) on some host.
3. **Supabase Edge Functions** (Deno/TypeScript), co-located with Postgres.

The pipeline is a chain of numbered, resumable batch stages that read artifacts
off disk. It runs on a workstation with a GPU, on demand. Making it also a
low-latency HTTP service would give one deployment unit two incompatible
lifecycles: a render that pins the CPU for minutes would sit in the same process
as a request with a p95 budget of 400 ms.

A separate worker API avoids that but adds a host, a deploy path, a TLS
certificate, a scaling story and a second place for secrets to live — for an
endpoint whose entire job is "run three queries next to the database".

## Decision

**The serving layer is Supabase Edge Functions.** The Python pipeline keeps
producing content and never serves the feed.

- `POST /feed-requests` and `POST /events/batch` are Edge Functions.
- They connect to Postgres with the service-role key, which bypasses RLS, so the
  subject is derived from the verified JWT `sub` claim and never from the request
  body (`A-12`).
- The React app is a thin renderer. It may prefetch media and it must render the
  served order unchanged (`FE-8`). It computes nothing authoritative: no ranking,
  no filtering of the slate, no client-side consent enforcement.
- Public reads that need no identity (`Senaste`, clip metadata) keep going
  straight to PostgREST with the publishable key under RLS. Adding a function hop
  to a read that is already public buys nothing.
- The Python pipeline keeps its existing Supabase access for C11 publishing and
  for migrations. It gains no serving responsibility.

`POST` rather than `GET` for the feed is deliberate: serving creates exposure
rows, and a caching proxy or a link prefetcher turning one `GET` into three
requests would manufacture impressions that never happened (`N-7`).

## Consequences

A second toolchain enters the repo. `python tasks.py test lint typecheck` must
grow Deno format/lint/typecheck/test targets or it stops meaning "everything is
green" (`O-4`), and Deno imports must be pinned exactly like every other
dependency (`O-5`, `AGENTS.md` rule 5).

Deployment forks. The static bundle deploys from `origin/main` through InstaPods;
Edge Functions deploy through the Supabase CLI. That is two ways to ship and two
ways to roll back, and it has to be written down (`O-9`).

Local development needs the Supabase CLI rather than just `vite`.

In exchange: one network hop from function to database, secrets that never leave
the Supabase project, and no new host to operate.

If Edge Functions later prove too limited — cold starts, execution time,
missing libraries — the boundary drawn here still holds. Only the runtime behind
`POST /feed-requests` changes, because nothing in the browser depends on how the
endpoint is implemented.

## Contracts Impact

None. `src/contracts.py` describes pipeline artifacts and is untouched. Feed
DTOs live in `web/src/types.ts` and in the Edge Function, deliberately separate
from the frozen pipeline contracts (see ADR 008).
