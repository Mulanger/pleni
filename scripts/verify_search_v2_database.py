"""Rehearse additive search migrations and real catalogue regressions, then roll back.

Only engineering fixtures and aggregate counts are printed. No viewer queries are read.
Run from the directory containing the operator's .env; do not copy credentials.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.config import get_settings  # noqa: E402
from src.publish.supabase import SupabaseManagementClient  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vectors-only", action="store_true")
    args = parser.parse_args()
    settings = get_settings()
    client = SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=120,
        max_retries=0,
    )
    if args.vectors_only:
        sql = (ROOT / "tests/live/search_v2_vectors.sql").read_text(encoding="utf-8")
        result = client.execute_sql(
            "BEGIN; SET LOCAL statement_timeout='110s';" + sql + "ROLLBACK;"
        )
        print(json.dumps(result))
        return
    installed = {
        row["filename"]
        for row in client.execute_sql("select filename from public.schema_migrations;")["result"]
    }
    migrations = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((ROOT / "migrations").glob("03[345678]_search*.up.sql"))
        if path.name not in installed
    )
    assertions = (ROOT / "tests/live/search_v2_regression.sql").read_text(encoding="utf-8")
    checks = """select jsonb_build_object(
  'assertions', (select jsonb_object_agg(test,details) from search_v2_evidence
    where test<>'initial_health'),
  'health', (select details from search_v2_evidence where test='initial_health'),
  'years', (select jsonb_agg(jsonb_build_object('year',y,'results',
    jsonb_array_length(public.search_clips_v2(p_from=>make_date(y,1,1),
      p_to=>make_date(y,12,31),p_sort=>'newest')->'results'))) from generate_series(2023,2026) y),
  'words', (select jsonb_agg(jsonb_build_object('query',q,'expanded',
    private.search_v2_expanded_query(q)::text,'results',
    (select jsonb_agg(jsonb_build_object('id',r->'clip'->>'id','title',r->'clip'->>'title'))
      from jsonb_array_elements(public.search_clips_v2(p_topic=>q,p_limit=>5)->'results') r)))
    from unnest(array['elsparkcykel','elsparkcyklar','elsparcykel','el sparkcyklar',
      'bananministeriet på månen','kvantdatorer på varje förskola']) q)
) as verification;
"""
    # An explicit transaction makes extensions, DDL, cron jobs and seed writes reversible.
    result = client.execute_sql(
        "BEGIN; SET LOCAL statement_timeout='110s';\n"
        + migrations
        + assertions
        + checks
        + "ROLLBACK;"
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
