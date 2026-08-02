"""Tests for C6 hard filters."""

from __future__ import annotations

import pytest

from src.candidates.filters import (
    CandidateFilterContext,
    candidate_filter_features,
    passes_asr_confidence,
    passes_cut_collision,
    passes_dangling_opener,
    passes_dead_air,
    passes_external_reference,
    passes_orphan_demonstrative,
    passes_procedural_boilerplate,
    passes_unbound_pronoun,
)
from src.candidates.windows import CandidateWindow
from src.contracts import (
    AudioFeatures,
    Scene,
    Sentence,
    SentenceSpan,
    Speech,
    TimeSpan,
    Transcript,
    Word,
)


def test_dangling_opener_filter() -> None:
    assert passes_dangling_opener(_context("Men detta löser inte problemet.")) == (
        False,
        "dangling_opener",
    )
    assert passes_dangling_opener(_context("Skolan behöver tydliga besked.")) == (True, None)


def test_procedural_boilerplate_filter() -> None:
    assert passes_procedural_boilerplate(_context("Herr talman, jag yrkar bifall.")) == (
        False,
        "procedural_boilerplate",
    )
    assert passes_procedural_boilerplate(_context("Regeringen saknar en plan.")) == (True, None)


def test_dead_air_filter() -> None:
    assert passes_dead_air(
        _context("Regeringen saknar en plan.", pauses=(TimeSpan(start_s=10.0, end_s=25.0),))
    ) == (
        False,
        "dead_air",
    )
    assert passes_dead_air(
        _context("Regeringen saknar en plan.", pauses=(TimeSpan(start_s=10.0, end_s=12.0),))
    ) == (
        True,
        None,
    )


def test_cut_collision_filter() -> None:
    assert passes_cut_collision(
        _context("Regeringen saknar en plan.", scenes=(Scene(index=1, start_s=0.2, end_s=50.0),))
    ) == (
        False,
        "cut_collision",
    )
    assert passes_cut_collision(
        _context("Regeringen saknar en plan.", scenes=(Scene(index=1, start_s=3.0, end_s=50.0),))
    ) == (
        True,
        None,
    )


def test_asr_confidence_filter() -> None:
    assert passes_asr_confidence(_context("Regeringen saknar en plan.", probability=0.1)) == (
        False,
        "low_asr_confidence",
    )
    assert passes_asr_confidence(_context("Regeringen saknar en plan.", probability=0.9)) == (
        True,
        None,
    )


def test_orphan_demonstrative_filter() -> None:
    assert passes_orphan_demonstrative(_context("Detta är helt avgörande.")) == (
        False,
        "orphan_demonstrative",
    )
    assert passes_orphan_demonstrative(_context("Detta förslag stärker skolan.")) == (True, None)


def test_unbound_pronoun_filter() -> None:
    assert passes_unbound_pronoun(_context("Han har fel i sak.")) == (False, "unbound_pronoun")
    assert passes_unbound_pronoun(_context("Ulf Kristersson har fel när han säger detta.")) == (
        True,
        None,
    )


def test_external_reference_filter() -> None:
    assert passes_external_reference(_context("Som jag sa tidigare är detta fel.")) == (
        False,
        "external_reference",
    )
    assert passes_external_reference(_context("I ljuset av detta behöver regeringen agera.")) == (
        False,
        "external_reference",
    )
    assert passes_external_reference(_context("Enligt förslaget om skolan behövs pengar.")) == (
        True,
        None,
    )


def test_candidate_filter_features_are_absolute() -> None:
    features = candidate_filter_features(
        _context(
            "Regeringen saknar en plan.",
            pauses=(TimeSpan(start_s=10.0, end_s=15.0),),
            scenes=(Scene(index=1, start_s=2.0, end_s=50.0),),
            probability=0.8,
        )
    )

    assert features["duration_s"] == 50.0
    assert features["dead_air_frac"] == pytest.approx(0.1)
    assert features["nearest_cut_distance_s"] == 2.0
    assert features["mean_word_probability"] == 0.8


def _context(
    first_sentence: str,
    *,
    pauses: tuple[TimeSpan, ...] = (),
    scenes: tuple[Scene, ...] = (),
    probability: float = 1.0,
) -> CandidateFilterContext:
    tokens = first_sentence.split()
    words = tuple(
        Word(
            text=token,
            start_s=index * 1.0,
            end_s=index * 1.0 + 0.5,
            probability=probability,
        )
        for index, token in enumerate(tokens)
    )
    sentence = Sentence(
        index=0,
        start_s=0.0,
        end_s=50.0,
        text=first_sentence,
        word_indices=tuple(range(len(words))),
    )
    return CandidateFilterContext(
        speech=Speech(
            speech_id="speech-1",
            dokid="dok",
            speaker_name="Test Talare",
            party="S",
            anforandetyp="Anförande",
            start_s=0.0,
            end_s=50.0,
            official_text=first_sentence,
            alignment_confidence=1.0,
            needs_review=False,
        ),
        transcript=Transcript(
            speech_id="speech-1",
            words=words,
            sentences=(sentence,),
            model="test",
            language="sv",
        ),
        audio_features=AudioFeatures(
            speech_id="speech-1",
            frame_hz=50.0,
            rms=(0.1,) * 2500,
            f0=(120.0,) * 2500,
            speech_rate_wps=(2.0,) * 2500,
            pauses=pauses,
            emphasis_events=(),
        ),
        scenes=scenes,
        window=CandidateWindow(
            sentence_span=SentenceSpan(start_index=0, end_index=0),
            start_s=0.0,
            end_s=50.0,
        ),
    )
