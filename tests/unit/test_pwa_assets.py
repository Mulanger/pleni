from __future__ import annotations

import json
import struct
import zlib
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = REPO_ROOT / "web"
PUBLIC_ROOT = WEB_ROOT / "public"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
ICON_RELEASE = "20260812b"


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


def _paeth(left: int, above: int, upper_left: int) -> int:
    estimate = left + above - upper_left
    left_distance = abs(estimate - left)
    above_distance = abs(estimate - above)
    upper_left_distance = abs(estimate - upper_left)
    if left_distance <= above_distance and left_distance <= upper_left_distance:
        return left
    if above_distance <= upper_left_distance:
        return above
    return upper_left


def _png_rgb_rows(path: Path) -> tuple[int, int, list[bytes]]:
    data = path.read_bytes()
    assert data.startswith(PNG_SIGNATURE)
    cursor = len(PNG_SIGNATURE)
    idat = bytearray()
    width = height = color_type = 0
    while cursor < len(data):
        length = struct.unpack(">I", data[cursor : cursor + 4])[0]
        kind = data[cursor + 4 : cursor + 8]
        payload = data[cursor + 8 : cursor + 8 + length]
        cursor += 12 + length
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = (
                struct.unpack(">IIBBBBB", payload)
            )
            assert bit_depth == 8
            assert compression == filtering == interlace == 0
            assert color_type in {2, 6}
        elif kind == b"IDAT":
            idat.extend(payload)
        elif kind == b"IEND":
            break

    channels = 3 if color_type == 2 else 4
    stride = width * channels
    encoded = zlib.decompress(bytes(idat))
    rows: list[bytes] = []
    previous = bytes(stride)
    offset = 0
    for _ in range(height):
        filter_type = encoded[offset]
        source = encoded[offset + 1 : offset + 1 + stride]
        offset += 1 + stride
        current = bytearray(stride)
        for index, value in enumerate(source):
            left = current[index - channels] if index >= channels else 0
            above = previous[index]
            upper_left = previous[index - channels] if index >= channels else 0
            if filter_type == 0:
                predictor = 0
            elif filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = above
            elif filter_type == 3:
                predictor = (left + above) // 2
            else:
                assert filter_type == 4
                predictor = _paeth(left, above, upper_left)
            current[index] = (value + predictor) & 0xFF
        rows.append(bytes(current))
        previous = current
    return width, channels, rows


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
    favicon_links = [link for link in head.links if link.get("rel") == "icon"]
    apple_links = [link for link in head.links if link.get("rel") == "apple-touch-icon"]
    viewports = [meta["content"] for meta in head.metas if meta.get("name") == "viewport"]

    assert manifest_links == [{"rel": "manifest", "href": "/manifest.json"}]
    assert favicon_links == [
        {"rel": "icon", "href": f"/favicon-{ICON_RELEASE}.ico", "sizes": "any"},
        {
            "rel": "icon",
            "type": "image/png",
            "sizes": "32x32",
            "href": f"/favicon-32-{ICON_RELEASE}.png",
        },
        {
            "rel": "icon",
            "type": "image/png",
            "sizes": "16x16",
            "href": f"/favicon-16-{ICON_RELEASE}.png",
        },
    ]
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

    ico = (PUBLIC_ROOT / f"favicon-{ICON_RELEASE}.ico").read_bytes()
    assert struct.unpack("<HHH", ico[:6]) == (0, 1, 3)


def test_favicon_and_install_icon_have_blue_edges_and_a_white_mark() -> None:
    for path in [
        PUBLIC_ROOT / f"favicon-32-{ICON_RELEASE}.png",
        PUBLIC_ROOT / "icons" / f"pleni-icon-512-{ICON_RELEASE}.png",
    ]:
        width, channels, rows = _png_rgb_rows(path)
        height = len(rows)
        corners = [
            rows[0][0:3],
            rows[0][(width - 1) * channels : (width - 1) * channels + 3],
            rows[-1][0:3],
            rows[-1][(width - 1) * channels : (width - 1) * channels + 3],
        ]
        for red, green, blue in corners:
            assert blue > red
            assert green > red
            assert max(red, green, blue) < 180

        central_rows = rows[height // 5 : height * 4 // 5]
        assert any(
            red > 235 and green > 235 and blue > 235
            for row in central_rows
            for red, green, blue in (
                row[index : index + 3]
                for index in range(0, len(row), channels)
            )
        )


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
