"""Print the C13 pipeline health report.

    python scripts/pipeline_report.py
    python scripts/pipeline_report.py --days 30
    python scripts/pipeline_report.py --json

Read-only. Reads `RIKET_SUPABASE_PROJECT_REF` and `RIKET_SUPABASE_ACCESS_TOKEN`
from the environment or a gitignored `.env` at the repo root.

The freshness number is the one to watch. Until it exists, "fresh" is not
something the recommender can reason about (`P1-5`), and the `fresh_interest` /
`fresh_general` retrieval pools in the launch plan are named after a property
nobody has measured.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.config import get_settings  # noqa: E402
from src.errors import ConfigurationError  # noqa: E402
from src.observability.metrics import (  # noqa: E402
    freshness,
    inventory,
    party_distribution,
    stage_failures,
    stage_timings,
)
from src.publish.supabase import SupabaseManagementClient  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    """Print pipeline health, freshness and exposure."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="Trailing window for job metrics")
    parser.add_argument(
        "--freshness-days", type=int, default=30, help="Trailing window for the freshness SLO"
    )
    parser.add_argument("--json", action="store_true", help="Machine-readable output")
    args = parser.parse_args(argv)

    settings = get_settings()
    if not settings.supabase_project_ref or not settings.supabase_access_token:
        raise ConfigurationError(
            "Set RIKET_SUPABASE_PROJECT_REF and RIKET_SUPABASE_ACCESS_TOKEN. See .env.example."
        )
    client = SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )

    counts = inventory(client)
    timings = stage_timings(client, days=args.days)
    failures = stage_failures(client, days=args.days)
    slo = freshness(client, days=args.freshness_days)
    parties = party_distribution(client, days=args.days)

    if args.json:
        print(
            json.dumps(
                {
                    "inventory": dict(counts),
                    "stage_timings": [t.__dict__ for t in timings],
                    "stage_failures": [
                        {**f.__dict__, "failure_rate": f.failure_rate} for f in failures
                    ],
                    "freshness": {
                        "debates": slo.debates,
                        "published": slo.published,
                        "publish_rate": slo.publish_rate,
                        "p50_lag_hours": slo.p50_lag_hours,
                        "p95_lag_hours": slo.p95_lag_hours,
                        "worst_lag_hours": slo.worst_lag_hours,
                        "slowest": [s.__dict__ for s in slo.slowest],
                    },
                    "party_distribution": [p.__dict__ for p in parties],
                },
                indent=2,
                ensure_ascii=False,
                default=str,
            )
        )
        return 0

    _section("Inventory")
    print(
        f"  {counts['debates']} debates · {counts['speeches']} speeches · "
        f"{counts['published_clips']} published clips · {counts['parties']} parties"
    )
    if counts["published_clips"] < 2000:
        print(
            f"  Q-1: {counts['published_clips']} of ~2000 clips. Pool-based ranking "
            "is a shuffle below that."
        )

    _section(f"Freshness SLO — debate date to first clip, last {args.freshness_days} days")
    if slo.debates == 0:
        print("  no debates in the window")
    else:
        print(f"  {slo.published}/{slo.debates} debates published ({slo.publish_rate:.0%})")
        print(
            f"  p50 {_hours(slo.p50_lag_hours)} · p95 {_hours(slo.p95_lag_hours)} "
            f"· worst {_hours(slo.worst_lag_hours)}"
        )
        print(
            "  Measured from midnight on debate_date, not from when Riksdagen "
            "published the video. Treat as an upper bound."
        )
        for sample in slo.slowest:
            print(
                f"    {sample.debate_date}  {_hours(sample.lag_hours):>10}  "
                f"{sample.dokid}  {sample.title[:44]}"
            )

    _section(f"Stage timing — completed runs, last {args.days} days")
    if not timings:
        print("  no completed job runs yet")
    for timing in timings:
        print(
            f"  {timing.kind:<16} n={timing.runs:<4} "
            f"p50={timing.p50_ms / 1000:>8.1f}s  p95={timing.p95_ms / 1000:>8.1f}s  "
            f"max={timing.max_ms / 1000:>8.1f}s"
        )

    _section(f"Stage reliability — last {args.days} days")
    if not failures:
        print("  no job runs yet")
    for failure in failures:
        flag = "  <-- " if failure.failure_rate > 0.2 else "      "
        print(
            f"  {failure.kind:<16} runs={failure.runs:<4} "
            f"failed={failure.failures:<4} dead={failure.dead:<4} "
            f"rate={failure.failure_rate:>6.1%}{flag}"
        )
        if failure.last_error:
            print(f"      last: {failure.last_error[:96]}")

    _section(f"Party exposure — published clips, last {args.days} days")
    if not parties:
        print("  no clips published in the window")
    for party in parties:
        bar = "#" * min(40, round(party.share * 40))
        print(f"  {party.party:<8} {party.clips:>4} clips  {party.share:>6.1%}  {bar}")
    if parties:
        print("  Reported, not enforced. The balance policy is F0-13.")

    return 0


def _section(title: str) -> None:
    print(f"\n{title}\n{'-' * len(title)}")


def _hours(value: Any) -> str:
    if value is None:
        return "n/a"
    hours = float(value)
    if hours < 48:
        return f"{hours:.1f}h"
    return f"{hours / 24:.1f}d"


if __name__ == "__main__":
    raise SystemExit(main())
