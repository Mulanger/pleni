import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  adjacentClipIndex,
  viewportSurface
} from "../src/desktop/layout-policy.ts";

test("viewport policy keeps mobile, tablet gate and desktop mutually exclusive", () => {
  assert.equal(viewportSurface(360), "mobile");
  assert.equal(viewportSurface(699), "mobile");
  assert.equal(viewportSurface(700), "tablet-gate");
  assert.equal(viewportSurface(1099), "tablet-gate");
  assert.equal(viewportSurface(1100), "desktop");
  assert.equal(viewportSurface(1920), "desktop");
});

test("desktop navigation moves one clip and clamps at both boundaries", () => {
  assert.equal(adjacentClipIndex(3, 10, 1), 4);
  assert.equal(adjacentClipIndex(3, 10, -1), 2);
  assert.equal(adjacentClipIndex(0, 10, -1), 0);
  assert.equal(adjacentClipIndex(9, 10, 1), 9);
  assert.equal(adjacentClipIndex(0, 0, 1), 0);
});

test("desktop reuses the bounded FeedScreen instead of mounting a second player", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(app, /presentation="desktop"/);
  assert.match(app, /key="desktop"/);
  assert.match(app, /key="mobile"/);
  assert.match(app, /viewport === "desktop"/);
  assert.match(app, /viewport === "mobile"/);
  assert.match(app, /planMediaWindow\(/);
  assert.match(app, /comment-sheet--\$\{presentation\}/);
  assert.match(styles, /aspect-ratio:\s*9\s*\/\s*16/);
  assert.match(styles, /@media \(min-width: 1100px\)/);
  assert.doesNotMatch(app, /url_540x960.*b-cdn\.net/);
});
