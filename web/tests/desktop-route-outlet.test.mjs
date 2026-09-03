import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { describeDesktopRoute } from "../src/desktop/route-outlet.ts";
import { createScrollMemory } from "../src/desktop/scroll-memory.ts";
import { routeFromHash } from "../src/navigation.ts";

const routes = [
  { hash: "#/hem/fordig", id: "home", available: true, action: "home" },
  { hash: "#/foljer", id: "following", available: true, action: "home" },
  { hash: "#/sok", id: "search", available: true, action: "home" },
  { hash: "#/profil", id: "profile", available: true, action: "home" },
  { hash: "#/person/alice", id: "person", available: true, action: "history" },
  { hash: "#/person/alice/clips?clip=c1", id: "person-clips", available: true, action: "history" },
  { hash: "#/party/S", id: "party", available: true, action: "history" },
  { hash: "#/party/S/clips?clip=c1", id: "party-clips", available: true, action: "history" },
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

test("desktop profile scroll memory is session-only, keyed and bounded", () => {
  const memory = createScrollMemory();
  assert.equal(memory.read("person:a"), 0);
  memory.write("person:a", 420);
  memory.write("party:S", 180);
  assert.equal(memory.read("person:a"), 420);
  assert.equal(memory.read("party:S"), 180);
  memory.write("person:a", -20);
  assert.equal(memory.read("person:a"), 0);
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

test("desktop profiles reuse mobile data components and the bounded collection player", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const outlet = readFileSync(
    new URL("../src/desktop/DesktopRouteOutlet.tsx", import.meta.url),
    "utf8"
  );
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(app, /person: route\.view === "person"/);
  assert.match(app, /party: route\.view === "party"/);
  assert.match(app, /"person-clips": route\.view === "person-clips"/);
  assert.match(app, /"party-clips": route\.view === "party-clips"/);
  assert.match(app, /<PersonScreen\s+presentation="desktop"/);
  assert.match(app, /<PartyScreen\s+presentation="desktop"/);
  assert.match(app, /<CollectionScreen\s+presentation="desktop"/);
  assert.match(app, /presentation=\{presentation\}/);
  assert.match(app, /createScrollMemory/);
  assert.match(app, /scrollKey=\{`person:/);
  assert.match(app, /scrollKey=\{`party:/);
  assert.match(app, /view: "person", tab, feedMode, personId: route\.personId/);
  assert.match(app, /view: "party", tab, feedMode, partyCode: route\.partyCode/);
  assert.match(outlet, /surfaces\[descriptor\.id\]/);
  assert.match(styles, /@media \(min-width: 1280px\)/);
  assert.match(styles, /\.person-screen--desktop \.person-scroll/);
  assert.match(styles, /\.party-screen--desktop \.person-scroll/);
});

test("desktop search reuses the public search state and bounded result player", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /search:\s*route\.view === "tab" && route\.tab === "sok"/);
  assert.match(app, /<SearchScreen\s+presentation="desktop"/);
  assert.match(app, /showingSearchFeed && searchFeedCollection !== null/);
  assert.match(app, /<CollectionScreen\s+presentation="desktop"\s+collection=\{searchFeedCollection\}/);
  assert.match(app, /presentation === "desktop" \? \(/);
  assert.match(app, /<Group title="Riksdagspartier">/);
});

test("desktop Following reuses account-bound library rows and split unfollow actions", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /following:\s*route\.view === "tab" && route\.tab === "foljer"/);
  assert.match(app, /<FollowingScreen\s+presentation="desktop"/);
  assert.match(app, /signedIn=\{viewer\.signedIn\}/);
  assert.match(app, /onSignIn=\{viewer\.requireSignIn\}/);
  assert.match(app, /event\.stopPropagation\(\);\s*onToggleParty/);
  assert.match(app, /event\.stopPropagation\(\);\s*onTogglePerson/);
  assert.match(app, /className="following-groups"/);
});

test("desktop Profile reuses account, preferences, recommendation and PWA actions", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /profile:\s*route\.view === "tab" && route\.tab === "profil"/);
  assert.match(app, /<ProfileScreen\s+presentation="desktop"/);
  assert.match(app, /onExportRecommendationData=\{\(\) => void exportMyRecommendationData\(\)\}/);
  assert.match(app, /onResetRecommendationData=\{\(\) => void resetMyRecommendationData\(\)\}/);
  assert.match(app, /onDeleteRecommendationData=\{\(\) => void deleteMyRecommendationData\(\)\}/);
  assert.match(app, /className="profile-primary-column"/);
  assert.match(app, /className="profile-secondary-column"/);
});
