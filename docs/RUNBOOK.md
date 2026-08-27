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
| Lots of `skipped` | Normal during a backfill: those documents have no video. Not a failure. |

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
expired yet. Lease lengths are per stage in `src/orchestrator/jobs.py`. The
longest is `transcribe` at two hours; `render_clip` is twenty minutes, because a
single clip is a single encode. Either wait, or — if you are certain the worker
is gone — shorten the wait by hand:

```sql
update public.jobs set state = 'queued', locked_at = null, locked_by = null
where id = <job_id> and state = 'running';
```

> **Do not do this while the worker might still be alive.** Two workers running
> the same stage will both write to the same paths.

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

## Where this actually runs

> **The pipeline runs on one Windows workstation, not in the cloud.** It needs
> local CPU for vision and a local ffmpeg for rendering. InstaPods hosts the
> *static frontend only* and knows nothing about any of this. No GPU is involved:
> ASR does not run (C4 uses the official transcript, ADR 011) and OpenCV vision is
> CPU-only, so the GTX 1080 in the box sits idle.
>
> That single fact shapes the design. The machine sleeps, reboots, and gets shut
> for the weekend, so:
>
> - Discovery is **catch-up, not tick-based**. It asks "what is newer than the
>   last thing I saw?", so a week offline is collected on the next run rather
>   than lost.
> - Every stage is resumable and every job is idempotent, because "the process
>   died" is a normal Tuesday, not an incident.
> - There is no always-on worker. Nothing progresses while the machine is off,
>   and that is expected.

## Starting the pipeline

One process does everything on one machine:

```bash
python -m src.orchestrator.cli daemon
```

It discovers every 30 minutes, works all three pools, and reaps expired leases.
Pool separation exists for a future second machine; on one workstation it would
only mean three terminals to forget about.

Leave it running. Stop it with Ctrl-C — an interrupted job is reclaimed by the
lease reaper on the next start.

### Running stages by hand: C6v must come before C7

The stage order is `discover, acquire, segment, transcribe, audio_features,
candidates, **vision**, select, track, camera, render, publish`. The daemon gets
this right on its own; the hazard is running stages manually.

```bash
python -m src.stages.vision --dokid <dokid> --work-dir <root>   # writes 06_vision/
python -m src.stages.select --dokid <dokid> --work-dir <root>
```

`06_vision/<speech_id>.json` is **the one artifact whose absence does not raise.**
Every other stage fails loudly on a missing input. C7 instead falls back to
picking clip windows with no framing evidence, exactly as it did before ADR 013,
and on a hard debate that roughly halves the number of usable clips — with
nothing in the output to say so.

That fallback is deliberate: it keeps older work directories and the fixture
runner working. It is also easy to trip over, so C7 logs a warning per speech:

```
vision_timeline_missing  speech_id=... consequence=clip windows chosen without framing evidence
```

**If you see that line, you skipped C6v.** Re-run it and then re-run `select`;
everything downstream of `select` has to be redone too, because the chosen
windows change.

### If you run bare workers instead, nothing reaps

`run --pool <pool>` does **not** reap expired leases; only `daemon` does. A worker
that dies mid-job leaves its row in `running`, locked by a PID that no longer
exists, and no other worker will touch it. Nothing errors and nothing retries —
the job simply stops existing as far as the queue is concerned.

That is quiet on its own, and loud in its consequences when the stalled job is a
`render_clip`: the render fan-out has a **join barrier**, so `publish` is never
enqueued until every sibling clip completes. One orphaned clip silently holds
back a whole debate.

Seen on the March 2026 backfill: two jobs sat locked by dead PIDs for five and
six hours, and two debates never published. `status` showed `dead 0` throughout,
because they were not dead — they were leased.

```bash
# Who is stuck, and is the lease actually stale?
python -c "..."   # or check public.jobs where state='running'
python -m src.orchestrator.cli reap     # requeue expired leases
```

**If you run bare workers for a long batch, run `reap` on a timer**, or use the
daemon and let it do the job it exists to do.

**To start it automatically at logon** (run this yourself; it changes a system
setting):

```powershell
$action = New-ScheduledTaskAction -Execute "python" -Argument "-m src.orchestrator.cli daemon" -WorkingDirectory "C:\Users\Mulen\Desktop\riket.se"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "RiketTV pipeline" -Action $action -Trigger $trigger -Settings $settings
```

`-StartWhenAvailable` is the important flag: it runs the task after a missed
schedule rather than skipping it, which is what makes an intermittently-on
machine behave.

## No new debates appear

The chain begins at `discover`. If nothing is being enqueued, nothing else runs.

```bash
python -m src.orchestrator.cli discover --dry-run   # what would be picked up
python -m src.orchestrator.cli discover             # one pass, for real
python -m src.orchestrator.cli enqueue --dokid <DOKID>   # force one debate
```

If `discover` fails, the usual cause is Riksdagen changing its page shape. See
**Riksdagen schema drift**.

## Backfilling the archive

Riksdagen's archive is large. Measured 2026-08-03:

| doktyp | What it is | Documents | Clippable? |
|---|---|---|---|
| `ip` | Interpellationsdebatt | 15,757 | yes — HD10540 was one |
| `kam-fs` | Frågestund | 604 | yes |
| `kam-sd` | Särskild debatt | 100 | yes |
| `kam-ad` | Aktuell debatt | 97 | yes |
| `kam-vo` | Beslut / Votering | 8,047 | **no** — procedural, nothing to clip |
| `kam-ip`, `kam-al` | Session wrappers | 684 | **no** — no speaker list |

Discovery is a **whitelist**, so guest visits, ceremonies and school tours never
appear. Only the four clippable types are in `DEFAULT_DISCOVERY_DOKTYPES`.

Backfill one month at a time and look at the result before continuing:

```bash
python -m src.orchestrator.cli backfill --from 2026-03-01 --to 2026-04-01 --dry-run
python -m src.orchestrator.cli backfill --from 2026-03-01 --to 2026-04-01
python scripts/pipeline_report.py --days 30
```

`--to` is **exclusive**, so consecutive months cannot double-count a day. Windows
may overlap safely anyway — the idempotency key admits each debate once.

Three things worth knowing:

- **Backfill never touches the discovery watermark.** It is a bounded historical
  operation; the daemon is the forward-moving loop. Sharing state is how
  backfilling January silently makes the daemon skip August.
- **Backfilled work is enqueued at negative priority**, so a debate from this
  morning is always claimed before an archive of 2024. Freshness is the product
  promise; back catalogue is inventory.
- **Expect skips.** Written interpellation answers and recess sessions have no
  video. They come back as `skipped`, not `dead`, so the dead-letter list stays
  meaningful. Everything from 2026-06-18 onward is currently in that category —
  the chamber had risen for the summer.

### The back catalogue decision

On a machine with no watermark, the first discovery pass sees Riksdagen's whole
document list and starts working through it. Observed 2026-08-03: it offered
debates from **2002, 2004, 2007, 2012 and 2016** — the archive goes back much
further than the "recent" list you might picture, so this is not a small
accident. At hours of processing per debate, that is a decision, so make it
deliberately:

```bash
# Only process debates published from now on.
python -m src.orchestrator.cli discover --since now

# Or from a specific date.
python -m src.orchestrator.cli discover --since 2026-01-01
```

Backfilling is a legitimate choice — the back catalogue is the fastest route to
the `Q-1` inventory threshold, and the freshness SLO already excludes old debates
by filtering on `debate_date`, so it cannot make the pipeline look artificially
fast. Just decide rather than discover it running.

`--max-enqueue` caps how many debates one pass offers (default 25). Anything over
the cap is **deferred, not skipped** — the watermark does not advance past it, so
the next pass picks it up.

### Changing `RIKET_WORK_DIR` silently resets discovery

The watermark is a file **inside the work dir**
(`<work_dir>/discovery_watermark.txt`). Point `RIKET_WORK_DIR` somewhere new —
a bigger disk, a different machine, a scratch directory — and the next `daemon`
or `discover` run finds no watermark, treats itself as a first run, and starts on
the 2002 archive. Nothing warns you; it just looks like discovery working hard.

This happened on 2026-08-03 when the work dir moved to `D:/riketvideos`. The
`--max-enqueue` cap was the only thing that kept it to 25 debates.

**When you move the work dir, carry the watermark or set it deliberately:**

```bash
# Carry it across.
cp <old_work_dir>/discovery_watermark.txt <new_work_dir>/

# Or pin it so only genuinely new debates are picked up.
python -c "from datetime import datetime; from pathlib import Path; \
Path('<new_work_dir>/discovery_watermark.txt').write_text(datetime.now().replace(microsecond=0).isoformat())"
```

`backfill` is unaffected — it never reads or writes the watermark, which is
exactly why it is the right tool for a historical window.

### "POSSIBLE GAP" in the discovery output

Riksdagen's document list is paginated. After a long enough outage, debates you
have not seen can fall off the end of the first page. When every record on a full
page is newer than the watermark, discovery says so rather than assuming it saw
everything. Re-run with a larger `--max-enqueue`, or enqueue the missing dokids
by hand.

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

## Rendering: many small jobs, not one big one

`render` enqueues one `render_clip` job per selected clip and completes
immediately. The clips render in parallel across whatever workers exist, and
`publish` runs only once every one of them has completed.

```bash
python -m src.orchestrator.cli status --dokid <DOKID>
```

| Symptom | What it means |
|---|---|
| Many `render_clip` queued, few running | Normal. Start more workers to go faster. |
| `publish` never appears | One clip is outstanding. A **dead** `render_clip` blocks the barrier deliberately — see below. |
| A clip rendered twice | Should not happen. `render_clip` skips an output that already exists; only `--force` re-encodes. |

**A dead clip blocks `publish` on purpose.** Shipping 399 of 400 clips and
calling the debate done would be worse than stopping. Fix the clip, then:

```bash
python -m src.orchestrator.cli retry --kind render_clip --dokid <DOKID>
```

Retrying is cheap: already-rendered clips are skipped in milliseconds, so only
the failed one actually encodes.

To re-render one clip by hand:

```bash
python -m src.stages.render --dokid <DOKID> --clip-id <CLIP_ID> --force
```

---

## Content problems

These are pipeline-quality issues, not outages. Every one is from the failure
table in `docs/ARCHITECTURE.md`.

| Symptom | Cause | What to do |
|---|---|---|
| Clip starts mid-sentence | Riksdagen metadata start time off by 30s+ | C3 widens the search window and fuzzy-matches; check `alignment_confidence` on the speech. Below 0.60 it should not have produced clips. |
| Wrong person on screen during a replik | Was the geometric C8 heuristic picking the largest/most-centred face | **Fixed (ADR 012).** C8 now verifies the track against the speaker's Riksdagen portrait with SFace and fails closed, so a mismatch drops the clip rather than mis-framing it. If you still see one, the clip predates the rebuild — republish it. |
| Whole speech rejected, no clips at all | No track cleared the identity thresholds | Expected for chamber-wide shots and fast reply exchanges. Read `decision` in `08_track/<clip_id>.json`: `rejected_no_portrait` (Riksdagen has no portrait for this person), `rejected_no_evidence` (no face detected at all), `rejected_identity_mismatch` (faces found, none is them), `rejected_ambiguous` (two candidates too close to separate). Yield near 35% is normal for frågestund and interpellation. |
| Sign-language interpreter framed as the speaker | Interpreter inset not excluded | Set `RIKET_SIGN_LANGUAGE_INSET_*` in `src/config.py` to exclude that region. |
| Speaker tiny in a wide chamber shot | Wide shot, no close-up available | The C7 gate rejects below `MIN_FACE_WIDTH_FRAC` (0.02) in `src/scoring/gate.py`. **Naming trap:** the feature dict key is still `face_height_frac`, but since ADR 013 it carries a face *width* fraction from C6v (`archetypes.py:152`). The key is legacy; the constant name is the truthful one. Without C6v it stays at the placeholder `1.0` and this gate silently passes everything. |
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

## Politician portrait mirror

The public app loads politician portraits from Pleni's Bunny CDN, not from
Riksdagen at request time. Profile enrichment and portrait mirroring stay
outside C1–C11 so a biography or image outage cannot block clip publication.

Migration 017 enqueues one low-priority `portrait_sync` IO job whenever C11
creates an unsynchronised politician. The job is visible only after C11's
transaction commits, runs independently of the debate chain and retries through
the normal queue. A failed portrait therefore cannot roll back published clips.
The migration also queues any unsynchronised rows that already exist when it is
applied.

After applying migrations, refresh all known politician metadata and portraits:

```bash
python scripts/sync_politician_profiles.py --dry-run --limit 3
python scripts/sync_politician_profiles.py
```

The non-dry run downloads the official 192 px JPEG, validates it, hashes the
exact bytes, uploads it under `portraits/<intressent_id>/<sha256>.jpg`, waits for
Bunny verification, and only then changes `public.politicians.avatar_url`.
`avatar_source_url` remains the official Riksdagen location and the UI credit
remains `Foto: Sveriges riksdag`.

The command is safe to repeat and remains the periodic whole-catalogue refresh.
An unchanged hash reuses the existing CDN object only after its public URL is
verified again. If Riksdagen or Bunny fails, the batch updates the other public
profile fields but retains the last verified portrait; it exits with status 2 so
the failure is visible. Riksdagen's explicit `HarBild=false` and an official
portrait 404 are expected no-photo outcomes, not sync failures: the politician
keeps the initials fallback and the job completes. `avatar_source_url` remains
available for a later refresh, but `avatar_url` must be null when no verified
mirror exists.

To inspect automatic portrait work:

```sql
select state, count(*)
from public.jobs
where kind = 'portrait_sync'
group by state
order by state;
```

The frontend retries a failed Bunny request twice with cache-busting query
parameters. If the mobile connection is still unavailable, the party-coloured
initials remain visible; the large profile portrait is requested eagerly while
list/feed portraits retain native lazy loading.

Required configuration is the normal Supabase Management API pair plus either
the direct Bunny storage access key/CDN URL or the Bunny account API key. Never
put either Bunny credential in a Vite environment variable.

---

## Party logo mirror

The app also serves all eight current Riksdag party marks from Pleni's Bunny
CDN. Migration 021 records each official Riksdagen PNG as provenance but leaves
the public URL empty until its mirror has been verified.

After applying migrations, validate the complete source set and then publish it:

```bash
python scripts/sync_party_logos.py --dry-run
python scripts/sync_party_logos.py
```

The command validates all eight HTTPS sources before uploading anything. Each
exact PNG is stored at `party-logos/<party-code>/<sha256>.png` and verified at
its public Bunny URL. Only after every object verifies does one atomic database
statement expose the eight URLs. The command checks that exactly eight rows were
updated; a source, upload, verification or row-count failure leaves the previous
complete public logo set in place. Re-running the command is safe because paths
are content-addressed.

The frontend must read only `party_profiles.logo_url`. It deliberately rejects
official `riksdagen.se` image hosts as a browser fallback; if a CDN image fails,
the existing party-coloured letter remains visible. `logo_source_url` is
provenance for the sync process, not a public rendering URL.

The command uses the same local Supabase Management API and Bunny storage
credentials as the portrait mirror. Those credentials never belong in Vite.

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

## Topic-search semantic backfill

This workflow indexes existing `private.clip_search_documents` through the same
PGMQ/Edge worker path used by future published clips. The operator script never
creates vectors itself and never needs the OpenAI key. Keep that key only in
Supabase Function secrets.

### Mandatory cost and health gate

Look up the current official `text-embedding-3-large` input price immediately
before each paid run and pass it explicitly; price is deliberately not a code
constant:

```powershell
python scripts/backfill_topic_search.py dry-run --price-per-million-usd 0.13
```

The dry run is read-only. It pages every eligible keyword document and invokes
the worker's existing TypeScript chunker locally, so the passage count follows
the production algorithm. Token count is a conservative estimate of one token
per three UTF-8 input bytes; actual provider usage is recorded by each worker
response. Do not enqueue the catalogue until the owner has seen and approved
this report's price.

Production dry run on 2026-08-25, before any successful semantic clip:

| Measure | Result |
|---|---:|
| Eligible/keyword documents | 3,188 |
| Estimated passages | 4,160 |
| Embedding-input UTF-8 bytes | 2,484,639 |
| Conservative estimated provider tokens | 828,213 |
| Price supplied | $0.13 / 1M input tokens |
| Estimated full cost | $0.107668 |
| Missing title / transcript / invalid hash / empty document | 0 / 0 / 0 / 0 |

The full start is still prohibited if the one-clip smoke does not complete. A
`provider_rate_limited` smoke result means leave the provider off and resolve the
OpenAI project limit first; adding thousands of queue messages does not test or
fix that condition.

### Status, enqueue and resume

```powershell
python scripts/backfill_topic_search.py status
python scripts/backfill_topic_search.py enqueue --batch-size 100 --max-enqueue 25
python scripts/backfill_topic_search.py status
```

Start with 25 clips after the smoke and cost gates pass. `enqueue` only writes
PGMQ messages; it does not enable OpenAI. The RPC accepts at most 200 clip IDs,
and the script enforces the same ceiling. `--max-enqueue` bounds a pass. Re-run
the command to resume: current documents and already queued source-hash/version
tuples are skipped, so a completed catalogue is a no-op.

After the 25-clip subset reaches current coverage without reviewed failures,
enqueue the remainder:

```powershell
python scripts/backfill_topic_search.py enqueue --batch-size 100
```

### Start, bounded dispatch and emergency stop

Provider use is a separate explicit switch:

```powershell
python scripts/backfill_topic_search.py start
python scripts/backfill_topic_search.py dispatch --workers 1
python scripts/backfill_topic_search.py status
python scripts/backfill_topic_search.py stop
```

`start` enables the existing one-per-minute cron dispatcher. Each worker claims
at most five documents. `dispatch --workers N` requests 1-4 additional existing
Edge workers through the same Vault-authenticated database dispatcher; begin at
one and increase only while provider limits, failures and spend remain healthy.
Queue visibility and source-hash/index-version checks prevent two workers from
successfully replacing the same current document.

Run `stop` before investigation whenever rate limits, authentication errors,
unexpected spend or repeated failures appear. It sets
`provider_enabled=false` and `provider_kill_switch=true`; queued work remains
durable for a later resume.

### Failures and completion

```powershell
python scripts/backfill_topic_search.py status
python scripts/backfill_topic_search.py retry-failed --batch-size 25 --max-enqueue 25
python scripts/backfill_topic_search.py dry-run --price-per-million-usd 0.13
```

Review `semantic_last_error` before retrying failures. `retry-failed` is
deliberately separate and uses `force=true`; do not loop it blindly. Completion
means `currentDocuments == documents`, zero pending/processing documents, and
every current document has at least one chunk matching its source hash and the
active index version. Re-running both dry-run and enqueue at completion must
report zero remaining cost/candidates and perform no writes.

### OPT5 fresh-first queues and future evidence

After migration 030 and the matching `search-embed` Function are explicitly
approved and deployed, ordinary publication keeps using the primary
`search_embeddings` queue. `enqueue` and `retry-failed` use the isolated
`search_embeddings_backfill` queue. The worker claims primary work first and
promotes at most the unused claim capacity from backlog only when no more fresh
row is claimable. A catalogue-sized backfill therefore cannot sit ahead of a
new publication.

Use the v2 status/closeout commands after migration 030:

```powershell
python scripts/backfill_topic_search.py status
python scripts/backfill_topic_search.py closeout-status --strict
```

`closeout-status` passes only when eligible clips and keyword documents match,
every document is semantic-current for the active source hash/index version,
there are no pending/processing/failed rows, and both queues are empty. It
contains counts and versions only.

Begin a future-publication sample at a recorded UTC timestamp while the worker
is operational. Once at least 20 normal publications have entered through C11,
run:

```powershell
python scripts/backfill_topic_search.py lag-report `
  --published-after 2026-08-27T00:00:00Z `
  --minimum-sample 20 --strict
```

The report retains clip id, active version, lifecycle timestamps and durations
only. It never contains a search query, embedding, person, party, address or
viewer identity. `published_at` is the start; semantic completion with a
matching source hash, active index version and at least one chunk is the end.
Workstation sleep is an operating-availability gap, not index latency, and must
be reported separately.

At 10,000 eligible documents and again after crossing 50,000, run the read-only
plan audit:

```powershell
python scripts/backfill_topic_search.py plan-audit
```

Below 10,000 it reports `due=false` without running `EXPLAIN ANALYZE`. At a
threshold it uses one already stored current vector as the probe and retains
only plan node/index names, row counts, timings and buffer counts. It makes no
OpenAI call and never writes a vector or query.

---

## Topic-search quality gate and controlled release

The semantic catalogue being complete does not make topic search releasable.
Keep `VITE_TOPIC_SEARCH_ENABLED=false` until every gate below is evidenced and
the owner gives an explicit production go/no-go. UI16.8 must not tune a live
ranking function, rotate a secret or deploy as part of evaluation.

### Offline evaluator

The committed fixture has three independent parts:

- `documents.json`: frozen retrieval pools and operational evidence;
- `judgments.json`: reviewer-authored Swedish queries and clip-level grades;
- `expected.json`: thresholds and explicit release approvals.

Run it without network or provider spend:

```powershell
python scripts/evaluate_topic_search.py evaluate
python scripts/evaluate_topic_search.py evaluate --strict-release
```

The first command validates and reports evidence even while release gates are
pending. `--strict-release` exits non-zero unless every quality, operational,
privacy, device and owner gate passes. Never make CI green by changing a pending
approval to true or by treating an unjudged clip as irrelevant.

Reviewers grade the union of the top ten keyword-only, semantic-only and hybrid
results for every query:

| Grade | Meaning |
|---:|---|
| 0 | not relevant |
| 1 | touches the subject but does not clearly satisfy the intent |
| 2 | clearly relevant |
| 3 | direct or nearly exact answer |

Set `reviewStatus=manual_complete` only after every pooled clip has a 0–3 grade.
AI suggestions may help arrange the queue but are not manual judgments. Query
fixtures are evaluation evidence only; do not copy them into aliases, product
code, suggested topics or a whitelist.

### Read-only three-mode capture

`capture-live` makes one bounded OpenAI embeddings request for the fixture
queries and read-only Management API retrieval calls. It refuses to run without
an explicit cost acknowledgment:

```powershell
python scripts/evaluate_topic_search.py capture-live --confirm-provider-cost
```

The command prints a candidate `documents.json`; review the diff before using
`--output`. It does not reserve the production provider budget, call a worker,
enqueue jobs or write to Postgres. A valid local `OPENAI_API_KEY`,
`RIKET_SUPABASE_PROJECT_REF` and `RIKET_SUPABASE_ACCESS_TOKEN` are required. Do
not retrieve or copy the deployed Function secret to make this work.

The explicit `--env-file` is authoritative. Long-lived desktop processes can
retain rejected keys or point to another Supabase project; before UI16.9 those
inherited values silently overrode the requested file and produced misleading
HTTP 401/403 errors. Never print a key or commit an environment file.

The 2026-08-25 post-v2 capture is complete: 36/36 three-mode query pools, 344
embedding tokens and two provider-free verified-event plans. Structured fixture
rows carry explicit UUID/date/source plans so capture reproduces production
interpretation; they are evaluation evidence, not product aliases, suggestions
or hard-coded topic terms.

### Current failed and pending gates

`docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md` is authoritative. Migrations
027/028 and `pleni-search-v2` are deployed with the viewer flag off. Both
negative queries now return empty; their raw semantic pools remain in the
fixture to prove the admission decision. The fixed 30-request post-cache sample
has p95 2,027.124 ms, so the strict <1,500 ms latency gate still fails even
though the former 6.99-second cold path is gone. The p95 request spent 1,121 ms
in OpenAI and 236 ms in retrieval.

The 36-query set has not been manually graded and no future-publish index-lag
sample exists. Actual OpenAI retention controls, the device matrix and owner
approval also remain pending. The Function currently uses global
`api.openai.com`; no `OPENAI_EMBEDDINGS_BASE_URL` secret is configured.

The real production privilege audit and catalogue coverage pass:

- `private` schema usage denied to `anon` and `authenticated`;
- private search tables have RLS and no browser read/write grant;
- private search helpers and all public search RPCs, including v2, preflight
  and cached-catalogue additions, are service-only;
- keyword coverage 3,188/3,188;
- semantic coverage 3,188/3,188 with 4,160 chunks and zero exceptions.

### Required latency and index-lag evidence

Agree the load profile before measuring it: client count, request rate, warm-up,
query mix, geographic origin, duration and whether cold starts are included.
Record every successful submitted-search duration and all failures/rate limits;
the gate is nearest-rank p95 below 1,500 ms. Do not silently discard the first
request or failed requests.

For future indexing, publish or update an owner-approved non-sensitive test clip
through the normal pipeline, record the document source-hash change time and the
first current matching chunk time, and repeat enough times to establish a p95.
The gate is below 120,000 ms. UI16.8 does not authorise this mutation by itself.

### OPT4 serial latency and cost benchmark

The final benchmark uses the public Function path and the ten committed smoke
phrases. The phrase text exists transiently only in each request. Reports use
`s01`–`s10`, result-count buckets and versions; no raw query, address,
credential or embedding is written. The Function exposes aggregate phases in
`Server-Timing` and actual prompt-token usage in
`X-Pleni-Search-Embedding-Tokens`; its JSON contract is unchanged.

Run exactly once on each of three separate UTC dates. Each run takes at least
203 seconds because the command enforces seven seconds between its 30 requests:

```powershell
python scripts/evaluate_topic_search.py benchmark-live `
  --confirm-live-requests `
  --price-per-million-usd 0.13 `
  --projected-monthly-queries 10000 `
  --output test_outputs/topic_search_latency_2026-08-27.json
```

Look up the current official embedding input price and use a real projected
monthly request count; the values above are examples, not product constants.
The first request is retained as a cold candidate, every HTTP/network failure
is retained, and the report contains total p50/p95/max plus preflight,
provider-budget, embedding and retrieval phase summaries.

After three dates, make the offline decision:

```powershell
python scripts/evaluate_topic_search.py latency-decision `
  --benchmark-report test_outputs/topic_search_latency_2026-08-27.json `
  --benchmark-report test_outputs/topic_search_latency_2026-08-28.json `
  --benchmark-report test_outputs/topic_search_latency_2026-08-29.json `
  --strict-release
```

The command refuses duplicate dates, incomplete call sequences or a
sub-seven-second interval. If all daily p95 gates pass, it retains
`text-embedding-3-large:1024`; no paid shadow is justified. Otherwise it still
retains the current model and asks for an owner SLO decision or separate paid
shadow-index approval. It never silently selects the small model, shortens the
provider timeout or forces keyword-only search.

### Privacy/account verification

Before release, capture account-side evidence—not marketing claims—for:

1. the OpenAI organisation/project used by the Functions;
2. selected regional/data-residency configuration and actual embeddings base
   URL;
3. Zero Data Retention, Modified Abuse Monitoring or effective default abuse-log
   retention;
4. API-data training opt-in state;
5. DPA, contracted entity, subprocessors/support access and incident contact.

Store screenshots or exported evidence outside Git if they contain account ids,
then record a redacted date/result in
`docs/privacy/TOPIC_SEARCH_RELEASE_EVIDENCE.md`. “Eligible for ZDR” is not the
same as “this project has ZDR.”

### Physical-device matrix

Use production-like, flag-on builds without enabling the production flag. For
each row test topic submit, `Tolkat som`, facet removal, ambiguity, empty/error/
keyword-fallback, a result row, `Spela alla`, one-clip swipes, Back restoration,
rotation/keyboard and no more than four media sources:

| Device/browser | Browser mode | Installed mode | Owner evidence |
|---|---|---|---|
| Android Chrome | pending | pending | device/version + result |
| Samsung Internet | pending | pending | device/version + result |
| iPhone Safari | pending | Home Screen pending | device/iOS/version + result |

An emulator is diagnostic evidence, not a physical-device pass.

### Staged release and rollback

There is no staging environment, so stage by capability:

1. Keep the production build flag false. Record the exact candidate commit.
2. Pass the full tests, three-mode manual benchmark, agreed load/index-lag tests,
   privacy/account checks and device matrix.
3. Confirm provider kill switch behavior produces honest keyword fallback.
4. Rehearse a flag-off build from the candidate commit and verify the ordinary
   identity/party search and `Senaste` feed remain unchanged.
5. Present the evidence matrix to the owner. Only an explicit **GO** authorises
   changing `VITE_TOPIC_SEARCH_ENABLED=true` and rebuilding/deploying InstaPods.
6. Immediately after an approved release, run positive, paraphrase, negative,
   error/fallback, result-feed and Back checks on `pleni.se`.

Rollback order:

1. Set `VITE_TOPIC_SEARCH_ENABLED=false`, rebuild and deploy the known-good
   flag-off commit with owner approval. This removes the viewer entry point;
   private tables/indexes may remain.
2. If provider spend or behavior is unsafe before that build finishes, run
   `python scripts/backfill_topic_search.py stop`. This forces the provider kill
   switch/keyword fallback and preserves index data.
3. Do not drop search tables or roll back migrations during an incident unless a
   separate destructive change has been reviewed and approved.
4. Record flag/build/commit times, observed impact, provider state and recovery
   verification in `PROGRESS.md`.

OPT4/OPT5 extend that sequence without making migration rollback the incident
path:

1. Frontend entry-point stop: set `VITE_TOPIC_SEARCH_ENABLED=false`, rebuild
   using the pinned InstaPods commands and verify `Senaste`, person and party
   search. The feature-flag unit test rehearses default-on production and
   explicit-false behavior on every full test run.
2. Provider emergency: run `python scripts/backfill_topic_search.py stop`.
   Public topic search remains available and reports keyword fallback honestly;
   queued primary/backfill work remains durable.
3. OPT3/OPT4/OPT5 Edge rollback: redeploy current accepted Function version 7
   from commit `af8238a`. It keeps ranking v3 but removes the unreleased
   intent/timing/worker changes. For a deeper ranking rollback, use documented
   commit `16a4887`, which calls v2; migrations 029 and 030 may remain applied
   because their objects are additive and service-only.
4. Index-version rollback: this release does not create or activate a shadow
   index. If a later approved shadow exists, restore the previously recorded
   active version atomically only after its matching chunks/coverage pass; do
   not overwrite or delete the former index during activation.
5. Queue recovery: inspect `status`, leave the provider off while diagnosing,
   use bounded `retry-failed` only after reviewing safe error codes, then
   `start` and `dispatch --workers 1`. Fresh primary work remains ahead of the
   historical backlog throughout recovery.

Automated tests rehearse the flag-off decision, provider-off/keyword fallback,
v2 response envelope, fresh-first claim order, queue idempotency and additive
down paths. An actual production redeploy/rollback remains a separately
authorised operation and must be recorded with timestamps before it can be
called a production rehearsal pass.

The rollback procedure is documented but has not been rehearsed against a
staged production release. Documentation alone is not a pass.

### Owner go/no-go record

The owner decision must name the candidate commit and explicitly confirm:

- quality and negative-query gates pass;
- latency, coverage and future-index-lag gates pass;
- privacy notice and OpenAI account evidence are approved;
- privilege/secret audit and physical devices pass;
- rollback has been rehearsed and the operator is available to monitor.

Silence, “proceed with evaluation,” prior backfill approval or approval of an
earlier UI16 chunk is not production release approval.

---

## Frontend PWA release and service-worker rollback

InstaPods serves only the static frontend and deploys `origin/main`. A PWA release
therefore needs the same review as any other frontend release, plus a worker
recovery path. Obtain the owner's explicit approval before pushing or deploying.
Do not change the working InstaPods commands while doing a rollback:

```text
Install: cd web && npm ci
Build:   cd web && node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && node ./node_modules/vite/bin/vite.js build && cd .. && rm -rf ./assets ./index.html ./dist && cp -R web/dist/. ./
```

### Release preflight

Build from the exact commit intended for release and keep its SHA as the known-good
rollback target:

```powershell
cd web
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
node .\scripts\verify-pwa-build.mjs
cd ..
python tasks.py test lint typecheck
git diff --check
```

After deployment, verify `https://pleni.se/`, `/manifest.json`, `/sw.js` and
all four PNG launcher assets. They must return 200 over HTTPS; the manifest must be
`application/json`, the worker JavaScript, and the icons `image/png`.
Because `/sw.js` is at the origin root, its normal `/` scope needs no broader
`Service-Worker-Allowed` header.

Use a fresh browser profile for first-install evidence and an already controlled
profile for update evidence. A normal correction must change the bytes served at
the existing `/sw.js` URL and retain scope `/`; changing the filename or merely
removing registration code does not replace a worker already installed in a
viewer's browser. The corrected worker should reach `installed`/waiting while the
old controller remains active. Activate it only through Pleni's Update action at a
point with no playing video and no non-empty comment draft, then confirm
`controllerchange`, reload and the new activated controller.

Inspect Cache Storage after first install and after update. Every `pleni-` cache
entry must be a same-origin app-shell URL. No MP4, Range response, Bunny/Supabase/
Clerk response, token or mutation may appear. An unrelated cache must survive
Pleni's selective cleanup.

### Preferred rollback: corrected worker under the same scope

1. Restore or fix the last known-good application and `web/src/sw.ts` without
   changing the worker URL or scope.
2. Build and run the full release preflight locally.
3. In a controlled local profile, confirm that the corrected worker waits rather
   than calling `skipWaiting()` during install.
4. Leave a video playing and a draft populated in separate checks: accepting the
   update must defer takeover/reload. Clear the unsafe activity and confirm the
   waiting worker activates, becomes controller, and reloads once.
5. With owner approval, deploy the corrected commit and repeat the normal and
   installed-mode checks on `pleni.se`.

This is the first response to a bad release. Use the emergency path only when the
active worker prevents the normal corrected worker or app UI from recovering.

### Emergency unregister worker

Do **not** deploy this in production as a drill. When it is genuinely required,
temporarily replace `web/src/sw.ts` with the following worker and deploy it at the
same `/sw.js` URL and `/` scope. The unused manifest reference is deliberate: it
keeps the current `injectManifest` build step valid without caching those entries.

```ts
/// <reference lib="webworker" />

export {};

type PrecacheEntry = string | { revision?: string | null; url: string };

declare global {
  interface WorkerGlobalScope {
    __WB_MANIFEST: PrecacheEntry[];
  }
}

const worker = self as unknown as ServiceWorkerGlobalScope;
const ignoredPrecacheManifest = self.__WB_MANIFEST;
void ignoredPrecacheManifest;

const CACHE_PREFIX = "pleni-";
const RECOVERY_MESSAGE = "PLENI_EMERGENCY_WORKER_READY";

worker.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(worker.skipWaiting());
});

worker.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX))
          .map((name) => caches.delete(name))
      );
      await worker.clients.claim();
      const windowClients = await worker.clients.matchAll({
        includeUncontrolled: true,
        type: "window"
      });
      for (const client of windowClients) {
        client.postMessage({ type: RECOVERY_MESSAGE });
      }
      await worker.registration.unregister();
    })()
  );
});
```

Automatic activation is intentional only for this emergency worker. It has no
`fetch` handler, deletes only cache names beginning `pleni-`, and unregisters
itself after takeover. It must not call `client.navigate()` or otherwise reload an
open page: a playing viewer or typed draft remains untouched. After the recovery
message/takeover, the viewer reloads only at a safe point; for an installed app,
close and relaunch after finishing playback or preserving the draft.

Verify recovery in both an ordinary tab and installed mode:

1. The current document does not reload during emergency takeover.
2. `navigator.serviceWorker.getRegistrations()` returns no Pleni registration.
3. `caches.keys()` contains no `pleni-` name, while a deliberately created
   unrelated cache remains.
4. MP4 playback still uses the network/browser HTTP cache; no media appears in
   Cache Storage.
5. Reload or relaunch at a viewer-safe point and confirm the network-served shell
   opens without a worker failure.
6. Immediately restore and deploy the recorded known-good commit. Its normal
   `/sw.js` registers again, recreates only the bounded app-shell cache, and reaches
   activated/controller state in normal and installed modes.

The emergency build is a bridge, not the final rollback state. Record the bad,
emergency and restored commit SHAs plus the production verification in
`PROGRESS.md`.

---

## Known sharp edges

Things that are true right now and will bite someone.

- **Nothing runs while the workstation is off.** Discovery catches up on the next
  start, so nothing is lost, but freshness is bounded by how often the machine is
  on. This is inherent to running locally, not a bug.
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
