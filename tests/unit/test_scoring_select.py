"""Tests for C7 portfolio selection."""

from __future__ import annotations

from src.contracts import Candidate, Sentence, SentenceSpan, Speech, Transcript, Word
from src.scoring.select import overlap_fraction, select_for_speech, selection_count


def test_selection_count_scales_with_duration_and_cap() -> None:
    assert selection_count(duration_s=120.0, passing_count=10) == 2
    assert selection_count(duration_s=20.0, passing_count=3) == 1
    assert selection_count(duration_s=1200.0, passing_count=20) == 10
    assert selection_count(duration_s=1200.0, passing_count=0) == 0


def test_overlap_fraction_uses_shorter_candidate() -> None:
    first = _candidate(0.0, 50.0, score=1.0, archetype="EXPLAIN")
    second = _candidate(40.0, 90.0, score=1.0, archetype="CONFRONT")

    assert overlap_fraction(first, second) == 0.2


def test_select_for_speech_rejects_overlap_and_caps_archetype() -> None:
    speech = _speech(duration_s=300.0)
    transcript = _transcript()
    candidates = (
        _candidate(0.0, 50.0, score=10.0, archetype="CONFRONT"),
        _candidate(35.0, 85.0, score=9.0, archetype="CONFRONT"),
        _candidate(60.0, 110.0, score=8.0, archetype="CONFRONT"),
        _candidate(120.0, 170.0, score=7.0, archetype="EXPLAIN"),
        _candidate(180.0, 230.0, score=6.0, archetype="QUOTABLE"),
        _candidate(240.0, 290.0, score=5.0, archetype="EXPLAIN"),
    )

    selected = select_for_speech(
        speech=speech,
        transcript=transcript,
        candidates=candidates,
        max_overlap_frac=0.20,
    )

    assert len(selected) == 5
    assert [clip.start_s for clip in selected] == [0.0, 60.0, 120.0, 180.0, 240.0]
    assert sum(1 for clip in selected if clip.archetype == "CONFRONT") == 2
    assert selected[0].clip_id == "speech-1_c01"
    assert selected[0].rank == 1


def test_select_for_speech_returns_empty_when_all_fail_gate() -> None:
    speech = _speech(duration_s=120.0)
    transcript = _transcript()
    candidates = (_candidate(0.0, 50.0, score=10.0, archetype="CONFRONT", gate=False),)

    assert (
        select_for_speech(
            speech=speech,
            transcript=transcript,
            candidates=candidates,
            max_overlap_frac=0.20,
        )
        == []
    )


def _speech(*, duration_s: float) -> Speech:
    return Speech(
        speech_id="speech-1",
        dokid="dok",
        speaker_name="Test Talare",
        party="S",
        anforandetyp="Anförande",
        start_s=0.0,
        end_s=duration_s,
        official_text=None,
        alignment_confidence=1.0,
        needs_review=False,
    )


def _transcript() -> Transcript:
    words: list[Word] = []
    sentences: list[Sentence] = []
    for index in range(30):
        words.append(
            Word(
                text=f"Ord{index}.",
                start_s=index * 10.0,
                end_s=index * 10.0 + 10.0,
                probability=1.0,
            )
        )
        sentences.append(
            Sentence(
                index=index,
                start_s=index * 10.0,
                end_s=index * 10.0 + 10.0,
                text=f"Mening {index}.",
                word_indices=(index,),
            )
        )
    return Transcript(
        speech_id="speech-1",
        words=tuple(words),
        sentences=tuple(sentences),
        model="test",
        language="sv",
    )


def _candidate(
    start_s: float,
    end_s: float,
    *,
    score: float,
    archetype: str,
    gate: bool = True,
) -> Candidate:
    start_index = int(start_s // 10.0)
    end_index = int(end_s // 10.0) - 1
    return Candidate(
        speech_id="speech-1",
        start_s=start_s,
        end_s=end_s,
        sentence_span=SentenceSpan(start_index=start_index, end_index=end_index),
        features={"mean_word_probability": 1.0, "dead_air_frac": 0.0},
        archetype_scores={archetype: score},
        sub_scores={"final_score": score},
        gate_passed=gate,
        reject_reason=None if gate else "dead_air",
    )
