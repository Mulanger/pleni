# Dependencies

- `pydantic==2.11.7` - shared inter-stage data contracts and validation.
- `pydantic-settings==2.10.1` - environment-driven settings in `src/config.py`.
- `imageio-ffmpeg==0.6.0` - runtime ffmpeg binary fallback for acquisition, remux, and fixture media extraction when system ffmpeg is absent.
- `scenedetect==0.6.6` - PySceneDetect content detector for C2 camera-cut segmentation.
- `structlog==25.4.0` - JSON structured logging with bound stage context.
- `faster-whisper==1.2.1` - CTranslate2 Whisper runtime for the C4 KBLab Swedish ASR backend.
- `whisperx==3.8.6` - optional C4 forced-alignment backend for word-level timing refinement.
- `praat-parselmouth==0.4.7` - C5 Praat pitch extraction for per-frame F0 delivery features.
- `opencv-python==4.11.0.86` - C8 frame-image face detection/tracking primitives and C2 scene-frame image loading.
- `setuptools==80.9.0` - PEP 517 build backend for the local package.
- `pytest==8.4.1` - test harness and golden-file helper tests.
- `ruff==0.12.7` - formatter and linter.
- `mypy==1.17.1` - strict static typing for `src/`.
