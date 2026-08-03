# Runbook

Prerequisite `P1-7`. For whoever is on the other end of "the feed stopped updating"
— including you, in six months, having forgotten all of this.

Organised by **symptom**, because that is what you actually have when something
breaks. The design reasoning lives in `docs/ARCHITECTURE.md`; this file is for
the moment when reasoning is not what you need.

**Prerequisites for every command below:** `RIKET_SUPABASE_PROJECT_REF` and
`RIKET_SUPABASE_ACCESS_TOKEN` in a gitignored `.env` at the repo root. See
`.env.example`.

---

## First response: what is actually wrong?

```bash
python scripts/pipeline_report.py
```

One command, five answers: inventory, freshness SLO, per-stage timing, per-stage
failure rate, party exposure. Start here before forming a theory.

```bash
python -m src.orchestrator.cli status
```

Job counts by state, plus the ten most recent dead-lettered jobs with their
errors. `queued` climbing with nothing `running` means no worker is alive.

| What you see | What it means |
|---|---|
| `running` > 0, unchanged for hours | A worker died holding a lease. Go to **Stuck job**. |
| `dead` > 0 | A job exhausted its retries. Go to **Dead-lettered job**. |
| `queued` > 0, `running` = 0 | No worker is running for that pool. Start one. |
| Everything `complete`, feed still stale | Nothing was discovered. Go to **No new debates**. |

---

## Stuck job — `running` and not moving

A worker that is killed (OOM, `kill -9`, machine reboot, laptop lid) reports
nothing. Its row stays `running` forever: there is no connection whose loss could
signal otherwise, which is why claims are leases (ADR 009).

```bash
python -m src.orchestrator.cli reap
```

Returns expired leases to `queued`, or dead-letters them if they have exhausted
their attempts. Safe to run any time — it only touches jobs whose lease has
already expired, so it cannot steal work from a healthy worker.

**A worker reaps on startup**, so restarting one usually fixes this without
thinking about it.

**If `reap` returns 0 but the job has been running for hours:** the lease has not
expired yet. Lease lengths are per stage in `src/orchestrator/jobs.py`; `render`
is six hours because it encodes every clip of a debate in one job. Either wait,
or — if you are certain the worker is gone — shorten the wait by hand:

```sql
update public.jobs set state = 'queued', locked_at = null, locked_by = null
where id = <job_id> and state = 'running';
```

> **Do not do this while the worker might still be alive.** Two workers running
> the same stage will both write to the same paths. If the render lease ever
> becomes shorter than an actual render, this happens on its own — see
> **Known sharp edges**.

---

## Dead-lettered job

A job that failed `max_attempts` times. It will never be retried automatically;
that is deliberate, because automatic dead-letter retry is how a poison job
becomes an infinite loop nobody notices.

```bash
python -m src.orchestrator.cli status --dokid <DOKID>
```

Read `last_error` first. Then, once the cause is fixed:

```bash
python -m src.orchestrator.cli retry --kind render
python -m src.orchestrator.cli retry --dokid HD10540
```

Both reset `attempts` to zero and requeue. Scope as narrowly as you can — a bare
`retry` with no filter requeues every dead job in the project.

**The chain stops at a dead job.** Successors are only enqueued on success, so a
dead `select` means `track`, `camera`, `render` and `publish` were never created.
Retrying the dead job restarts the chain from there.

---

## No new debates appear

The chain begins at `discover`. If nothing is being enqueued, nothing else runs.

```bash
python -m src.orchestrator.cli enqueue --dokid <DOKID>
python -m src.orchestrator.cli run --pool io --once
```

If `discover` fails, the usual cause is Riksdagen changing its page shape. See
**Riksdagen schema drift**.

> **There is no cron yet.** `docs/BUILD_PLAN.md` C12 calls for 30-minute discovery
> and it is not implemented — debates are enqueued by hand today. Until that
> lands, "unattended" means "unattended once started", not "self-starting". This
> is the largest open gap in P1.

---

## Riksdagen schema drift

`mhs-vodapi` is retired (ADR 001) and the pipeline parses the modern webb-tv page
data. That is a documented-but-unstable surface: it can change without notice.

```bash
python -m pytest tests/live/test_riksdagen_live.py -m live
```

`.github/workflows/schema-drift.yml` runs this daily and opens nothing on its own
— check the Actions tab, or the failure email. A red run means C1 can no longer
parse Riksdagen and **discovery is silently broken**: no error, just no new
debates.

Fix in `src/riksdagen/parser.py`, then re-record the fixture:

```bash
python -m src.stages.discover --dokid hdc120260305fs --work-dir work/drift-check
```

---

## A stage is suddenly slow

```bash
python scripts/pipeline_report.py --days 30
```

Compare `p95` against the budget in `docs/ARCHITECTURE.md` §Orchestration. A p95
approaching a stage's lease is the dangerous case: when a run exceeds its lease,
the reaper reclaims it while it is still running and a second worker starts the
same work. Raise the lease in `src/orchestrator/jobs.py` before that happens.

---

## Content problems

These are pipeline-quality issues, not outages. Every one is from the failure
table in `docs/ARCHITECTURE.md`.

| Symptom | Cause | What to do |
|---|---|---|
| Clip starts mid-sentence | Riksdagen metadata start time off by 30s+ | C3 widens the search window and fuzzy-matches; check `alignment_confidence` on the speech. Below 0.60 it should not have produced clips. |
| Wrong person on screen during a replik | Two speakers visible; the C8 heuristic picked the larger/centred face | Known limitation. Real ASD (TalkNet) is unimplemented — `src/vision/asd.py` has the seam. Reject the clip by hand for now. |
| Sign-language interpreter framed as the speaker | Interpreter inset not excluded | Set `RIKET_SIGN_LANGUAGE_INSET_*` in `src/config.py` to exclude that region. |
| Speaker tiny in a wide chamber shot | Wide shot, no close-up available | The C7 gate penalises low `face_height_frac`. If it slipped through, the gate threshold is too loose. |
| Clip is silent or garbled | Mic failure or crosstalk | Low ASR confidence should skip the speech. Check `mean_word_probability` in `06_candidates`. |
| Speaker name misspelled | ASR heard it wrong | The official transcript is authoritative. Re-run C4 with `--prefer-official-text`. |
| A debate appears twice | Riksdagen re-published an edited video | `master_sha256` differs → new `sources` row and new clip IDs by design. Soft-retire the old clips; do not delete them, the old IDs may be in someone's history. |
| Same speech processed twice | Should be impossible | `unique (source_id, anforande_id)` on `public.speeches`. If you see it, that constraint is missing — check migration 001 applied. |
| Speech shorter than 40s produced nothing | Below `RIKET_MIN_CANDIDATE_S` | Expected. Whether to emit a single short clip is still an open product question. |

---

## Publishing failures

C11 uploads to Bunny, verifies the public CDN URL, *then* writes Supabase rows.
The invariant is that a `clips` row never points at a missing object.

| Symptom | What to do |
|---|---|
| Bunny upload fails | Retried automatically. If it dead-letters, check `RIKET_BUNNY_API_KEY` and the storage zone. No Supabase rows were written, so a retry is clean. |
| Supabase write fails after upload succeeded | Orphaned Bunny objects, no `clips` rows. Harmless — a retry re-uploads over them. Reconcile with `P0-8`. |
| A clip 404s in the app | Bunny object missing but the row exists. Should be impossible; if it happens the upload-then-verify order was broken. |

---

## Database and migrations

```bash
python scripts/apply_migrations.py --dry-run   # what exists, with checksums
python scripts/apply_migrations.py             # apply anything pending
```

Applying twice is a no-op. **A migration edited after it was applied fails
loudly** rather than being skipped — the fix is a new migration, never an edit.
Migration 005 exists precisely because 003 shipped with a bug.

```bash
python -m pytest tests/live/test_db_privileges.py -m live
```

53 assertions on grants and RLS. Run after any migration touching privileges. A
failure here means something is reachable from a browser that should not be.

> **New tables in `public` are unreachable by default** since migration 004. After
> `create table public.foo`, it needs an explicit
> `grant select on public.foo to anon` to be readable by the app. Silence is
> denial, deliberately.

---

## Known sharp edges

Things that are true right now and will bite someone.

- **No discovery cron.** Debates are enqueued by hand. C12's 30-minute discovery
  is unimplemented.
- **Render is one job per debate.** All 400 encodes run serially in one process,
  so extra machines do not help, and a crash at clip 399 re-encodes all 400 —
  there is no skip-if-exists check. At high volume the render can also exceed its
  six-hour lease, at which point the reaper starts a *second* worker on the same
  debate. The per-clip split is the fix and is not built.
- **Freshness is measured from midnight.** `sources.debate_date` is a DATE, so the
  SLO overstates lag by up to a day. Fixing it needs Riksdagen's publication
  timestamp captured at C1.
- **One environment.** There is no staging (`O-2`). Every migration is applied to
  production, which is why they are additive and idempotent.
- **`src/segment/vad.py` uses `audioop`**, removed in Python 3.13. The pipeline is
  pinned below that; it will need replacing.

---

## Escalation

There is no on-call rotation and no paging. The failure mode that matters is
silent: discovery stops, nothing errors, and the feed quietly goes stale. The
daily schema-drift run and the freshness SLO are what turn that into something
visible.

If the feed is stale and everything above looks healthy, the answer is almost
always that nothing was enqueued.
