import assert from "node:assert/strict";
import test from "node:test";

import { newestProfileClipsFirst } from "../src/profile-clip-order.ts";

test("profile grids show the newest debate first without mutating the source", () => {
  const clips = [
    { id: "backfill", debateDate: "2024-01-10", publishedAt: "2026-08-15T12:00:00Z" },
    { id: "newer-upload", debateDate: "2026-08-14", publishedAt: "2026-08-15T10:00:00Z" },
    { id: "newer-debate", debateDate: "2026-08-15", publishedAt: "2026-08-14T10:00:00Z" },
    { id: "older-upload", debateDate: "2026-08-14", publishedAt: "2026-08-14T10:00:00Z" }
  ];

  assert.deepEqual(
    newestProfileClipsFirst(clips).map((clip) => clip.id),
    ["newer-debate", "newer-upload", "older-upload", "backfill"]
  );
  assert.deepEqual(
    clips.map((clip) => clip.id),
    ["backfill", "newer-upload", "newer-debate", "older-upload"]
  );
});
