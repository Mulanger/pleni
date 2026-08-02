# ADR 002: 540x960 primary render rendition

Date: 2026-08-01

Status: Accepted

## Context

C1b and the new pipeline architecture document confirmed that current
Riksdagen webb-tv media tops out at a 1280x720 master for the checked debates.
A full-bleed 9:16 mobile output from that source can use at most a 406x720 crop.
The earlier contract and work layout encoded a 720/480 vertical rendition ladder,
but 720x1280 would only add interpolated pixels and extra bitrate.

The product decision is full-bleed 9:16 mobile video. Letterboxing and
caption-block layouts are out of scope for this pipeline.

## Decision

The primary render artifact is `10_render/<clip_id>_540x960.mp4`.

`RenderedPaths` now names `mp4_540x960` explicitly and leaves an optional
`mp4_360x640` slot for a future low-bandwidth rendition if telemetry justifies
one. Publish CDN URL keys should use the same rendition labels: `540x960` and,
if later added, `360x640`.

C10 should use the shared output settings in `src/config.py`:

- `OUTPUT_WIDTH = 540`
- `OUTPUT_HEIGHT = 960`
- `CROP_WIDTH = 406`
- `CROP_HEIGHT = 720`

## Consequences

- Later chunks should not generate or require `_720.mp4` or `_480.mp4` render
  artifacts.
- C10 still owns the full subtitle, camera, thumbnail, and final ffmpeg
  implementation; the current render stage remains a walking-skeleton stub.
- Adding another rendition later is additive if it uses `mp4_360x640`; changing
  the primary rendition again requires another ADR because it affects contracts,
  publish keys, path helpers, and downstream serving assumptions.
