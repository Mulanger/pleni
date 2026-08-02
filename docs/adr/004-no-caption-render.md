# ADR 004: No-Caption Render

Date: 2026-08-01

## Status

Accepted

## Context

The C10 build plan originally called for burned-in ASS captions, VTT output,
speaker lower-third, and source attribution. During Phase 4 implementation the
product direction changed: rendered clips should be full-bleed 9:16 mobile video
without captions.

## Decision

C10 renders the primary 540x960 MP4 and a vertical WebP thumbnail, but does not
generate ASS subtitle files, does not burn captions into the video, and does not
write a VTT sidecar.

## Consequences

Rendering is simpler and the output is visually cleaner for the requested
format. The pipeline loses in-video accessibility/search text until a future UI
or publishing layer carries transcript text separately. Future caption work
should be treated as a new product decision, not as unfinished C10 scope.

## Contracts Impact

No `src/contracts.py` changes. The existing `RenderedPaths.vtt` field remains
available for a future caption sidecar, but C10 does not currently emit a
`RenderedClip` artifact or create a VTT file.
