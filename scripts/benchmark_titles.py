"""Benchmark a title backend over real selected clips.

    python scripts/benchmark_titles.py --work-dir work/local_test_hd10540 --dokid HD10540

Decides a model choice with evidence rather than opinion. Reports, per backend:

- **acceptance rate** — how often the model produced a title the deterministic
  validator would actually publish. This is the number that matters. A model
  that writes beautiful headlines the fact-checker rejects is worth nothing.
- **attempts per accepted title** — how much correction it needed.
- **real token cost**, from the provider's own usage block, not an estimate.

The baseline to beat is the local `qwen3:8b` run recorded in `PROGRESS.md`:
**4 of 16 accepted**, 94.8 seconds.

Rejected titles are not a failure of the pipeline — C7 keeps its deterministic
first-sentence title when validation fails, which is the correct conservative
behaviour. A low acceptance rate means paying for a model that mostly changes
nothing.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from src.config import get_settings  # noqa: E402
from src.contracts import SelectedClip, Source, Speech  # noqa: E402
from src.errors import ConfigurationError, PipelineError  # noqa: E402
from src.paths import work_paths  # noqa: E402
from src.scoring.titles import (  # noqa: E402
    OpenAICompatibleTitleGenerator,
    title_validation_errors,
)


def main(argv: list[str] | None = None) -> int:
    """Run every selected clip through a title backend and report the result."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dokid", required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--model", default=None, help="Defaults to RIKET_TITLE_MODEL")
    parser.add_argument("--base-url", default=None, help="Defaults to RIKET_TITLE_API_BASE_URL")
    parser.add_argument("--limit", type=int, default=0, help="Only the first N clips")
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument(
        "--concurrency", type=int, default=None,
        help="Parallel requests. Defaults to RIKET_TITLE_CONCURRENCY.",
    )
    args = parser.parse_args(argv)

    settings = get_settings()
    if not settings.title_api_key:
        raise ConfigurationError("Set RIKET_TITLE_API_KEY in .env. See .env.example.")

    model = args.model or settings.title_model
    base_url = args.base_url or settings.title_api_base_url
    paths = work_paths(args.dokid, root=args.work_dir)

    source = Source.model_validate(
        json.loads(paths.source_json.read_text(encoding="utf-8"))["source"]
    )
    speeches = {
        speech.speech_id: speech
        for speech in (
            Speech.model_validate(row)
            for row in json.loads(paths.speeches_json.read_text(encoding="utf-8"))
        )
    }
    clips: list[SelectedClip] = []
    for speech_id in speeches:
        artifact = paths.selected_json(speech_id)
        if artifact.exists():
            clips.extend(
                SelectedClip.model_validate(row)
                for row in json.loads(artifact.read_text(encoding="utf-8"))
            )
    if args.limit:
        clips = clips[: args.limit]
    if not clips:
        raise ConfigurationError(f"No selected clips under {args.work_dir}")

    generator = OpenAICompatibleTitleGenerator(
        base_url=base_url,
        api_key=settings.title_api_key,
        model=model,
        timeout_s=settings.title_timeout_s,
        max_attempts=settings.title_max_attempts,
    )

    print(f"model      {model}")
    print(f"endpoint   {base_url}")
    print(f"clips      {len(clips)}  ({source.title})\n")

    started = time.monotonic()

    def run_one(indexed: tuple[int, SelectedClip]) -> dict[str, object]:
        index, clip = indexed
        speech = speeches[clip.speech_id]
        fallback = clip.title
        clip_started = time.monotonic()
        try:
            generated = generator.generate(
                clip=clip, speech=speech, debate_title=source.title or args.dokid
            )
        except PipelineError as error:
            return {
                "index": index,
                "clip_id": clip.clip_id,
                "accepted": False,
                "reason": str(error).split(": ", 2)[-1][:70],
                "fallback": fallback,
            }
        return {
            "index": index,
            "clip_id": clip.clip_id,
            "accepted": True,
            "title": generated.title,
            "fallback": fallback,
            "attempts": generated.attempts,
            "seconds": round(time.monotonic() - clip_started, 1),
            "evidence": generated.supporting_span[:160],
            # Re-run the validator on the accepted title as a self-check: if this
            # is ever non-empty, the generation loop let something through.
            "revalidation": list(
                title_validation_errors(
                    generated.title,
                    generated.supporting_span,
                    transcript=clip.transcript,
                    speaker_name=speeches[clip.speech_id].speaker_name,
                    archetype=clip.archetype,
                )
            ),
        }

    workers = max(1, min(args.concurrency or settings.title_concurrency, len(clips)))
    print(f"concurrency {workers}\n")
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = sorted(
            pool.map(run_one, enumerate(clips, start=1)),
            key=lambda r: int(r["index"]),  # type: ignore[arg-type]
        )

    for r in results:
        if r["accepted"]:
            print(f'{r["index"]:2}. ACCEPTED  "{r["title"]}"')
            print(f'    was:    {r["fallback"]}')
            print(f'    attempts {r["attempts"]}, {r["seconds"]}s')
        else:
            print(f'{r["index"]:2}. REJECTED  {r["reason"]}')
            print(f'    keeps:  {r["fallback"]}')

    wall = time.monotonic() - started
    accepted = [r for r in results if r["accepted"]]
    usage = generator.usage
    cost = usage.cost_usd(
        input_per_m=settings.title_api_input_per_m,
        output_per_m=settings.title_api_output_per_m,
        cached_per_m=settings.title_api_cached_per_m,
    )

    print("\n" + "=" * 64)
    print(f"accepted        {len(accepted)}/{len(results)}  ({len(accepted) / len(results):.0%})")
    print("baseline        4/16 (28%) — local qwen3:8b, PROGRESS.md")
    if accepted:
        avg = sum(int(r["attempts"]) for r in accepted) / len(accepted)  # type: ignore[arg-type]
        print(f"attempts/accept {avg:.2f}")
    print(f"wall clock      {wall:.1f}s  ({wall / len(results):.1f}s per clip)")
    print(f"requests        {usage.requests}")
    print(
        f"tokens          {usage.prompt_tokens:,} in "
        f"({usage.cached_tokens:,} cached), {usage.completion_tokens:,} out"
        + (f" ({usage.reasoning_tokens:,} reasoning)" if usage.reasoning_tokens else "")
    )
    print(f"cost            ${cost:.5f}  (${cost / len(results):.6f} per clip)")
    print(f"per 1,000 clips ${cost / len(results) * 1000:.2f}")

    leaked = [r for r in accepted if r.get("revalidation")]
    if leaked:
        print(f"\n!! {len(leaked)} accepted titles fail revalidation — the loop has a bug")

    if args.json_out:
        args.json_out.write_text(
            json.dumps(
                {
                    "model": model,
                    "clips": len(results),
                    "accepted": len(accepted),
                    "cost_usd": round(cost, 6),
                    "usage": usage.to_dict(),
                    "results": results,
                },
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        print(f"\nwrote {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
