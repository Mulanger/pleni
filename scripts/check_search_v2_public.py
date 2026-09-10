"""Anonymous engineering acceptance/latency sample, or local preview with public keys.

Operator credentials only retrieve the publishable key. Neither tokens nor
viewer searches are printed. All searches below are fixed regression fixtures.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.config import get_settings  # noqa: E402
from src.publish.supabase import SupabaseManagementClient  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    settings = get_settings()
    client = SupabaseManagementClient(
        project_ref=settings.supabase_project_ref, access_token=settings.supabase_access_token
    )
    keys_response = client.transport.request(
        "GET",
        f"https://api.supabase.com/v1/projects/{settings.supabase_project_ref}/api-keys",
        headers={"Authorization": f"Bearer {settings.supabase_access_token}"},
        body=None,
        timeout_s=30,
    )
    if keys_response.status != 200:
        raise RuntimeError("Public API key lookup failed")
    keys = json.loads(keys_response.body)
    key = next(row["api_key"] for row in keys if row.get("type") == "publishable")
    url = f"https://{settings.supabase_project_ref}.supabase.co"
    if args.preview:
        subprocess.run(
            [
                "node",
                "node_modules/vite/bin/vite.js",
                "--host",
                "127.0.0.1",
                "--port",
                "5199",
                "--strictPort",
            ],
            cwd=ROOT / "web",
            check=True,
            env={
                **os.environ,
                "VITE_SUPABASE_URL": url,
                "VITE_SUPABASE_PUBLISHABLE_KEY": key,
                "VITE_TOPIC_SEARCH_ENABLED": "true",
            },
        )
        return
    evidence = []

    def search(body: dict, endpoint: str = "clip-search-v2") -> dict:
        started = time.monotonic()
        result = client.transport.request(
            "POST",
            f"{url}/functions/v1/{endpoint}",
            headers={
                "apikey": key,
                "Origin": "https://pleni.se",
                "Content-Type": "application/json",
            },
            body=json.dumps(body).encode(),
            timeout_s=30,
        )
        latency = round((time.monotonic() - started) * 1000)
        data = json.loads(result.body)
        if result.status != 200:
            raise RuntimeError(
                f"Public acceptance failed for engineering fixture {body.get('query')!r}: "
                f"{result.status} {data}"
            )
        evidence.append(
            {
                "endpoint": endpoint,
                "query": body.get("query"),
                "suggest": body.get("operation") == "suggest",
                "milliseconds": latency,
                "mode": data.get("mode"),
                "count": len(data.get("results", data.get("suggestions", []))),
                "ids": [r["clip"]["id"] for r in data.get("results", [])[:5]],
            }
        )
        return data

    target = "HD10552_cabb9ba6-5d6e-f111-bf27-6805cafeabf9_c02"
    for year in range(2023, 2027):
        first = search({"query": str(year)})
        assert len(first["results"]) == 20 and first["sort"] == "newest"
        second = search({"query": str(year), "cursor": first["nextCursor"]})
        ids = [r["clip"]["id"] for r in first["results"] + second["results"]]
        assert len(ids) == len(set(ids)) == 40
        assert all(r["clip"]["debateDate"].startswith(str(year)) for r in second["results"])
    for query in ["elsparkcykel", "elsparkcyklar", "elsparcykel", "el sparkcyklar"]:
        result = search({"query": query})
        assert target in [r["clip"]["id"] for r in result["results"][:5]], query
    for query in ["bananministeriet på månen", "kvantdatorer på varje förskola"]:
        assert not search({"query": query})["results"], query
    search({"query": "trafiksäkerhet för små elektriska hyrfordon"})
    for query in ["2023", "elsparkcykel", "elsparkcyklar"]:
        search({"query": query}, "clip-search")
    for _ in range(3):
        for query in ["2023", "elsparkcykel", "skatter 2024"]:
            search({"query": query})
        for query in ["20", "Magdalena", "budget"]:
            search({"operation": "suggest", "query": query})

    def p95(values: list[int]) -> int:
        return sorted(values)[math.ceil(len(values) * 0.95) - 1]

    summary = {
        "observations": evidence,
        "p95Ms": {
            "search": p95(
                [
                    e["milliseconds"]
                    for e in evidence
                    if not e["suggest"] and e["endpoint"] == "clip-search-v2"
                ]
            ),
            "suggestions": p95([e["milliseconds"] for e in evidence if e["suggest"]]),
        },
    }
    (ROOT / "test_outputs/search-v2-public.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
