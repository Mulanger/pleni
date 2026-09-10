"""Release only the reviewed, additive Search V2 backend; leave V1 available.

Run from the operator .env directory. Credentials are never printed or written.
The function deploy uses Supabase's Management API multipart source upload.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.config import get_settings  # noqa: E402
from src.publish.supabase import SupabaseManagementClient  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["migrations", "function", "health"])
    args = parser.parse_args()
    settings = get_settings()
    client = SupabaseManagementClient(
        project_ref=settings.supabase_project_ref,
        access_token=settings.supabase_access_token,
        timeout_s=120,
        max_retries=0,
    )
    if args.action == "health":
        print(json.dumps(client.execute_sql("select public.search_index_health() as health;")))
        return
    if args.action == "migrations":
        recorded = {
            r["filename"]: r["checksum"]
            for r in client.execute_sql("select filename,checksum from public.schema_migrations;")[
                "result"
            ]
        }
        statements = []
        names = []
        for path in sorted((ROOT / "migrations").glob("03[345678]_search*.up.sql")):
            content = path.read_bytes()
            if b"\r\n" in content:
                raise RuntimeError("Migration must use committed LF line endings before release")
            checksum = hashlib.sha256(content).hexdigest()
            if path.name in recorded:
                if recorded[path.name] != checksum:
                    raise RuntimeError(f"Applied migration changed: {path.name}")
                continue
            names.append(path.name)
            statements.append(content.decode("utf-8"))
            statements.append(
                "insert into public.schema_migrations(filename,checksum) values "
                f"('{path.name}','{checksum}');"
            )
        if statements:
            client.execute_sql(
                "BEGIN; SET LOCAL statement_timeout='110s';\n"
                + "\n".join(statements)
                + "\nNOTIFY pgrst, 'reload schema'; COMMIT;"
            )
        print(json.dumps({"applied": names}))
        return
    functions = ROOT / "supabase/functions"
    files = [*sorted((functions / "_shared").rglob("*.ts")), functions / "clip-search-v2/index.ts"]
    boundary = "pleni-search-" + uuid.uuid4().hex
    metadata = json.dumps(
        {
            "name": "clip-search-v2",
            "entrypoint_path": "clip-search-v2/index.ts",
            "verify_jwt": False,
        }
    )
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'
        f"{metadata}\r\n"
    ).encode()
    for path in files:
        name = path.relative_to(functions).as_posix()
        body += (
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                f'filename="{name}"\r\n'
                "Content-Type: application/typescript\r\n\r\n"
            ).encode()
            + path.read_bytes()
            + b"\r\n"
        )
    body += f"--{boundary}--\r\n".encode()
    response = client.transport.request(
        "POST",
        f"https://api.supabase.com/v1/projects/{settings.supabase_project_ref}/functions/deploy?slug=clip-search-v2",
        body=body,
        timeout_s=120,
        headers={
            "Authorization": f"Bearer {settings.supabase_access_token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    if response.status not in (200, 201):
        raise RuntimeError(
            f"Function deploy failed ({response.status}): "
            f"{response.body[:500].decode('utf-8', errors='replace')}"
        )
    deployed = json.loads(response.body)
    print(
        json.dumps({key: deployed.get(key) for key in ["slug", "version", "status", "verify_jwt"]})
    )


if __name__ == "__main__":
    main()
