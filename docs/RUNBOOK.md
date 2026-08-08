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
