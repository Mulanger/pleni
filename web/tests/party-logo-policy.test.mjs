import assert from "node:assert/strict";
import test from "node:test";

import { PARTIES } from "../src/data.ts";
import {
  forgetPartyLogoSuccess,
  hasPartyLogoSuccess,
  isCompletePartyLogoImage,
  normalizePartyLogoUrl,
  rememberPartyLogoSuccess,
  shouldShowPartyLogoFallback
} from "../src/party-logo-policy.ts";

test("verified HTTPS party-logo mirrors are accepted and normalized", () => {
  assert.equal(
    normalizePartyLogoUrl(
      " https://riketnlooigm.b-cdn.net/party-logos/s/abc.png "
    ),
    "https://riketnlooigm.b-cdn.net/party-logos/s/abc.png"
  );
  assert.equal(
    normalizePartyLogoUrl("https://media.pleni.se/party-logos/m/abc.png"),
    "https://media.pleni.se/party-logos/m/abc.png"
  );
});

test("official provenance URLs never become a live frontend fallback", () => {
  assert.equal(
    normalizePartyLogoUrl("https://bilder.riksdagen.se/publishedmedia/logo.png"),
    null
  );
  assert.equal(normalizePartyLogoUrl("https://riksdagen.se/logo.png"), null);
});

test("unsafe or absent logo values retain the local party fallback", () => {
  for (const value of [null, undefined, "", "not a url", "http://cdn.example/logo.png", "https://user@cdn.example/logo.png"]) {
    assert.equal(normalizePartyLogoUrl(value), null);
  }
  for (const code of ["S", "M", "SD", "C", "V", "KD", "MP", "L"]) {
    assert.equal(PARTIES[code].logoUrl, null);
  }
});

test("a valid logo suppresses the letter throughout loading and navigation", () => {
  const url = "https://cdn.example/party-logos/s/immutable.png";

  assert.equal(shouldShowPartyLogoFallback(url, null), false);
  assert.equal(hasPartyLogoSuccess(url), false);
  rememberPartyLogoSuccess(url);
  assert.equal(hasPartyLogoSuccess(url), true);
  assert.equal(shouldShowPartyLogoFallback(url, null), false);

  forgetPartyLogoSuccess(url);
  assert.equal(hasPartyLogoSuccess(url), false);
});

test("the letter returns only for absent or genuinely failed delivery", () => {
  const url = "https://cdn.example/party-logos/m/immutable.png";

  assert.equal(shouldShowPartyLogoFallback(null, null), true);
  assert.equal(shouldShowPartyLogoFallback(url, url), true);
  assert.equal(shouldShowPartyLogoFallback(url, "https://cdn.example/old.png"), false);
});

test("an already-decoded logo is recognized synchronously", () => {
  assert.equal(isCompletePartyLogoImage({ complete: true, naturalWidth: 500 }), true);
  assert.equal(isCompletePartyLogoImage({ complete: false, naturalWidth: 500 }), false);
  assert.equal(isCompletePartyLogoImage({ complete: true, naturalWidth: 0 }), false);
});
