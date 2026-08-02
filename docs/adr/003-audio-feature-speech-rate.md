# ADR 003: AudioFeatures carries rolling speech rate

Date: 2026-08-01

Status: Accepted

## Context

C5 must compute frame-level delivery features from C2 `analysis.wav` and C4
word timings. The C0 `AudioFeatures` contract already had RMS, F0, pauses, and
emphasis events, but the C5 build plan also requires speech rate as words per
second over a rolling 5s window.

C6/C7 need pace and pace variation as ranking signals. Without serializing
speech rate in the C5 artifact, later chunks would either recompute it from C4
transcripts or invent a parallel feature artifact.

## Decision

Add `speech_rate_wps: tuple[float, ...]` to `AudioFeatures`.

The array uses the same frame grid as `rms` and `f0`: 20 ms frames at
`frame_hz=50.0` for C2's 16 kHz analysis audio. Each value is words per second
computed over a centered rolling 5s window using C4 word timestamps. All word
timestamps remain float seconds relative to the master debate video.

## Consequences

- C5 writes one dense `speech_rate_wps` value per RMS/F0 frame.
- The `AudioFeatures` validator now requires `rms`, `f0`, and
  `speech_rate_wps` to have equal lengths.
- C6 can compute window-level pace features without re-reading C4 transcripts
  for every candidate scoring pass.
