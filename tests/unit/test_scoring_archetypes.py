"""Tests for C7 archetype scoring."""

from __future__ import annotations

from src.contracts import AudioFeatures, Candidate, Sentence, SentenceSpan, Speech, Transcript, Word
from src.scoring.archetypes import score_candidates_for_speech, zscore_feature_maps


def test_zscore_feature_maps_handles_degenerate_single_candidate() -> None:
    assert zscore_feature_maps(({"energy_p90": 0.5, "number_density": 0.2},)) == [
        {"energy_p90": 0.0, "number_density": 0.0}
    ]


def test_score_candidates_for_speech_populates_scores_and_preserves_rejections() -> None:
    speech = _speech()
    transcript = _transcript()
    audio_features = _audio_features(speech.speech_id)
    candidates = (
        _candidate(speech.speech_id, 0, 1, gate_passed=True),
        _candidate(speech.speech_id, 1, 2, gate_passed=False, reject_reason="dead_air"),
    )

    scored = score_candidates_for_speech(
        candidates,
        speech=speech,
        transcript=transcript,
        audio_features=audio_features,
        all_speeches=(speech,),
        confront_weights={"second_person_density": 1.0},
        explain_weights={"number_density": 1.0},
        quotable_weights={"superlative_count": 1.0},
    )

    assert set(scored[0].archetype_scores) == {"CONFRONT", "EXPLAIN", "QUOTABLE"}
    assert "final_score" in scored[0].sub_scores
    assert "z.second_person_density" in scored[0].sub_scores
    assert scored[0].gate_passed
    assert not scored[1].gate_passed
    assert scored[1].reject_reason == "dead_air"
    assert "final_score" in scored[1].sub_scores


def _speech() -> Speech:
    return Speech(
        speech_id="speech-1",
        dokid="dok",
        speaker_name="Test Talare",
        party="S",
        anforandetyp="Anförande",
        start_s=0.0,
        end_s=90.0,
        official_text=None,
        alignment_confidence=1.0,
        needs_review=False,
    )


def _transcript() -> Transcript:
    sentence_texts = (
        "Ni måste svara på frågan.",
        "Vi har 100 miljarder skäl.",
        "Det är den största reformen.",
    )
    words: list[Word] = []
    sentences: list[Sentence] = []
    current_time = 0.0
    for sentence_index, text in enumerate(sentence_texts):
        start_index = len(words)
        for token in text.split():
            words.append(
                Word(text=token, start_s=current_time, end_s=current_time + 10.0, probability=0.9)
            )
            current_time += 10.0
        end_index = len(words) - 1
        sentences.append(
            Sentence(
                index=sentence_index,
                start_s=words[start_index].start_s,
                end_s=words[end_index].end_s,
                text=text,
                word_indices=tuple(range(start_index, end_index + 1)),
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
    speech_id: str,
    start_index: int,
    end_index: int,
    *,
    gate_passed: bool,
    reject_reason: str | None = None,
) -> Candidate:
    start_s = float(start_index * 30.0)
    end_s = float((end_index + 1) * 30.0)
    return Candidate(
        speech_id=speech_id,
        start_s=start_s,
        end_s=end_s,
        sentence_span=SentenceSpan(start_index=start_index, end_index=end_index),
        features={"mean_word_probability": 0.9, "dead_air_frac": 0.0},
        archetype_scores={},
        sub_scores={},
        gate_passed=gate_passed,
        reject_reason=reject_reason,
    )


def _audio_features(speech_id: str) -> AudioFeatures:
    return AudioFeatures(
        speech_id=speech_id,
        frame_hz=1.0,
        rms=(0.1,) * 90,
        f0=(120.0,) * 90,
        speech_rate_wps=(2.0,) * 90,
        pauses=(),
        emphasis_events=(),
    )
