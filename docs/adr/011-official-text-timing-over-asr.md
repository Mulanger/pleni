# ADR 011: Official transcript text with distributed timing, not ASR

Date: 2026-08-03

## Status

Accepted

## Context

C4 has never run speech recognition. `transcribe_dokid()` selects
`transcriber or OfficialTextTranscriber()`, and the orchestrator passes no
transcriber, so every debate has been transcribed by the deterministic backend.
`AutoSpeechTranscriber` — which uses faster-whisper when installed and falls back
to official text otherwise — exists in `src/asr/kb_whisper.py` and is never
selected by any production path.

This was not a deliberate decision anywhere on record. It was discovered on
2026-08-03 when the first backfill debate's `transcribe` job completed in
**1,688 ms for 20.6 minutes of audio**, which is impossible for real ASR.

What `OfficialTextTranscriber` produces:

- **text** from Riksdagen's published transcript — human-checked and
  authoritative;
- **word timings** distributed evenly across the speech window. Every word in
  `HD10367` sits exactly 0.411915 s after the previous one; in `HD10540`,
  0.399471 s. Every word carries `probability: 1.0`.

The artifact labels this honestly (`model: "official-text-timing"`), so unlike
the synthetic face box of ADR 010 nothing was disguised as measurement. But the
consequence was undocumented and nobody had decided it.

Two facts bound the decision:

- **Speech boundaries are real.** C3 segments with VAD and reports
  `alignment_confidence` around 0.84 on live debates, so the *window* each
  speech occupies is measured. Only word positions *within* a window are
  interpolated.
- **This machine has no GPU.** `torch` is installed as `2.11.0+cpu` and
  `cuda.is_available()` is False, contradicting `AGENTS.md`. KB-Whisper `large`
  on 12 CPU cores would dominate the pipeline; the whole debate currently takes
  **8 minutes 50 seconds** end to end.

## Decision

**Keep `OfficialTextTranscriber` as the production transcriber, as a recorded
choice rather than an accident.**

The text is Riksdagen's own transcript. For a service that puts words on screen
under a named politician's face, an authoritative transcript is *better* than
ASR output, not a degradation — ASR would introduce errors this avoids.

What is genuinely lost is sub-speech timing precision. Clip cut points are
chosen at sentence boundaries whose positions are interpolated, so a cut can be
off by roughly a word or two. Judged against output: the project owner reviewed
twelve clips built this way on 2026-08-03 and rated them "pretty much perfect".

`AutoSpeechTranscriber` stays in the tree. It is the path to real timings if the
approximation ever proves visible, and it degrades to this backend when
faster-whisper is unavailable.

## Consequences

**Easier.** A debate costs about 9 minutes instead of hours, which is what makes
a 64-debate month feasible on one workstation with no GPU. Transcription is also
deterministic, so re-running a debate produces identical artifacts and golden
files stay stable.

**Harder.** Clip boundaries cannot be tightened beyond interpolation accuracy. If
cuts ever need to land precisely on a pause or a sentence end, that requires real
ASR and the CPU cost that comes with it.

**Riskier.** Any feature that assumes accurate word timing will silently inherit
the approximation. The C6 candidate features that depend on timing —
`dead_air_frac`, speech rate — are computed against interpolated positions.
C5 audio features (RMS, F0) come from the actual waveform and are unaffected.

**Revisit if:** clip cuts are observed landing mid-sentence or clipping speech;
a caption feature is reintroduced (ADR 004 currently stands); or the pipeline
moves to hardware with a GPU, where the cost argument disappears.

## Contracts Impact

None. `Transcript.model` already carries the provenance string
`"official-text-timing"`, which is what made this discoverable at all.
