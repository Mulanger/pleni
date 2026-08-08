"""Security and behaviour guardrails for the per-video comments migration."""

from __future__ import annotations

from src.publish.migrations import MIGRATIONS_DIR


def _sql() -> str:
    return (MIGRATIONS_DIR / "012_video_comments.up.sql").read_text(encoding="utf-8").lower()


def _function(sql: str, name: str, next_name: str) -> str:
    start = sql.index(f"create or replace function public.{name}")
    end = sql.index(f"create or replace function public.{next_name}", start)
    return sql[start:end]


def test_comment_tables_are_inaccessible_except_through_rpcs() -> None:
    sql = _sql()

    for table in (
        "comment_profiles",
        "video_comments",
        "comment_reports",
        "comment_moderation_events",
    ):
        assert f"alter table public.{table} enable row level security" in sql
        assert f"revoke all on public.{table} from public, anon, authenticated" in sql
        assert f"grant select on public.{table} to anon" not in sql
        assert f"grant select on public.{table} to authenticated" not in sql


def test_public_comment_projection_never_returns_clerk_subjects() -> None:
    sql = _sql()
    function = _function(sql, "list_video_comments", "create_video_comment")

    assert "'author_username', comment.author_username" in function
    assert "'author_user_id'" not in function
    assert "'clerk_user_id'" not in function
    assert "grant execute on function public.list_video_comments(text, integer) to anon" in sql


def test_posting_uses_verified_subject_and_enforces_first_version_limits() -> None:
    sql = _sql()
    function = _function(sql, "create_video_comment", "delete_video_comment")

    assert "auth.jwt() ->> 'sub'" in function
    assert "character_length(normalized_body) > 500" in function
    assert "comment_links_not_allowed" in function
    assert "comment_rate_limited" in function
    assert "clip.published_at is not null" in function
    assert "profile.suspended_until > now()" in function
    anon_grant = "grant execute on function public.create_video_comment(text, text, text) to anon"
    assert anon_grant not in sql
    assert (
        "grant execute on function public.create_video_comment(text, text, text) to authenticated"
        in sql
    )


def test_delete_is_scoped_to_the_authenticated_owner() -> None:
    sql = _sql()
    function = _function(sql, "delete_video_comment", "report_video_comment")

    assert "author_user_id = subject" in function
    assert "status = 'deleted'" in function
    assert "grant execute on function public.delete_video_comment(uuid) to anon" not in sql


def test_reports_do_not_automatically_hide_comments() -> None:
    sql = _sql()
    function = _function(sql, "report_video_comment", "moderate_video_comment")

    assert "insert into public.comment_reports" in function
    assert "update public.video_comments" not in function
    assert "grant execute on function public.report_video_comment(uuid, text) to anon" in sql


def test_signed_viewer_can_report_before_creating_a_comment_profile() -> None:
    sql = (MIGRATIONS_DIR / "013_comment_reporter_identity.up.sql").read_text(
        encoding="utf-8"
    ).lower()

    assert "drop constraint if exists comment_reports_reporter_user_id_fkey" in sql


def test_moderator_actions_are_service_role_only_and_audited() -> None:
    sql = _sql()
    function = _function(sql, "moderate_video_comment", "set_comment_user_suspension")

    assert "insert into public.comment_moderation_events" in function
    assert (
        "grant execute on function public.moderate_video_comment(uuid, text, text, text) "
        "to service_role"
        in sql
    )
    assert (
        "grant execute on function public.moderate_video_comment(uuid, text, text, text) "
        "to authenticated"
        not in sql
    )
