from __future__ import annotations

import json
import struct
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = REPO_ROOT / "web"
PUBLIC_ROOT = WEB_ROOT / "public"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
ICON_RELEASE = "20260812"


class _HeadParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[dict[str, str]] = []
        self.metas: list[dict[str, str]] = []

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        values = {key: value or "" for key, value in attrs}
        if tag == "link":
            self.links.append(values)
        elif tag == "meta":
            self.metas.append(values)


def _manifest() -> dict[str, Any]:
    value = json.loads((PUBLIC_ROOT / "manifest.json").read_text("utf-8"))
    assert isinstance(value, dict)
    return value


def _png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as png:
        assert png.read(8) == PNG_SIGNATURE
        length = struct.unpack(">I", png.read(4))[0]
        assert png.read(4) == b"IHDR"
        assert length == 13
        width, height = struct.unpack(">II", png.read(8))
    return width, height


def _head() -> _HeadParser:
    parser = _HeadParser()
    parser.feed((WEB_ROOT / "index.html").read_text("utf-8"))
    return parser


def test_manifest_has_stable_standalone_identity() -> None:
    manifest = _manifest()

    assert manifest["id"] == "/"
    assert manifest["name"] == "Pleni"
    assert manifest["short_name"] == "Pleni"
    assert manifest["lang"] == "sv"
    assert manifest["start_url"] == "/"
    assert manifest["scope"] == "/"
    assert manifest["display"] == "standalone"
    assert manifest["theme_color"] == "#050608"
    assert manifest["background_color"] == "#050608"
    assert "orientation" not in manifest


def test_manifest_icons_exist_with_declared_png_dimensions() -> None:
    icons = _manifest()["icons"]

    assert {icon["src"] for icon in icons} == {
        f"/icons/pleni-icon-192-{ICON_RELEASE}.png",
        f"/icons/pleni-icon-512-{ICON_RELEASE}.png",
        f"/icons/pleni-icon-maskable-512-{ICON_RELEASE}.png",
    }
    assert {icon["purpose"] for icon in icons} == {"any", "maskable"}
    assert any(icon["sizes"] == "192x192" for icon in icons)
    assert any(icon["sizes"] == "512x512" for icon in icons)
    assert any(icon["purpose"] == "maskable" for icon in icons)

    for icon in icons:
        assert icon["type"] == "image/png"
        assert icon["src"].startswith("/")
        expected = tuple(int(value) for value in icon["sizes"].split("x"))
        assert _png_dimensions(PUBLIC_ROOT / icon["src"].removeprefix("/")) == expected


def test_html_links_manifest_and_apple_icon_without_disabling_zoom() -> None:
    head = _head()
    manifest_links = [link for link in head.links if link.get("rel") == "manifest"]
    apple_links = [link for link in head.links if link.get("rel") == "apple-touch-icon"]
    viewports = [meta["content"] for meta in head.metas if meta.get("name") == "viewport"]

    assert manifest_links == [{"rel": "manifest", "href": "/manifest.json"}]
    assert apple_links == [
        {
            "rel": "apple-touch-icon",
            "sizes": "180x180",
            "href": f"/icons/pleni-apple-touch-icon-{ICON_RELEASE}.png",
        }
    ]
    assert _png_dimensions(
        PUBLIC_ROOT / "icons" / f"pleni-apple-touch-icon-{ICON_RELEASE}.png"
    ) == (180, 180)
    assert viewports == ["width=device-width, initial-scale=1, viewport-fit=cover"]
    viewport = viewports[0].lower().replace(" ", "")
    assert "user-scalable=no" not in viewport
    assert "maximum-scale" not in viewport


def test_html_has_ios_launch_metadata_and_matching_static_theme() -> None:
    head = _head()
    named_meta = {
        meta["name"]: meta["content"] for meta in head.metas if "name" in meta and "content" in meta
    }

    assert named_meta["application-name"] == "Pleni"
    assert named_meta["apple-mobile-web-app-capable"] == "yes"
    assert named_meta["apple-mobile-web-app-status-bar-style"] == "black"
    assert named_meta["apple-mobile-web-app-title"] == "Pleni"
    assert named_meta["theme-color"] == _manifest()["theme_color"]
