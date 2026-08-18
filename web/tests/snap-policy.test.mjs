import assert from "node:assert/strict";
import test from "node:test";

import {
  FEED_SNAP_DURATION_MS,
  decideSnapTarget,
  dragScrollTop,
  isVerticalSwipeIntent,
  snapDuration,
  snapEaseOut,
  snapScrollTop
} from "../src/feed/snap-policy.ts";

test("vertical intent waits for slop and rejects horizontal gestures", () => {
  assert.equal(isVerticalSwipeIntent(0, 7.9), false);
  assert.equal(isVerticalSwipeIntent(8, 9), false);
  assert.equal(isVerticalSwipeIntent(4, 8), true);
  assert.equal(isVerticalSwipeIntent(-3, -20), true);
});

test("a short slow drag returns to the current clip", () => {
  assert.equal(
    decideSnapTarget({
      currentIndex: 4,
      itemCount: 10,
      itemHeight: 844,
      dragDeltaY: -60,
      velocityY: -0.2
    }),
    4
  );
});

test("distance and release velocity each commit one adjacent clip", () => {
  assert.equal(
    decideSnapTarget({
      currentIndex: 4,
      itemCount: 10,
      itemHeight: 844,
      dragDeltaY: -68,
      velocityY: 0
    }),
    5
  );
  assert.equal(
    decideSnapTarget({
      currentIndex: 4,
      itemCount: 10,
      itemHeight: 844,
      dragDeltaY: 20,
      velocityY: 0.36
    }),
    3
  );
});

test("a qualifying release flick decides direction when distance is short", () => {
  assert.equal(
    decideSnapTarget({
      currentIndex: 4,
      itemCount: 10,
      itemHeight: 844,
      dragDeltaY: 20,
      velocityY: -0.36
    }),
    5
  );
});

test("hard gestures remain one clip and stop at feed boundaries", () => {
  assert.equal(
    decideSnapTarget({
      currentIndex: 4,
      itemCount: 10,
      itemHeight: 844,
      dragDeltaY: -3000,
      velocityY: -4
    }),
    5
  );
  assert.equal(
    decideSnapTarget({
      currentIndex: 0,
      itemCount: 10,
      itemHeight: 844,
      dragDeltaY: 900,
      velocityY: 2
    }),
    0
  );
  assert.equal(
    decideSnapTarget({
      currentIndex: 9,
      itemCount: 10,
      itemHeight: 844,
      dragDeltaY: -900,
      velocityY: -2
    }),
    9
  );
});

test("finger tracking is clamped to the immediate neighbors", () => {
  assert.equal(
    dragScrollTop({
      currentIndex: 4,
      itemCount: 10,
      itemHeight: 844,
      dragDeltaY: -3000
    }),
    5 * 844
  );
  assert.equal(
    dragScrollTop({
      currentIndex: 4,
      itemCount: 10,
      itemHeight: 844,
      dragDeltaY: 3000
    }),
    3 * 844
  );
});

test("cancellation realigns the current item exactly", () => {
  assert.equal(snapScrollTop(4, 10, 844), 3376);
  assert.equal(snapScrollTop(-1, 10, 844), 0);
  assert.equal(snapScrollTop(50, 10, 844), 7596);
});

test("settlement is 140 ms, eased, and instant for reduced motion", () => {
  assert.equal(snapDuration(false), FEED_SNAP_DURATION_MS);
  assert.equal(snapDuration(true), 0);
  assert.equal(snapEaseOut(0), 0);
  assert.equal(snapEaseOut(1), 1);
  assert.ok(snapEaseOut(0.5) > 0.5);
});
