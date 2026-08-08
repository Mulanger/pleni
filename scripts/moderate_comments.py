"""Review reports and moderate Pleni video comments.

The public app can report content but cannot perform moderator actions. This
operator CLI calls service-role-only database functions through the Supabase
Management API, leaving an append-only audit event for every action.

Examples:

    python scripts/moderate_comments.py reports
    python scripts/moderate_comments.py hide COMMENT_UUID --reason "Olaga hot"
    python scripts/moderate_comments.py suspend @username --hours 24 --reason "Repeated spam"
    python scripts/moderate_comments.py unsuspend @username --reason "Appeal accepted"
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.config import get_settings  # noqa: E402
from src.errors import ConfigurationError  # noqa: E402
from src.publish.supabase import (  # noqa: E402
    SupabaseManagementClient,
    sql_jsonb_literal,
)


def main(argv: list[str] | None = None) -> int:
    """Run one report or moderation command."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--moderator", default="operator", help="Name stored in the audit event.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("reports", help="List open reports, oldest first.")

    for action in ("hide", "restore", "delete"):
        command = subparsers.add_parser(action, help=f"{action.title()} one comment.")
        command.add_argument("comment_id")
        command.add_argument("--reason", required=True)

    suspend = subparsers.add_parser("suspend", help="Suspend a comment username.")
    suspend.add_argument("username")
    suspend.add_argument("--hours", type=int, default=24)
    suspend.add_argument("--reason", required=True)

    unsuspend = subparsers.add_parser("unsuspend", help="Remove a username suspension.")
    unsuspend.add_argument("username")
    unsuspend.add_argument("--reason", required=True)

    args = parser.parse_args(argv)
    database = _database()

    if args.command == "reports":
        _print_reports(database.execute_sql(_REPORTS_SQL))
        return 0

    if args.command in {"hide", "restore", "delete"}:
        payload = {
            "comment_id": args.comment_id,
            "action": args.command,
            "reason": args.reason,
            "moderator": args.moderator,
        }
        database.execute_sql(_moderate_sql(payload))
        print(f"{args.command}: {args.comment_id}")
        return 0

    username = str(args.username).strip().lower().removeprefix("@")
    if args.command == "suspend" and args.hours < 1:
        parser.error("--hours must be positive")
    payload = {
        "username": username,
        "hours": args.hours if args.command == "suspend" else None,
        "reason": args.reason,
        "moderator": args.moderator,
    }
    database.execute_sql(_suspension_sql(payload))
    print(f"{args.command}: @{username}")
    return 0


def _database() -> SupabaseManagementClient:
    settings = get_settings()
    if not settings.supabase_project_ref or not settings.supabase_access_token:
        raise ConfigurationError(
            "Set RIKET_SUPABASE_PROJECT_REF and RIKET_SUPABASE_ACCESS_TOKEN "
            "in the root .env before moderating comments."
        )
    return SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=settings.http_timeout_s,
        max_retries=settings.max_http_retries,
    )


_REPORTS_SQL = """
select
  report.id as report_id,
  report.created_at,
  report.reason,
  comment.id as comment_id,
  comment.author_username,
  comment.body
from public.comment_reports as report
join public.video_comments as comment on comment.id = report.comment_id
where report.status = 'open'
order by report.created_at
limit 100;
""".strip()


def _moderate_sql(payload: object) -> str:
    literal = sql_jsonb_literal(payload)
    return f"""
with input as (
  select * from jsonb_to_record({literal}) as value(
    comment_id text, action text, reason text, moderator text
  )
)
select public.moderate_video_comment(
  input.comment_id::uuid, input.action, input.reason, input.moderator
)
from input;
""".strip()


def _suspension_sql(payload: object) -> str:
    literal = sql_jsonb_literal(payload)
    return f"""
with input as (
  select * from jsonb_to_record({literal}) as value(
    username text, hours integer, reason text, moderator text
  )
), target as (
  select profile.clerk_user_id
  from public.comment_profiles as profile, input
  where profile.username = input.username
)
select public.set_comment_user_suspension(
  (select target.clerk_user_id from target),
  case when input.hours is null then null else now() + make_interval(hours => input.hours) end,
  input.reason,
  input.moderator
)
from input;
""".strip()


def _print_reports(response: Mapping[str, Any]) -> None:
    rows = response.get("result", [])
    if not isinstance(rows, list) or not rows:
        print("No open reports.")
        return
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        body = str(row.get("body") or "").replace("\n", " ")
        if len(body) > 100:
            body = f"{body[:97]}..."
        print(
            f"{row.get('created_at')}  {row.get('reason')}  "
            f"{row.get('comment_id')}  @{row.get('author_username')}  {body}"
        )


if __name__ == "__main__":
    raise SystemExit(main())
