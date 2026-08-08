# Vendored vision models

Model weights are committed rather than downloaded. An unattended production run
must never fetch a model: a silently different file changes what the pipeline
believes it saw, and that is the failure class ADR 010 exists to prevent. Every
file here is pinned by SHA-256 and the checksum is asserted at detector
construction, so a corrupt or swapped file fails loudly at startup.

## `face_detection_yunet_2023mar.onnx`

| | |
|---|---|
| Purpose | C8 face detection (`YuNetFaceDetector`) |
| Source | [opencv/opencv_zoo](https://github.com/opencv/opencv_zoo) — `models/face_detection_yunet/` |
| Retrieved | 2026-08-07 |
| Size | 232,589 bytes |
| SHA-256 | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| Licence | MIT |
| Runtime | `cv2.FaceDetectorYN`, built into the pinned `opencv-python==4.11.0.86` |

Adds **no Python dependency** — OpenCV runs the ONNX itself.

Output rows are `[x, y, w, h, 10 landmark coordinates, score]`. The score is a
real detector confidence: on Riksdagen podium footage a speaker's face lands at
0.89–0.95 and background faces at 0.75–0.92. The Haar cascade it replaced
returned no confidence at all, so `detect.py` synthesised one from box area and
distance from frame centre — which promoted exactly the large central false
positives it was meant to suppress. See `docs/CLIPPING_V2_DESIGN.md` §6.

Boxes may extend past the frame edge for a face at the border; `FaceSample.x/y`
are `NonNegativeFloat`, so detections are clamped to the frame and degenerate
boxes dropped.

**Oversized images must be downscaled before detection.** A Riksdagen portrait is
~1800×2400 with the face filling half the frame, which sits outside YuNet's
anchor range: it returns *nothing at all*. At an 800 px long side the same face
detects at 0.94–0.96. Analysis frames are 480×270 and need no resizing.

## `face_recognition_sface_2021dec.onnx`

| | |
|---|---|
| Purpose | C8 speaker identity verification (`FaceEmbedder`) |
| Source | [opencv/opencv_zoo](https://github.com/opencv/opencv_zoo) — `models/face_recognition_sface/` |
| Retrieved | 2026-08-07 |
| Size | 38,696,353 bytes |
| SHA-256 | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |
| Licence | Apache 2.0 |
| Runtime | `cv2.FaceRecognizerSF`, built into the pinned `opencv-python==4.11.0.86` |

Also adds **no Python dependency**. Faces are aligned with `alignCrop` using
YuNet's five landmarks before the feature is taken, so the two models are used
as the pair they were published as.

OpenCV documents a cosine threshold of **0.363 on LFW**. That is a smoke-test
reference and **must not** be used as the production gate — on Pleni footage a
verified correct match landed at 0.366 while beating the runner-up by +0.299.
Acceptance is calibrated in `src/vision/identity.py::IdentityThresholds` and
leans on the margin. See ADR 012.
