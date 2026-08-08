# Dependencies

- `pydantic==2.11.7` - shared inter-stage data contracts and validation.
- `pydantic-settings==2.10.1` - environment-driven settings in `src/config.py`.
- `imageio-ffmpeg==0.6.0` - runtime ffmpeg binary fallback for acquisition, remux, and fixture media extraction when system ffmpeg is absent.
- `scenedetect==0.6.6` - PySceneDetect content detector for C2 camera-cut segmentation.
- `structlog==25.4.0` - JSON structured logging with bound stage context.
- `faster-whisper==1.2.1` - CTranslate2 Whisper runtime for the C4 KBLab Swedish ASR backend.
- `whisperx==3.8.6` - optional C4 forced-alignment backend for word-level timing refinement.
- `praat-parselmouth==0.4.7` - C5 Praat pitch extraction for per-frame F0 delivery features.
- `opencv-python==4.11.0.86` - C8 frame-image face detection/tracking primitives and C2 scene-frame image loading. Also runs the vendored YuNet ONNX through `cv2.FaceDetectorYN`, so the C8 detector upgrade added **no** Python dependency.

## Vendored model weights

Not Python packages, but pinned and justified on the same terms. Full provenance,
licences and checksums are in `src/vision/models/MODELS.md`; they are committed
rather than downloaded so that no unattended run can silently acquire a different
model.

- `face_detection_yunet_2023mar.onnx` (232 KB, MIT, OpenCV Zoo) - the C8 face detector. Replaced `haarcascade_frontalface_default`, which reported no confidence and so forced `detect.py` to synthesise one from box area and centrality; that selected a non-face as the speaker in 24.9% of published clips. See `docs/CLIPPING_V2_DESIGN.md` §6.
- `setuptools==80.9.0` - PEP 517 build backend for the local package.
- `pytest==8.4.1` - test harness and golden-file helper tests.
- `ruff==0.12.7` - formatter and linter.
- `mypy==1.17.1` - strict static typing for `src/`.
- `Ollama==0.32.5` - optional local structured-output runtime for C7 clip titles; the tested model is `qwen3:8b`. It is external to the Python environment and C7 retains a deterministic fallback when unavailable.

## Frontend (`web/package.json`)

- `@clerk/react==6.12.10` - sole identity provider for the mobile app; supplies `<ClerkProvider>`, the prebuilt sign-in/sign-up modals and the session token used for Supabase third-party auth. Chosen over Supabase Auth per the locked decision in `docs/RECOMMENDATION_PREREQUISITES.md` §0.
- `@clerk/localizations==4.13.10` - Swedish (`svSE`) strings for the Clerk components. The app is Swedish-only, so the default English UI is not acceptable; this is Clerk's own localization package rather than a hand-maintained string table.
