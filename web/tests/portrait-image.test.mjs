import assert from "node:assert/strict";
import test from "node:test";

import {
  createPortraitDelivery,
  forgetPortraitSuccess,
  isCompletePortraitImage,
  portraitRetryUrl,
  rememberPortraitSuccess,
  retryPortraitDelivery
} from "../src/portrait-image.ts";

test("a successful portrait survives a new component lifecycle", () => {
  const sourceUrl = "https://cdn.example/portraits/person/remount.jpg";
  const initial = createPortraitDelivery(sourceUrl);
  assert.deepEqual(initial, {
    displayUrl: sourceUrl,
    attempt: 0,
    retryToken: 0,
    loaded: false,
    failed: false
  });

  const retry = retryPortraitDelivery(sourceUrl, initial);
  rememberPortraitSuccess(sourceUrl, retry.displayUrl);

  assert.deepEqual(createPortraitDelivery(sourceUrl), {
    displayUrl: "https://cdn.example/portraits/person/remount.jpg?pleni_retry=1",
    attempt: 0,
    retryToken: 1,
    loaded: true,
    failed: false
  });
});

test("an already-complete cached image is recognized without another load event", () => {
  assert.equal(isCompletePortraitImage({ complete: true, naturalWidth: 192 }), true);
  assert.equal(isCompletePortraitImage({ complete: false, naturalWidth: 192 }), false);
  assert.equal(isCompletePortraitImage({ complete: true, naturalWidth: 0 }), false);
});

test("portrait successes are isolated by their canonical source URL", () => {
  const firstUrl = "https://cdn.example/portraits/person/first.jpg";
  const secondUrl = "https://cdn.example/portraits/person/second.jpg";
  rememberPortraitSuccess(firstUrl, portraitRetryUrl(firstUrl, 2));

  assert.equal(createPortraitDelivery(firstUrl).loaded, true);
  assert.equal(createPortraitDelivery(secondUrl).loaded, false);
});

test("a remembered retry gets a fresh bounded retry budget after remount", () => {
  const sourceUrl = "https://cdn.example/portraits/person/fresh-budget.jpg";
  const priorSuccess = portraitRetryUrl(sourceUrl, 2);
  rememberPortraitSuccess(sourceUrl, priorSuccess);

  const remount = createPortraitDelivery(sourceUrl);
  const firstFreshRetry = retryPortraitDelivery(sourceUrl, remount);
  const secondFreshRetry = retryPortraitDelivery(sourceUrl, firstFreshRetry);
  const failed = retryPortraitDelivery(sourceUrl, secondFreshRetry);

  assert.equal(remount.attempt, 0);
  assert.equal(firstFreshRetry.displayUrl, portraitRetryUrl(sourceUrl, 3));
  assert.equal(secondFreshRetry.displayUrl, portraitRetryUrl(sourceUrl, 4));
  assert.equal(failed.failed, true);
});

test("only the exact failed success is removed from session memory", () => {
  const sourceUrl = "https://cdn.example/portraits/person/invalidation.jpg";
  const oldSuccess = portraitRetryUrl(sourceUrl, 1);
  const newSuccess = portraitRetryUrl(sourceUrl, 2);

  rememberPortraitSuccess(sourceUrl, oldSuccess);
  rememberPortraitSuccess(sourceUrl, newSuccess);
  forgetPortraitSuccess(sourceUrl, oldSuccess);
  assert.equal(createPortraitDelivery(sourceUrl).displayUrl, newSuccess);

  forgetPortraitSuccess(sourceUrl, newSuccess);
  assert.deepEqual(createPortraitDelivery(sourceUrl), {
    displayUrl: sourceUrl,
    attempt: 0,
    retryToken: 0,
    loaded: false,
    failed: false
  });
});

test("retry URLs preserve existing query parameters and remain bounded", () => {
  const sourceUrl = "https://cdn.example/portrait.jpg?version=abc";
  const first = retryPortraitDelivery(sourceUrl, createPortraitDelivery(sourceUrl));
  const second = retryPortraitDelivery(sourceUrl, first);
  const failed = retryPortraitDelivery(sourceUrl, second);

  assert.equal(first.displayUrl, `${sourceUrl}&pleni_retry=1`);
  assert.equal(second.displayUrl, `${sourceUrl}&pleni_retry=2`);
  assert.equal(failed.failed, true);
  assert.equal(failed.displayUrl, second.displayUrl);
});
