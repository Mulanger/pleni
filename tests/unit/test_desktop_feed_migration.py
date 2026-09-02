"""Static safety checks for UI17's public debate-feed projection."""

from __future__ import annotations

from src.publish.migrations import MIGRATIONS_DIR


def _sql(direction: str) -> str:
    return (MIGRATIONS_DIR / f"031_desktop_debate_feed.{direction}.sql").read_text(
        encoding="utf-8"
    ).lower()


def test_desktop_feed_view_exposes_stable_identity_and_master_chronology() -> None:
    sql = _sql("up")

    assert "with (security_invoker = true)" in sql
    assert "src.id as source_id" in sql
    assert "s.start_s as speech_start_s" in sql
    assert "c.start_s as clip_start_s" in sql
    assert "c.published_at is not null" in sql
    assert "c.moderation <> 'rejected'" in sql
    assert "c.url_540x960 <> ''" in sql


def test_desktop_feed_view_keeps_public_read_narrow_and_rollback_complete() -> None:
    up = _sql("up")
    down = _sql("down")

    for sql in (up, down):
        assert "revoke all on public.feed_clip_catalogue from public" in sql
        assert (
            "grant select on public.feed_clip_catalogue "
            "to anon, authenticated, service_role"
        ) in sql
    assert "drop view if exists public.feed_clip_catalogue" in down
    assert "src.id as source_id" not in down
    assert "s.start_s as speech_start_s" not in down
    assert "c.start_s as clip_start_s" not in down
