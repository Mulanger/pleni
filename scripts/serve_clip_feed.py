# ruff: noqa: E501

"""Serve a local TikTok-style review feed from a clip manifest."""

from __future__ import annotations

import argparse
import json
import mimetypes
from collections.abc import Mapping, Sequence
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote, unquote, urlparse


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)

    manifest_path = args.manifest.resolve()
    manifest = normalize_manifest(manifest_path)
    server = build_server(args.host, args.port, manifest_path.parent, manifest)
    print(f"http://{args.host}:{args.port}")
    server.serve_forever()
    return 0


def normalize_manifest(manifest_path: Path) -> list[dict[str, object]]:
    raw_payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(raw_payload, list):
        raise ValueError("Manifest must be a JSON array")
    entries: list[dict[str, object]] = []
    for index, raw_entry in enumerate(raw_payload, start=1):
        if not isinstance(raw_entry, Mapping):
            raise ValueError("Manifest entries must be JSON objects")
        entry = cast(Mapping[str, Any], raw_entry)
        video_url = _video_url(entry, manifest_path.parent)
        thumb_url = _thumbnail_url(entry, manifest_path.parent)
        if video_url is None:
            continue
        entries.append(
            {
                "index": entry.get("index", index),
                "clip_id": entry.get("clip_id", ""),
                "speech_id": entry.get("speech_id", ""),
                "speaker_name": entry.get("speaker_name", ""),
                "party": entry.get("party", ""),
                "anforandetyp": entry.get("anforandetyp", ""),
                "archetype": entry.get("archetype", ""),
                "title": entry.get("title", ""),
                "duration_s": entry.get("duration_s", ""),
                "video_url": video_url,
                "thumb_url": thumb_url,
            }
        )
    return entries


def build_server(
    host: str,
    port: int,
    media_root: Path,
    manifest: list[dict[str, object]],
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_HEAD(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self._send_bytes(HTTPStatus.OK, "text/html; charset=utf-8", html_page(), send_body=False)
                return
            if parsed.path == "/manifest.json":
                body = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
                self._send_bytes(
                    HTTPStatus.OK,
                    "application/json; charset=utf-8",
                    body,
                    send_body=False,
                )
                return
            self._send_bytes(
                HTTPStatus.NOT_FOUND,
                "text/plain; charset=utf-8",
                b"Not found",
                send_body=False,
            )

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self._send_bytes(HTTPStatus.OK, "text/html; charset=utf-8", html_page())
                return
            if parsed.path == "/manifest.json":
                self._send_bytes(
                    HTTPStatus.OK,
                    "application/json; charset=utf-8",
                    json.dumps(manifest, ensure_ascii=False).encode("utf-8"),
                )
                return
            if parsed.path.startswith("/media/"):
                self._send_media(parsed.path.removeprefix("/media/"))
                return
            self._send_bytes(HTTPStatus.NOT_FOUND, "text/plain; charset=utf-8", b"Not found")

        def log_message(self, format: str, *args: object) -> None:
            del format, args

        def _send_media(self, encoded_name: str) -> None:
            filename = unquote(encoded_name)
            media_path = (media_root / filename).resolve()
            if media_root not in media_path.parents and media_path != media_root:
                self._send_bytes(HTTPStatus.FORBIDDEN, "text/plain; charset=utf-8", b"Forbidden")
                return
            if not media_path.exists() or not media_path.is_file():
                self._send_bytes(HTTPStatus.NOT_FOUND, "text/plain; charset=utf-8", b"Not found")
                return
            content_type = mimetypes.guess_type(media_path.name)[0] or "application/octet-stream"
            self._send_bytes(HTTPStatus.OK, content_type, media_path.read_bytes())

        def _send_bytes(
            self,
            status: HTTPStatus,
            content_type: str,
            body: bytes,
            *,
            send_body: bool = True,
        ) -> None:
            self.send_response(status.value)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if send_body:
                self.wfile.write(body)

    return ThreadingHTTPServer((host, port), Handler)


def html_page() -> bytes:
    return b"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Riket clip feed</title>
<style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #060606; color: #f6f4ee; overflow: hidden; }
body { display: grid; grid-template-columns: minmax(0, 1fr) 320px; }
.feed { height: 100svh; overflow-y: auto; scroll-snap-type: y mandatory; background: #000; }
.item { position: relative; height: 100svh; scroll-snap-align: start; display: grid; place-items: center; isolation: isolate; }
.item::after { content: ""; position: absolute; inset: auto 0 0; height: 45%; background: linear-gradient(to top, rgba(0,0,0,.72), rgba(0,0,0,0)); z-index: 1; pointer-events: none; }
video { width: min(100vw, 540px); height: min(100svh, 960px); max-height: 100svh; object-fit: cover; background: #111; transform: scale(.985); opacity: .72; transition: transform 220ms ease, opacity 220ms ease; }
.item.active video { transform: scale(1); opacity: 1; }
.meta { position: absolute; left: max(24px, calc((100vw - 540px) / 2 + 18px)); right: max(24px, calc((100vw - 540px) / 2 + 18px)); bottom: 28px; z-index: 2; text-shadow: 0 2px 20px rgba(0,0,0,.65); }
.speaker { font-size: 15px; font-weight: 750; line-height: 1.25; }
.title { margin-top: 8px; font-size: 22px; font-weight: 820; line-height: 1.12; letter-spacing: 0; }
.facts { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; color: rgba(246,244,238,.8); font-size: 12px; }
.facts span { border: 1px solid rgba(246,244,238,.18); border-radius: 999px; padding: 5px 8px; background: rgba(0,0,0,.2); }
.rail { border-left: 1px solid rgba(255,255,255,.09); background: #10100f; height: 100svh; overflow: auto; padding: 18px; }
.brand { font-size: 13px; color: rgba(246,244,238,.64); margin-bottom: 14px; }
.clip { width: 100%; border: 0; border-top: 1px solid rgba(255,255,255,.09); padding: 13px 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.clip strong { display: block; font-size: 14px; line-height: 1.25; font-weight: 760; }
.clip span { display: block; margin-top: 5px; color: rgba(246,244,238,.58); font-size: 12px; }
.clip.active strong { color: #9ee6d0; }
.controls { position: fixed; right: 340px; top: 50%; display: grid; gap: 10px; z-index: 5; transform: translateY(-50%); }
.controls button { width: 42px; height: 42px; border-radius: 999px; border: 1px solid rgba(255,255,255,.16); color: #fff; background: rgba(0,0,0,.45); backdrop-filter: blur(12px); cursor: pointer; font-size: 20px; }
@media (max-width: 840px) {
  body { display: block; }
  .rail { display: none; }
  .controls { right: 14px; }
  .meta { left: 18px; right: 72px; }
}
</style>
</head>
<body>
<main class="feed" id="feed"></main>
<aside class="rail"><div class="brand">Riket published test batch</div><div id="clips"></div></aside>
<div class="controls"><button id="prev" aria-label="Previous clip">&#8593;</button><button id="next" aria-label="Next clip">&#8595;</button></div>
<script>
const feed = document.getElementById('feed');
const clipsRail = document.getElementById('clips');
let entries = [];
let activeIndex = 0;
function text(value) { return value == null ? '' : String(value); }
function fact(value) { const v = text(value); return v ? `<span>${v}</span>` : ''; }
function render() {
  feed.innerHTML = entries.map((entry, i) => `
    <section class="item" data-index="${i}">
      <video src="${entry.video_url}" poster="${entry.thumb_url || ''}" playsinline muted loop preload="metadata"></video>
      <div class="meta">
        <div class="speaker">${text(entry.speaker_name)} ${entry.party ? '(' + text(entry.party) + ')' : ''}</div>
        <div class="title">${text(entry.title)}</div>
        <div class="facts">${fact(entry.archetype)}${fact(entry.anforandetyp)}${fact(entry.duration_s ? Math.round(Number(entry.duration_s)) + 's' : '')}</div>
      </div>
    </section>`).join('');
  clipsRail.innerHTML = entries.map((entry, i) => `
    <button class="clip" data-index="${i}">
      <strong>${String(i + 1).padStart(2, '0')} ${text(entry.title)}</strong>
      <span>${text(entry.speaker_name)} ${entry.party ? '(' + text(entry.party) + ')' : ''}</span>
    </button>`).join('');
  clipsRail.querySelectorAll('.clip').forEach(button => button.addEventListener('click', () => go(Number(button.dataset.index))));
  observe();
}
function setActive(index) {
  activeIndex = index;
  document.querySelectorAll('.item').forEach((item, i) => item.classList.toggle('active', i === index));
  document.querySelectorAll('.clip').forEach((item, i) => item.classList.toggle('active', i === index));
  document.querySelectorAll('video').forEach((video, i) => { if (i === index) video.play().catch(() => {}); else video.pause(); });
}
function observe() {
  const observer = new IntersectionObserver(items => {
    items.forEach(item => { if (item.isIntersecting) setActive(Number(item.target.dataset.index)); });
  }, { threshold: .72 });
  document.querySelectorAll('.item').forEach(item => observer.observe(item));
  setActive(0);
}
function go(index) {
  const bounded = Math.max(0, Math.min(entries.length - 1, index));
  document.querySelector(`.item[data-index="${bounded}"]`)?.scrollIntoView({ behavior: 'smooth' });
}
document.getElementById('prev').addEventListener('click', () => go(activeIndex - 1));
document.getElementById('next').addEventListener('click', () => go(activeIndex + 1));
window.addEventListener('keydown', event => {
  if (event.key === 'ArrowUp') go(activeIndex - 1);
  if (event.key === 'ArrowDown') go(activeIndex + 1);
});
fetch('/manifest.json').then(response => response.json()).then(data => { entries = data; render(); });
</script>
</body>
</html>"""


def _video_url(entry: Mapping[str, Any], manifest_dir: Path) -> str | None:
    cdn_urls = entry.get("cdn_urls")
    if isinstance(cdn_urls, Mapping):
        value = cdn_urls.get("540x960")
        if isinstance(value, str) and value:
            return value
    for key in ("url_540x960", "video_url", "mp4"):
        value = entry.get(key)
        if isinstance(value, str) and value:
            return value if _is_external_url(value) else _media_url(value, manifest_dir)
    return None


def _thumbnail_url(entry: Mapping[str, Any], manifest_dir: Path) -> str | None:
    cdn_urls = entry.get("cdn_urls")
    if isinstance(cdn_urls, Mapping):
        value = cdn_urls.get("thumb")
        if isinstance(value, str) and value:
            return value
    for key in ("thumb_url", "thumbnail", "thumbnail_url"):
        value = entry.get(key)
        if isinstance(value, str) and value:
            return value if _is_external_url(value) else _media_url(value, manifest_dir)
    return None


def _media_url(value: str, manifest_dir: Path) -> str:
    del manifest_dir
    return f"/media/{quote(Path(value).name)}"


def _is_external_url(value: str) -> bool:
    return value.startswith("https://") or value.startswith("http://")


if __name__ == "__main__":
    raise SystemExit(main())
