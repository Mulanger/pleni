# ADR 009: Python-native job queue on `public.jobs`

Date: 2026-08-02

## Status

Accepted. Supersedes the queue sentence in `docs/BUILD_PLAN.md` C12.

## Context

`docs/BUILD_PLAN.md` C12 and `docs/ARCHITECTURE.md` §Orchestration both say:

> **Queue:** since you're already on Postgres, use **pg-boss** or **Graphile Worker**.

The reasoning behind that line is sound and still holds: keep the queue in Postgres,
no extra infrastructure, transactional enqueue, inspectable with SQL. Only the
*implementation* is wrong for this repo, and it was written before the rest of the
stack settled.

Both named libraries are Node/TypeScript. The twelve stages they would orchestrate
are Python. That means a JavaScript supervisor shelling out to Python subprocesses,
a second package manager in the worker path, and job state that Python code can
only read through raw SQL anyway — because pg-boss's client API would live on the
other side of the process boundary.

ADR 005 has already committed the serving layer to Deno. Adding Node to the worker
path as well would make three runtimes for a project whose entire compute is
Python, and `AGENTS.md` rule 5 is explicit: *"Prefer stdlib. Prefer a dependency
already in the tree. Do not add a framework to solve a fifty-line problem."*

Celery and RQ are native to Python but both expect Redis or RabbitMQ. The launch
plan lists Redis under "explicitly not prerequisites — not justified at this
scale."

Meanwhile `public.jobs` already exists from migration 001, with `kind`,
`entity_id`, `idempotency_key unique`, `state`, `attempts`, `last_error`,
`payload` and `updated_at`. It has never been read or written by any code. The
schema for a work queue is already sitting in the database, unused.

## Decision

**Implement the queue in Python against `public.jobs`.** No queue framework, no new
runtime, no new infrastructure.

### Claiming is one atomic statement

The standard Postgres work-queue pattern:

```sql
update public.jobs
   set state = 'running', locked_at = now(), locked_by = %(worker)s,
       attempts = attempts + 1, updated_at = now()
 where id = (
   select id from public.jobs
    where state = 'queued' and run_after <= now() and pool = %(pool)s
    order by priority desc, id
      for update skip locked
    limit 1
 )
returning *;
```

`FOR UPDATE SKIP LOCKED` sits inside the subquery of a single `UPDATE`, so the whole
claim is one statement and one implicit transaction. **This matters more here than
in a typical deployment:** the worker reaches Postgres over a stateless HTTPS SQL
endpoint, where no transaction can be held open across round trips. A design that
needed `BEGIN; SELECT … FOR UPDATE; …; COMMIT;` would not work at all over that
transport. Every queue operation is therefore expressed as exactly one statement.

### Leases, not just locks

A row lock dies with its transaction, so `state = 'running'` needs its own
expiry. Each claim stamps `locked_at` and `locked_by`; a reaper returns jobs whose
lease has expired to `queued`.

This is what makes crash recovery work, and it is also the honest answer to a real
failure mode of the HTTPS transport: if the request times out *after* the `UPDATE`
committed, the worker has claimed a job it will never hear about. The lease expires
and another worker picks it up. Without leases that job would be lost forever.

### Retries and dead-lettering

`attempts` increments on claim, not on failure, so a worker that dies without
reporting still burns an attempt and cannot loop forever. Failure sets
`run_after = now() + backoff(attempts)` and returns the job to `queued`; once
`attempts >= max_attempts` the state becomes `dead` with the error in
`last_error`. Dead jobs are never claimed and never silently retried.

### Idempotency

Enqueue is `insert … on conflict (idempotency_key) do nothing`. Keys follow the
architecture's scheme — `render:<clip_id>:v1` — so enqueuing the same work twice is
a no-op, and a stage whose output already exists on disk returns without redoing it.

### Pools

`pool` is a column (`gpu`, `cpu`, `io`) and a worker claims only from its own pool.
Concurrency is how many workers you run, not a setting — which keeps the GPU pool
honest, because it is bounded by physical hardware rather than by a config value
somebody can raise.

## Consequences

We own the queue semantics: visibility timeouts, backoff, reaping, and the tests
that prove them. That is the real cost of this decision, and it is why the crash
recovery test is C12's stated acceptance criterion rather than a nice-to-have.

Polling replaces `LISTEN/NOTIFY`, because the stateless transport cannot hold a
listening connection. At a cadence of one debate every few hours, a poll every few
seconds is irrelevant — but it does mean the queue is not suitable for
latency-sensitive work, and the serving path must never be routed through it.

The queue is inspectable with plain SQL, which the Node libraries also offered, but
here the same SQL is reachable from the same language as the stages.

If throughput ever outgrows this — a genuine possibility once rendering fans out to
hundreds of parallel encodes — the migration path is to a direct `psycopg`
connection with real transactions and `LISTEN/NOTIFY`, not to a framework. The
schema would not change.

## Contracts Impact

None. `src/contracts.py` describes stage artifacts; job state is operational data
in Postgres and never enters a pipeline contract.
