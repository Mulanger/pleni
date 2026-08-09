"""Tests for safe portrait state updates in the politician profile sync."""

from __future__ import annotations

from scripts.sync_politician_profiles import (
    ExistingPolitician,
    ProfileSyncRow,
    profile_update_sql,
    retain_existing_portrait,
)
from src.riksdagen.profiles import profile_from_person


def test_failed_refresh_retains_last_working_cdn_portrait() -> None:
    politician_profile = profile_from_person(
        {
            "intressent_id": "person-1",
            "tilltalsnamn": "Anna",
            "efternamn": "Test",
            "bild_url_192": ("https://data.riksdagen.se/filarkiv/bilder/ledamot/person-1_192.jpg"),
        }
    )
    existing = ExistingPolitician(
        intressent_id="person-1",
        avatar_url="https://cdn.example/portraits/person-1/old.jpg",
        avatar_source_url="https://data.riksdagen.se/old.jpg",
        avatar_sha256="a" * 64,
    )

    retained = retain_existing_portrait(politician_profile, existing)

    assert retained.avatar_url == existing.avatar_url
    assert retained.avatar_source_url == politician_profile.avatar_url
    assert retained.avatar_sha256 == existing.avatar_sha256
    assert retained.mirrored_now is False


def test_failed_refresh_does_not_publish_an_unverified_source_url() -> None:
    politician_profile = profile_from_person(
        {
            "intressent_id": "person-2",
            "tilltalsnamn": "Bo",
            "efternamn": "Bildlös",
            "bild_url_192": (
                "https://data.riksdagen.se/filarkiv/bilder/ledamot/person-2_192.jpg"
            ),
        }
    )
    existing = ExistingPolitician(
        intressent_id="person-2",
        avatar_url=politician_profile.avatar_url,
        avatar_source_url=politician_profile.avatar_url,
        avatar_sha256=None,
    )

    retained = retain_existing_portrait(politician_profile, existing)

    assert retained.avatar_url is None
    assert retained.avatar_source_url == politician_profile.avatar_url
    assert retained.avatar_sha256 is None
    assert retained.mirrored_now is False


def test_profile_update_sql_writes_source_hash_and_verified_timestamp_gate() -> None:
    politician_profile = profile_from_person(
        {
            "intressent_id": "person-1",
            "tilltalsnamn": "Anna",
            "efternamn": "Test",
        }
    )
    row = ProfileSyncRow(
        profile=politician_profile,
        avatar_url="https://cdn.example/portraits/person-1/hash.jpg",
        avatar_source_url=politician_profile.avatar_url,
        avatar_sha256="b" * 64,
        mirrored_now=True,
    )

    sql = profile_update_sql([row])

    assert "avatar_source_url = incoming.avatar_source_url" in sql
    assert "avatar_sha256 = incoming.avatar_sha256" in sql
    assert "when incoming.mirrored_now then pg_catalog.now()" in sql
    assert "https://cdn.example/portraits/person-1/hash.jpg" in sql
    assert '"avatar_sha256": "' + "b" * 64 in sql
