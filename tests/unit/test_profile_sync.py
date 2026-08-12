"""Tests for safe portrait state updates in the politician profile sync."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from pathlib import Path

import pytest

from scripts.sync_politician_profiles import (
    ExistingPolitician,
    ProfileSyncRow,
    profile_update_sql,
    retain_existing_portrait,
)
from src.errors import ExternalServiceError
from src.publish.bunny import BunnyUploadedObject
from src.riksdagen.client import HttpResponse, RiksdagenHTTPError
from src.riksdagen.profile_sync import (
    PORTRAIT_ABSENT,
    PORTRAIT_REUSED,
    person_explicitly_has_no_portrait,
    sync_one_politician,
)
from src.riksdagen.profiles import profile_from_person

SOURCE_URL = "https://data.riksdagen.se/filarkiv/bilder/ledamot/person-1_192.jpg"
JPEG = b"\xff\xd8\xff\xe0portrait-bytes\xff\xd9"


class FakeDatabase:
    def __init__(
        self,
        existing: ExistingPolitician,
        *,
        update_error: ExternalServiceError | None = None,
    ) -> None:
        self.existing = existing
        self.update_error = update_error
        self.queries: list[str] = []

    def execute_sql(self, query: str) -> Mapping[str, object]:
        self.queries.append(query)
        if query.lstrip().startswith("select"):
            return {
                "result": [
                    {
                        "intressent_id": self.existing.intressent_id,
                        "avatar_url": self.existing.avatar_url,
                        "avatar_source_url": self.existing.avatar_source_url,
                        "avatar_sha256": self.existing.avatar_sha256,
                    }
                ]
            }
        if self.update_error is not None:
            raise self.update_error
        return {}


class FakeRiksdagen:
    def __init__(
        self,
        person: Mapping[str, object],
        *,
        portrait_response: HttpResponse | None = None,
        fetch_error: ExternalServiceError | None = None,
        portrait_error: ExternalServiceError | None = None,
    ) -> None:
        self.person = person
        self.portrait_response = portrait_response or HttpResponse(
            status_code=200,
            body=JPEG,
            headers={"Content-Type": "image/jpeg"},
        )
        self.fetch_error = fetch_error
        self.portrait_error = portrait_error
        self.portrait_requests: list[str] = []

    def fetch_person_by_id(self, intressent_id: str) -> Mapping[str, object] | None:
        if self.fetch_error is not None:
            raise self.fetch_error
        return self.person

    def get(self, url: str, *, accept: str = "application/json") -> HttpResponse:
        self.portrait_requests.append(url)
        if self.portrait_error is not None:
            raise self.portrait_error
        return self.portrait_response


class FakeStorage:
    def __init__(self, *, upload_error: ExternalServiceError | None = None) -> None:
        self.upload_error = upload_error
        self.uploads: list[tuple[bytes, str, str]] = []

    def upload_file(
        self,
        local_path: Path,
        remote_path: str,
        *,
        content_type: str,
    ) -> BunnyUploadedObject:
        if self.upload_error is not None:
            raise self.upload_error
        body = local_path.read_bytes()
        self.uploads.append((body, remote_path, content_type))
        return BunnyUploadedObject(
            remote_path=remote_path,
            public_url=f"https://cdn.example/{remote_path}",
            bytes=len(body),
        )


def person_record(*, has_image: object | None = None) -> dict[str, object]:
    person: dict[str, object] = {
        "intressent_id": "person-1",
        "tilltalsnamn": "Anna",
        "efternamn": "Test",
        "bild_url_192": SOURCE_URL,
    }
    if has_image is not None:
        person["personuppgift"] = {
            "uppgift": [
                {
                    "kod": "HarBild",
                    "uppgift": [has_image],
                    "typ": "bilder",
                }
            ]
        }
    return person


def empty_existing() -> ExistingPolitician:
    return ExistingPolitician(
        intressent_id="person-1",
        avatar_url=None,
        avatar_source_url=None,
        avatar_sha256=None,
    )


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


def test_unchanged_portrait_still_passes_through_canonical_uploader() -> None:
    digest = hashlib.sha256(JPEG).hexdigest()
    canonical_url = f"https://cdn.example/portraits/person-1/{digest}.jpg"
    existing = ExistingPolitician(
        intressent_id="person-1",
        avatar_url=canonical_url,
        avatar_source_url=SOURCE_URL,
        avatar_sha256=digest,
    )
    database = FakeDatabase(existing)
    riksdagen = FakeRiksdagen(person_record())
    storage = FakeStorage()

    result = sync_one_politician(
        "person-1",
        database=database,
        riksdagen=riksdagen,
        storage=storage,
    )

    assert result.portrait_status == PORTRAIT_REUSED
    assert result.row.avatar_url == canonical_url
    assert result.row.mirrored_now is False
    assert storage.uploads == [
        (JPEG, f"portraits/person-1/{digest}.jpg", "image/jpeg")
    ]
    assert "profile_synced_at = pg_catalog.now()" in database.queries[-1]


def test_harbild_false_is_expected_absence_and_retains_verified_mirror() -> None:
    existing = ExistingPolitician(
        intressent_id="person-1",
        avatar_url="https://cdn.example/portraits/person-1/old.jpg",
        avatar_source_url=SOURCE_URL,
        avatar_sha256="a" * 64,
    )
    database = FakeDatabase(existing)
    riksdagen = FakeRiksdagen(person_record(has_image="FaLsE"))
    storage = FakeStorage()

    result = sync_one_politician(
        "person-1",
        database=database,
        riksdagen=riksdagen,
        storage=storage,
    )

    assert result.portrait_status == PORTRAIT_ABSENT
    assert result.row.avatar_url == existing.avatar_url
    assert result.row.avatar_sha256 == existing.avatar_sha256
    assert riksdagen.portrait_requests == []
    assert storage.uploads == []
    assert "profile_synced_at = pg_catalog.now()" in database.queries[-1]


def test_expected_absence_does_not_initialize_portrait_storage() -> None:
    def unavailable_storage() -> FakeStorage:
        raise AssertionError("portrait storage must stay lazy for HarBild=false")

    result = sync_one_politician(
        "person-1",
        database=FakeDatabase(empty_existing()),
        riksdagen=FakeRiksdagen(person_record(has_image=False)),
        storage=unavailable_storage,
    )

    assert result.portrait_status == PORTRAIT_ABSENT


def test_harbild_unknown_still_tries_the_official_portrait() -> None:
    assert person_explicitly_has_no_portrait(person_record(has_image="unknown")) is False

    riksdagen = FakeRiksdagen(person_record(has_image="unknown"))
    storage = FakeStorage()
    sync_one_politician(
        "person-1",
        database=FakeDatabase(empty_existing()),
        riksdagen=riksdagen,
        storage=storage,
    )

    assert riksdagen.portrait_requests == [SOURCE_URL]
    assert len(storage.uploads) == 1


def test_official_portrait_404_is_expected_absence_and_writes_null() -> None:
    database = FakeDatabase(empty_existing())
    riksdagen = FakeRiksdagen(
        person_record(),
        portrait_error=RiksdagenHTTPError(404, SOURCE_URL, b"not found"),
    )

    result = sync_one_politician(
        "person-1",
        database=database,
        riksdagen=riksdagen,
        storage=FakeStorage(),
    )

    assert result.portrait_status == PORTRAIT_ABSENT
    assert result.row.avatar_url is None
    assert result.row.avatar_sha256 is None
    assert '"avatar_url": null' in database.queries[-1]
    assert "profile_synced_at = pg_catalog.now()" in database.queries[-1]


@pytest.mark.parametrize("failure_boundary", ["profile", "portrait", "upload", "database"])
def test_targeted_sync_propagates_transient_failures(failure_boundary: str) -> None:
    error = ExternalServiceError(f"transient {failure_boundary} failure")
    database = FakeDatabase(
        empty_existing(),
        update_error=error if failure_boundary == "database" else None,
    )
    riksdagen = FakeRiksdagen(
        person_record(),
        fetch_error=error if failure_boundary == "profile" else None,
        portrait_error=error if failure_boundary == "portrait" else None,
    )
    storage = FakeStorage(upload_error=error if failure_boundary == "upload" else None)

    with pytest.raises(ExternalServiceError, match=failure_boundary):
        sync_one_politician(
            "person-1",
            database=database,
            riksdagen=riksdagen,
            storage=storage,
        )

    if failure_boundary != "database":
        assert len(database.queries) == 1
