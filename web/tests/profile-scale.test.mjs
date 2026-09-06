import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const supabase = readFileSync(new URL("../src/supabase.ts", import.meta.url), "utf8");

test("non-feed routes do not fetch the background For You catalogue", () => {
  assert.match(app, /const mainFeedRequested = route\.view === "tab" && route\.tab === "hem"/);
  assert.match(app, /if \(!mainFeedRequested\)\s*\{[\s\S]{0,260}setLoading\(false\);[\s\S]{0,40}return;/);
  assert.match(app, /completedMainFeedRequestRef = useRef<string \| null>\(null\)/);
  assert.match(app, /completedMainFeedRequestRef\.current === requestKey/);
  assert.match(app, /mainFeedRequested,/);
});

test("profile and party navigation aborts obsolete public reads", () => {
  assert.match(app, /loadPolitician\(selectedPersonId, controller\.signal\)/);
  assert.match(app, /loadClipsForPolitician\([\s\S]{0,160}controller\.signal\)/);
  assert.match(app, /loadPartyProfile\(selectedPartyCode, controller\.signal\)/);
  assert.match(app, /loadClipsForParty\([\s\S]{0,180}controller\.signal\)/);
  assert.match(app, /loadPoliticiansForParty\(selectedPartyCode, 200, controller\.signal\)/);
  assert.ok((app.match(/controller\.abort\(\)/g) ?? []).length >= 5);

  assert.match(supabase, /loadPolitician\([\s\S]{0,100}signal\?: AbortSignal/);
  assert.match(supabase, /loadPartyProfile\([\s\S]{0,100}signal\?: AbortSignal/);
  assert.match(supabase, /readProfileClips\([\s\S]{0,100}signal\?: AbortSignal/);
  assert.match(supabase, /feed_clip_catalogue\?\$\{query\.toString\(\)\}`.*, \{ signal \}/);
});

test("profile reads use a bounded explicit catalogue projection", () => {
  const selectStart = supabase.indexOf("const PROFILE_CLIP_SELECT");
  const selectEnd = supabase.indexOf("].join(\",\");", selectStart);
  const selectSource = supabase.slice(selectStart, selectEnd);
  const profileReads = supabase.slice(
    supabase.indexOf("export async function loadClipsForPolitician"),
    supabase.indexOf("export async function loadClipsByIds")
  );

  assert.match(selectSource, /"transcript"/);
  assert.match(selectSource, /"url_540x960"/);
  assert.doesNotMatch(selectSource, /"speech_start_s"|"clip_start_s"|"topic"|"archetype"/);
  assert.equal((profileReads.match(/select: PROFILE_CLIP_SELECT/g) ?? []).length, 2);
  assert.doesNotMatch(profileReads, /select: "\*"/);
});
