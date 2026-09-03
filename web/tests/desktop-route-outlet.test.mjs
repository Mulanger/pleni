import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { describeDesktopRoute } from "../src/desktop/route-outlet.ts";
import { routeFromHash } from "../src/navigation.ts";

const routes = [
  { hash: "#/hem/fordig", id: "home", available: true, action: "home" },
  { hash: "#/foljer", id: "following", available: false, action: "home" },
  { hash: "#/sok", id: "search", available: false, action: "home" },
  { hash: "#/profil", id: "profile", available: false, action: "home" },
  { hash: "#/person/alice", id: "person", available: false, action: "history" },
  { hash: "#/person/alice/clips?clip=c1", id: "person-clips", available: false, action: "history" },
  { hash: "#/party/S", id: "party", available: false, action: "history" },
  { hash: "#/party/S/clips?clip=c1", id: "party-clips", available: false, action: "history" },
  { hash: "#/profil/saved", id: "saved", available: false, action: "history" },
  { hash: "#/profil/saved/clips?clip=c1", id: "saved-clips", available: false, action: "history" },
  { hash: "#/legal/privacy", id: "legal", available: false, action: "history" }
];

test("desktop outlet describes every current AppRoute without changing hashes", () => {
  for (const expected of routes) {
    const descriptor = describeDesktopRoute(routeFromHash(expected.hash));
    assert.equal(descriptor.id, expected.id, expected.hash);
    assert.equal(descriptor.available, expected.available, expected.hash);
    assert.equal(descriptor.backAction, expected.action, expected.hash);
    assert.ok(descriptor.focusKey.length > 0, expected.hash);
  }
});

test("route identity changes when focused desktop content changes", () => {
  const first = describeDesktopRoute(routeFromHash("#/person/alice/clips?clip=c1"));
  const second = describeDesktopRoute(routeFromHash("#/person/alice/clips?clip=c2"));
  const legal = describeDesktopRoute(routeFromHash("#/legal/terms"));

  assert.notEqual(first.focusKey, second.focusKey);
  assert.match(legal.title, /Villkor/);
});

test("desktop route architecture owns one focus boundary and shared primitives", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const outlet = readFileSync(
    new URL("../src/desktop/DesktopRouteOutlet.tsx", import.meta.url),
    "utf8"
  );
  const primitives = readFileSync(
    new URL("../src/desktop/primitives.tsx", import.meta.url),
    "utf8"
  );
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(app, /<DesktopRouteOutlet/);
  assert.doesNotMatch(app, /function DesktopComingSoon/);
  assert.match(outlet, /<DesktopRouteFrame focusKey=/);
  assert.match(outlet, /<DesktopPage/);
  assert.match(outlet, /<DesktopSection>/);
  assert.match(outlet, /<DesktopState/);
  assert.match(primitives, /focus\(\{ preventScroll: true \}\)/);
  assert.match(styles, /\.desktop-back-action:focus-visible/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
});
