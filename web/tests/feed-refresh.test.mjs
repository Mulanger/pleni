import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const supabase = readFileSync(new URL("../src/supabase.ts", import.meta.url), "utf8");

test("manual refresh belongs to one feed mode and can replace an automatic load", () => {
  const refreshStart = app.indexOf("const refreshFeed =");
  const refreshEnd = app.indexOf("// A changed follow", refreshStart);
  const refreshSource = app.slice(refreshStart, refreshEnd);
  const loadStart = app.indexOf("useEffect(() => {", refreshEnd);
  const loadEnd = app.indexOf("/**\n   * A public watch URL", loadStart);
  const loadSource = app.slice(loadStart, loadEnd);

  assert.match(app, /manualRefreshModeRef = useRef<FeedMode \| null>\(null\)/);
  assert.doesNotMatch(refreshSource, /if \(loading\) return/);
  assert.match(refreshSource, /manualRefreshModeRef\.current = feedMode/);
  assert.match(loadSource, /const preservingManualRefresh = manualRefreshModeRef\.current === feedMode/);
  assert.match(loadSource, /manualRefreshModeRef\.current !== null && !preservingManualRefresh/);
  assert.match(loadSource, /cache: preservingManualRefresh \? "no-store" : "default"/);
  assert.match(supabase, /cache\?: RequestCache/);
  assert.match(supabase, /cache: options\.cache/);
});

test("feed switches and completed refreshes start on the first clip", () => {
  const screenStart = app.indexOf("function FeedScreen(");
  const screenEnd = app.indexOf("function CollectionScreen(", screenStart);
  const screenSource = app.slice(screenStart, screenEnd);

  assert.match(app, /const mainFeedClips = loadedFeedMode === feedMode \? clips : \[\]/);
  assert.match(app, /clips=\{mainFeedClips\}/);
  assert.match(screenSource, /previousFeedModeRef = useRef\(feedMode\)/);
  assert.match(screenSource, /resetToFirstClipRef\.current = true/);
  assert.match(screenSource, /mainFeedActiveId\.current = null/);
  assert.match(screenSource, /resetToFirstClip\s*\? null/);
  assert.match(screenSource, /resetToFirstClip && clips\.length > 0/);
});
