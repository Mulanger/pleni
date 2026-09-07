import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const progressStart = app.indexOf("function ProgressRow(");
const progressEnd = app.indexOf("function FollowingScreen(", progressStart);
const progress = app.slice(progressStart, progressEnd);

test("progress scrubbing follows the captured primary pointer", () => {
  assert.match(progress, /activePointerId\.current = event\.pointerId/);
  assert.match(progress, /setPointerCapture\(event\.pointerId\)/);
  assert.match(progress, /activePointerId\.current === event\.pointerId/);
  assert.match(progress, /onPointerCancel=\{finishScrubbing\}/);
  assert.match(progress, /onLostPointerCapture=/);
  assert.doesNotMatch(progress, /event\.buttons === 1/);
});

test("the quiet rail has a comfortable mobile touch target and active feedback", () => {
  assert.match(styles, /\.progress-track\s*\{\s*height:\s*44px;\s*margin-block:\s*-13px;/);
  assert.match(styles, /\.progress-track\.is-scrubbing::before[\s\S]*height:\s*6px;/);
  assert.match(progress, /className="progress-thumb"/);
  assert.match(progress, /className="progress-scrub-time"/);
  assert.match(progress, /scrubTime !== null \? " is-scrubbing"/);
});

test("the custom slider supports assistive text and keyboard seeking", () => {
  assert.match(progress, /role="slider"/);
  assert.match(progress, /tabIndex=\{0\}/);
  assert.match(progress, /aria-valuetext=/);
  assert.match(progress, /event\.key === "ArrowLeft"/);
  assert.match(progress, /event\.key === "ArrowRight"/);
  assert.match(progress, /event\.key === "Home"/);
  assert.match(progress, /event\.key === "End"/);
});
