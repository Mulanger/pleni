import assert from "node:assert/strict";
import test from "node:test";

import {
  allowsSecondLookahead,
  attachMediaSource,
  hasDecodedVideoFrame,
  isFeedAudioMuted,
  planMediaWindow,
  releaseMediaSource
} from "../src/feed/media-policy.ts";

test("a thumbnail yields only after the video has a decoded current frame", () => {
  assert.equal(hasDecodedVideoFrame(0), false);
  assert.equal(hasDecodedVideoFrame(1), false);
  assert.equal(hasDecodedVideoFrame(2), true);
  assert.equal(hasDecodedVideoFrame(3), true);
  assert.equal(hasDecodedVideoFrame(4), true);
});

test("only a viewer-chosen mute follows playback to the next clip", () => {
  assert.equal(isFeedAudioMuted(false, null, "clip-a"), false);
  assert.equal(isFeedAudioMuted(false, "clip-a", "clip-a"), true);
  assert.equal(isFeedAudioMuted(false, "clip-a", "clip-b"), false);
  assert.equal(isFeedAudioMuted(true, null, "clip-b"), true);
  assert.equal(isFeedAudioMuted(true, "clip-a", "clip-b"), true);
});

test("forward scheduling stages the second destination only after the first is playable", () => {
  assert.deepEqual(
    planMediaWindow({
      activeIndex: 5,
      itemCount: 12,
      direction: 1,
      immediatePlayable: false,
      allowSecondLookahead: true
    }).sourceIndices,
    [4, 5, 6]
  );
  assert.deepEqual(
    planMediaWindow({
      activeIndex: 5,
      itemCount: 12,
      direction: 1,
      immediatePlayable: true,
      allowSecondLookahead: true
    }).sourceIndices,
    [4, 5, 6, 7]
  );
});

test("reverse scheduling mirrors the same bounded look-ahead", () => {
  assert.deepEqual(
    planMediaWindow({
      activeIndex: 5,
      itemCount: 12,
      direction: -1,
      immediatePlayable: false,
      allowSecondLookahead: true
    }).sourceIndices,
    [4, 5, 6]
  );
  assert.deepEqual(
    planMediaWindow({
      activeIndex: 5,
      itemCount: 12,
      direction: -1,
      immediatePlayable: true,
      allowSecondLookahead: true
    }).sourceIndices,
    [3, 4, 5, 6]
  );
});

test("window boundaries stay valid, unique and limited to four sources", () => {
  for (let itemCount = 1; itemCount <= 15; itemCount += 1) {
    for (let activeIndex = 0; activeIndex < itemCount; activeIndex += 1) {
      for (const direction of [-1, 1]) {
        for (const immediatePlayable of [false, true]) {
          const plan = planMediaWindow({
            activeIndex,
            itemCount,
            direction,
            immediatePlayable,
            allowSecondLookahead: true
          });
          assert.ok(plan.sourceIndices.length <= 4);
          assert.equal(new Set(plan.sourceIndices).size, plan.sourceIndices.length);
          assert.ok(plan.sourceIndices.includes(activeIndex));
          assert.ok(plan.sourceIndices.every((index) => index >= 0 && index < itemCount));
        }
      }
    }
  }
});

test("only explicit constrained-network signals disable second look-ahead", () => {
  for (const connection of [null, undefined, {}, { effectiveType: "3g" }, { effectiveType: "4g" }, { effectiveType: "5g" }]) {
    assert.equal(allowsSecondLookahead(connection), true);
  }
  assert.equal(allowsSecondLookahead({ saveData: true, effectiveType: "4g" }), false);
  assert.equal(allowsSecondLookahead({ effectiveType: "2G" }), false);
  assert.equal(allowsSecondLookahead({ effectiveType: "slow-2g" }), false);
});

test("attaching a source applies preload before src and explicitly starts selection", () => {
  const media = fakeMedia();
  attachMediaSource(media, "https://cdn.example/one.mp4", "auto");
  assert.deepEqual(media.calls, [
    "set:preload:auto",
    "set:src:https://cdn.example/one.mp4",
    "load"
  ]);

  media.calls.length = 0;
  attachMediaSource(media, "https://cdn.example/one.mp4", "auto");
  assert.deepEqual(media.calls, []);

  attachMediaSource(media, "https://cdn.example/one.mp4", "metadata");
  assert.deepEqual(media.calls, ["set:preload:metadata"]);
});

test("releasing a source aborts work and resets the media element", () => {
  const media = fakeMedia();
  attachMediaSource(media, "https://cdn.example/one.mp4", "auto");
  media.calls.length = 0;

  releaseMediaSource(media);
  assert.deepEqual(media.calls, ["pause", "remove:src", "load"]);
  assert.equal(media.getAttribute("src"), null);

  media.calls.length = 0;
  releaseMediaSource(media);
  assert.deepEqual(media.calls, []);
});

function fakeMedia() {
  const attributes = new Map();
  const media = {
    preload: "metadata",
    calls: [],
    pause() {
      this.calls.push("pause");
    },
    load() {
      this.calls.push("load");
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      this.calls.push(`set:${name}:${value}`);
      attributes.set(name, value);
      if (name === "preload") {
        this.preload = value;
      }
    },
    removeAttribute(name) {
      this.calls.push(`remove:${name}`);
      attributes.delete(name);
    }
  };
  return media;
}
