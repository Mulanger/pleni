"""Integration tests for C6 candidate generation and C7 selection."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from src.contracts import (
    AudioFeatures,
    Candidate,
    Scene,
    SelectedClip,
    Sentence,
    Source,
    Speech,
    Transcript,
    Word,
)
from src.errors import ExternalServiceError
from src.paths import WorkPaths, work_paths
from src.scoring.text_features import title_from_candidate_text
from src.scoring.titles import GeneratedTitle
from src.stages.candidates import generate_candidates_dokid
from src.stages.select import select_dokid


def test_candidate_stage_writes_passing_and_rejected_candidates(tmp_path: Path) -> None:
    dokid = "rankfixture"
    paths = _write_stage_inputs(tmp_path, dokid)

    artifacts = generate_candidates_dokid(dokid, work_dir=tmp_path)

    assert artifacts == [paths.candidates_json(f"{dokid}_anf1")]
    candidates = _read_candidates(artifacts[0])
    assert candidates
    assert any(candidate.gate_passed for candidate in candidates)
    assert any(not candidate.gate_passed for candidate in candidates)
    assert {candidate.reject_reason for candidate in candidates if not candidate.gate_passed} >= {
        "procedural_boilerplate",
        "dangling_opener",
    }
    for candidate in candidates:
        assert candidate.start_s in {sentence.start_s for sentence in _transcript(dokid).sentences}
        assert candidate.end_s in {sentence.end_s for sentence in _transcript(dokid).sentences}
        assert "dead_air_frac" in candidate.features


def test_select_stage_scores_candidates_and_writes_selected(tmp_path: Path) -> None:
    dokid = "rankfixture"
    paths = _write_stage_inputs(tmp_path, dokid)
    generate_candidates_dokid(dokid, work_dir=tmp_path)

    artifacts = select_dokid(dokid, work_dir=tmp_path)

    assert artifacts == [paths.selected_json(f"{dokid}_anf1")]
    selected = [
        SelectedClip.model_validate(item)
        for item in json.loads(artifacts[0].read_text(encoding="utf-8"))
    ]
    assert 1 <= len(selected) <= 2
    assert all(clip.clip_id.startswith(f"{dokid}_anf1_c") for clip in selected)
    scored_candidates = _read_candidates(paths.candidates_json(f"{dokid}_anf1"))
    assert all("final_score" in candidate.sub_scores for candidate in scored_candidates)
    assert all(candidate.archetype_scores for candidate in scored_candidates)
    assert any(candidate.gate_passed for candidate in scored_candidates)


def test_select_stage_can_replace_fallback_titles(tmp_path: Path) -> None:
    dokid = "rankfixture"
    _write_stage_inputs(tmp_path, dokid)
    generate_candidates_dokid(dokid, work_dir=tmp_path)

    artifacts = select_dokid(
        dokid,
        work_dir=tmp_path,
        title_generator=_FixedTitleGenerator(),
    )

    selected = [
        SelectedClip.model_validate(item)
        for item in json.loads(artifacts[0].read_text(encoding="utf-8"))
    ]
    assert selected
    assert all(clip.title == "Andersson: Regeringen måste svara på frågan" for clip in selected)


def test_select_stage_keeps_fallback_title_when_generator_fails(tmp_path: Path) -> None:
    dokid = "rankfixture"
    _write_stage_inputs(tmp_path, dokid)
    generate_candidates_dokid(dokid, work_dir=tmp_path)

    artifacts = select_dokid(
        dokid,
        work_dir=tmp_path,
        title_generator=_FailingTitleGenerator(),
    )

    selected = [
        SelectedClip.model_validate(item)
        for item in json.loads(artifacts[0].read_text(encoding="utf-8"))
    ]
    assert selected
    assert all(clip.title == title_from_candidate_text(clip.transcript) for clip in selected)


def _write_stage_inputs(root: Path, dokid: str) -> WorkPaths:
    paths = work_paths(dokid, root=root)
    paths.ensure_directories()
    speech = _speech(dokid)
    transcript = _transcript(dokid)
    audio_features = _audio_features(speech.speech_id)
    paths.source_json.write_text(
        json.dumps(
            {
                "source": Source(
                    dokid=dokid,
                    title="Testdebatt",
                    debate_type="test",
                    debate_date=date(2026, 1, 1),
                    source_url="https://example.invalid/test",
                    duration_s=120.0,
                ).model_dump(mode="json")
            },
            ensure_ascii=False,
            default=str,
        ),
        encoding="utf-8",
    )
    paths.scenes_json.write_text(
        json.dumps(
            [
                Scene(index=0, start_s=0.0, end_s=30.0).model_dump(mode="json"),
                Scene(index=1, start_s=30.1, end_s=120.0).model_dump(mode="json"),
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    paths.speeches_json.write_text(
        json.dumps([speech.model_dump(mode="json")], ensure_ascii=False),
        encoding="utf-8",
    )
    paths.transcript_json(speech.speech_id).write_text(
        transcript.model_dump_json(),
        encoding="utf-8",
    )
    paths.audio_features_json(speech.speech_id).write_text(
        audio_features.model_dump_json(),
        encoding="utf-8",
    )
    return paths


def _speech(dokid: str) -> Speech:
    return Speech(
        speech_id=f"{dokid}_anf1",
        dokid=dokid,
        speaker_name="Anna Andersson",
        party="S",
        anforandetyp="Replik",
        start_s=0.0,
        end_s=120.0,
        official_text=None,
        alignment_confidence=1.0,
        needs_review=False,
    )


def _transcript(dokid: str) -> Transcript:
    sentence_texts = (
        "Herr talman.",
        "Men regeringen måste svara på frågan.",
        "Skolan behöver tydliga besked.",
        "Ni säger att 100 miljarder räcker?",
        "Därför krävs en bättre plan.",
        "Barnen får vänta för länge.",
        "Vi behöver ansvar.",
        "Vi behöver trygghet.",
        "Detta är helt avgörande.",
        "Sverige kan bättre.",
        "Reformen måste genomföras.",
        "Det betyder att familjer får stöd.",
    )
    words: list[Word] = []
    sentences: list[Sentence] = []
    for sentence_index, text in enumerate(sentence_texts):
        start_index = len(words)
        start_s = sentence_index * 10.0
        tokens = text.split()
        for word_index, token in enumerate(tokens):
            words.append(
                Word(
                    text=token,
                    start_s=start_s + word_index,
                    end_s=start_s + word_index + 0.5,
                    probability=0.95,
                )
            )
        end_index = len(words) - 1
        sentences.append(
            Sentence(
                index=sentence_index,
                start_s=start_s,
                end_s=start_s + 10.0,
                text=text,
                word_indices=tuple(range(start_index, end_index + 1)),
            )
        )
    return Transcript(
        speech_id=f"{dokid}_anf1",
        words=tuple(words),
        sentences=tuple(sentences),
        model="test",
        language="sv",
    )


def _audio_features(speech_id: str) -> AudioFeatures:
    frame_count = 120 * 50
    rms = tuple(0.1 + (index % 50) / 500.0 for index in range(frame_count))
    return AudioFeatures(
        speech_id=speech_id,
        frame_hz=50.0,
        rms=rms,
        f0=tuple(120.0 + (index % 20) for index in range(frame_count)),
        speech_rate_wps=tuple(2.0 + (index % 10) / 10.0 for index in range(frame_count)),
        pauses=(),
        emphasis_events=(),
    )


def _read_candidates(path: Path) -> list[Candidate]:
    return [Candidate.model_validate(item) for item in json.loads(path.read_text(encoding="utf-8"))]


class _FixedTitleGenerator:
    def generate(
        self,
        *,
        clip: SelectedClip,
        speech: Speech,
        debate_title: str,
    ) -> GeneratedTitle:
        assert clip.transcript
        assert speech.speaker_name == "Anna Andersson"
        assert debate_title == "Testdebatt"
        return GeneratedTitle(
            title="Andersson: Regeringen måste svara på frågan",
            supporting_span="Men regeringen måste svara på frågan.",
            attempts=1,
        )


class _FailingTitleGenerator:
    def generate(
        self,
        *,
        clip: SelectedClip,
        speech: Speech,
        debate_title: str,
    ) -> GeneratedTitle:
        raise ExternalServiceError("test title failure")
