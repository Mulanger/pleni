import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_RECOMMENDATION_PROFILE,
  PERSONALIZATION_NOTICE_VERSION,
  parseRecommendationProfile
} from "../src/consent.ts";

test("parses, deduplicates and bounds the server recommendation profile", () => {
  assert.deepEqual(
    parseRecommendationProfile({
      personalization: true,
      noticeVersion: PERSONALIZATION_NOTICE_VERSION,
      explicitParties: ["S", "S", "INVALID", "M"],
      followedParties: ["V", 12, "V"],
      followedPoliticians: [
        "a3dd5ae1-5c31-4ff8-b9ab-6b84b6078714",
        "not-a-uuid",
        "a3dd5ae1-5c31-4ff8-b9ab-6b84b6078714",
        "5ff83963-6269-49eb-889c-7cdd774bde46"
      ]
    }),
    {
      personalization: true,
      noticeVersion: PERSONALIZATION_NOTICE_VERSION,
      explicitParties: ["S", "M"],
      followedParties: ["V"],
      followedPoliticians: [
        "a3dd5ae1-5c31-4ff8-b9ab-6b84b6078714",
        "5ff83963-6269-49eb-889c-7cdd774bde46"
      ]
    }
  );
});

test("a missing grant never becomes personalised through truthy coercion", () => {
  assert.deepEqual(
    parseRecommendationProfile({ personalization: "true" }),
    EMPTY_RECOMMENDATION_PROFILE
  );
});

test("rejects a non-object recommendation response", () => {
  assert.throws(() => parseRecommendationProfile(null), /Ogiltigt rekommendationssvar/);
});
