"""Bounded recovery using the deployed, authenticated embedding worker.

No alternate embedding or ingestion path. Secrets stay in process memory;
output contains aggregate worker counters only. Normal cron continues afterward.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.config import Settings  # noqa: E402
from src.publish.supabase import SupabaseManagementClient  # noqa: E402


def recovery_should_continue(
    *,
    elapsed_s: float,
    deadline_s: int,
    completed: int,
    max_clips: int,
    tokens: int,
    price: Decimal,
    max_usd: Decimal,
) -> bool:
    """Reserve 100k tokens for the next small wave before accepting more work."""
    reserved_cost = Decimal(tokens + 100_000) * price / Decimal(1_000_000)
    return elapsed_s < deadline_s and completed < max_clips and reserved_cost <= max_usd


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=2)
    parser.add_argument("--max-clips", type=int, required=True)
    parser.add_argument("--max-usd", type=Decimal, required=True)
    parser.add_argument("--price-per-million-usd", type=Decimal, required=True)
    parser.add_argument("--deadline-seconds", type=int, default=7200)
    args = parser.parse_args()
    if args.max_clips <= 0 or args.max_usd <= 0 or args.price_per_million_usd <= 0:
        parser.error("positive recovery bounds are required")
    settings = Settings(_env_file=args.env_file)  # type: ignore[call-arg]
    if not settings.supabase_project_ref or not settings.supabase_access_token:
        parser.error("project credentials unavailable")
    client = SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        max_retries=0,
        timeout_s=30,
    )
    rows = client.execute_sql(
        "select decrypted_secret from vault.decrypted_secrets "
        "where name = 'search_embed_worker_secret';"
    ).get("result", [])
    if not isinstance(rows, list) or len(rows) != 1:
        raise RuntimeError("worker credential unavailable")
    secret = rows[0]["decrypted_secret"]
    url = f"https://{settings.supabase_project_ref}.supabase.co/functions/v1/search-embed"

    def invoke(limit: int) -> dict[str, Any]:
        request = Request(
            url,
            data=json.dumps({"limit": limit}).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "X-Search-Worker-Secret": secret},
        )
        try:
            with urlopen(request, timeout=150) as response:
                result: dict[str, Any] = json.load(response)
            return result
        except (HTTPError, URLError, TimeoutError):
            return {"requestFailed": 1}

    counters = dict.fromkeys(
        ["claimed", "completed", "retried", "failed", "stale", "promptTokens", "requestFailed"], 0
    )
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        while recovery_should_continue(
            elapsed_s=time.monotonic() - started,
            deadline_s=args.deadline_seconds,
            completed=counters["claimed"],
            max_clips=args.max_clips,
            tokens=counters["promptTokens"],
            price=args.price_per_million_usd,
            max_usd=args.max_usd,
        ):
            remaining = args.max_clips - counters["claimed"]
            limits = []
            for _ in range(args.workers):
                limit = min(10, remaining)
                if limit <= 0:
                    break
                limits.append(limit)
                remaining -= limit
            wave_claimed = 0
            for result in pool.map(invoke, limits):
                for key in counters:
                    value = result.get(key, 0)
                    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                        counters[key] += value
                wave_claimed += result.get("claimed", 0)
            print(
                json.dumps(
                    {
                        **counters,
                        "elapsedSeconds": round(time.monotonic() - started),
                        "observedCostUsd": str(
                            Decimal(counters["promptTokens"])
                            * args.price_per_million_usd
                            / Decimal(1_000_000)
                        ),
                    }
                ),
                flush=True,
            )
            if counters["requestFailed"] or counters["failed"] or not wave_claimed:
                break
    return int(counters["failed"] > 0 or counters["requestFailed"] > 0)


if __name__ == "__main__":
    raise SystemExit(main())
