import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("comments are disabled at both user-facing render points", () => {
  assert.match(appSource, /const COMMENTS_ENABLED = false;/);
  assert.match(
    appSource,
    /\{COMMENTS_ENABLED && \(\s*<ActionButton label="Kommentarer" hideLabel onClick=\{onComments\}>/
  );
  assert.match(
    appSource,
    /\{COMMENTS_ENABLED && commentClip && <CommentSheet clip=\{commentClip\} onClose=\{closeComments\} \/>\}/
  );
});

test("the dormant comment implementation remains available for repair", () => {
  assert.match(appSource, /from "\.\/comments";/);
  assert.match(appSource, /function CommentSheet\(/);
  assert.match(appSource, /const openComments = \(clip: ClipItem\) =>/);
});
