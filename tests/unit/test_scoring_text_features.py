"""Tests for C7 deterministic text features."""

from __future__ import annotations

from src.contracts import Candidate, Sentence, SentenceSpan, Speech, Transcript, Word
from src.scoring.text_features import compute_text_features, title_from_candidate_text


def test_compute_text_features_detects_swedish_signals() -> None:
    speech = _speech("speaker-1", "Anna Andersson")
    opponent = _speech("speaker-2", "Ulf Kristersson")
    transcript = _transcript(
        (
            "Ni säger att 100 miljarder kronor räcker, men Ulf Kristersson har fel.",
            "Därför behöver Sverige en bättre plan?",
            "Vi behöver trygghet. Vi behöver ansvar.",
            "(Applåder)",
        )
    )
    candidate = _candidate(0, 3, transcript)

    features = compute_text_features(candidate, speech, transcript, (speech, opponent))

    assert features["second_person_density"] > 0.0
    assert features["number_density"] > 0.0
    assert features["names_opponent"] == 1.0
    assert features["question_count"] == 1.0
    assert features["has_claim_and_reason"] == 1.0
    assert features["anaphora_score"] > 0.0
    assert features["applause_after"] == 1.0


def test_title_from_candidate_text_truncates_on_word_boundary() -> None:
    title = title_from_candidate_text(
        "Detta är en mycket lång mening som behöver kortas för att passa i titelfältet.",
        max_chars=30,
    )

    assert title == "Detta är en mycket lång"
    assert len(title) <= 30


def _speech(speech_id: str, speaker_name: str) -> Speech:
    return Speech(
        speech_id=speech_id,
        dokid="dok",
        speaker_name=speaker_name,
        party="S",
        anforandetyp="Replik",
        start_s=0.0,
        end_s=80.0,
        official_text=None,
        alignment_confidence=1.0,
        needs_review=False,
    )


def _transcript(sentence_texts: tuple[str, ...]) -> Transcript:
    words: list[Word] = []
    sentences: list[Sentence] = []
    current_time = 0.0
    for sentence_index, text in enumerate(sentence_texts):
        sentence_words = text.split()
        start_index = len(words)
        for token in sentence_words:
            words.append(
                Word(
                    text=token,
                    start_s=current_time,
                    end_s=current_time + 1.0,
                    probability=1.0,
                )
            )
            current_time += 1.0
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
        speech_id="speaker-1",
        words=tuple(words),
        sentences=tuple(sentences),
        model="test",
        language="sv",
    )


def _candidate(start_index: int, end_index: int, transcript: Transcript) -> Candidate:
    return Candidate(
        speech_id=transcript.speech_id,
        start_s=transcript.sentences[start_index].start_s,
        end_s=transcript.sentences[end_index].end_s,
        sentence_span=SentenceSpan(start_index=start_index, end_index=end_index),
        features={"mean_word_probability": 1.0, "dead_air_frac": 0.0},
        archetype_scores={},
        sub_scores={},
        gate_passed=True,
    )
