import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("a desktop profile leads with a masthead, not a stretched mobile column", () => {
  assert.match(app, /<DesktopProfileBar kind="Politiker"/);
  assert.match(app, /<DesktopProfileBar kind="Parti"/);
  assert.match(app, /className="desktop-profile-hero"/);
  assert.match(app, /className="desktop-profile-hero-inner"/);

  // The hero spans the workspace on its own ground instead of the 760px
  // column the mobile hero was stretched into.
  assert.match(styles, /\.desktop-profile-hero\s*\{[^}]*background:\s*#fbfbf9/);
  assert.match(styles, /\.desktop-profile-hero-inner\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
  assert.doesNotMatch(styles, /\.person-screen--desktop \.person-hero/);
  assert.doesNotMatch(styles, /\.party-screen--desktop \.party-hero/);
});

test("watching is the primary action and reuses the existing collection routes", () => {
  assert.match(app, /className="desktop-action-primary"/);
  assert.match(app, /Spela alla klipp/);
  // Play-all starts the person/party collection from the top through the
  // same handler a tapped clip uses; no second player is introduced.
  assert.match(app, /onClick=\{\(\) => playClip\(null\)\}/);
  assert.match(app, /disabled=\{clips\.length === 0\}/);
});

test("the gallery is three across and scrolls inside its own frame", () => {
  assert.match(app, /const scrolls = rest\.length > GALLERY_VISIBLE_TILES;/);
  assert.match(app, /const GALLERY_VISIBLE_TILES = 9;/);
  assert.match(app, /scrolls \? "desktop-gallery-frame" : undefined/);
  assert.match(app, /scrolls \? "desktop-gallery-scroll" : undefined/);

  assert.match(styles, /\.desktop-profile-main \.clip-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  // Height as a ratio, so three whole rows survive every desktop width
  // rather than only the one the design was measured at.
  assert.match(styles, /\.desktop-gallery-scroll\s*\{[^}]*aspect-ratio:\s*1 \/ 1\.82/);
  assert.match(styles, /\.desktop-gallery-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /\.desktop-gallery-scroll::-webkit-scrollbar\b/);
});

test("the side column only asks for readers that already exist", () => {
  assert.match(app, /loadPoliticiansForParty\(code\)/);
  assert.match(app, /partyProfiles\.find\(\(profile\) => profile\.abbr === person\.party\)/);
  assert.match(app, /const RAIL_PERSON_LIMIT = 6;/);
  assert.match(app, /partyPeers\.filter\(\(peer\) => peer\.id !== person\.id\)/);
  assert.match(styles, /\.desktop-profile-rail\b/);
  assert.match(styles, /\.desktop-rail-person\b/);
});

test("every figure on a profile masthead comes from a real count", () => {
  // `clipCount` and `politicianCount` are null when the count request failed.
  // A fact is pushed only when the value is a number, so "we did not count"
  // renders as absent rather than as zero.
  assert.match(app, /if \(typeof total === "number"\) \{\s*facts\.push\(\{ label: "Publicerade klipp"/);
  assert.match(app, /typeof party\.politicianCount === "number"\) \{\s*facts\.push/);
  assert.match(app, /typeof party\.clipCount === "number"\) \{\s*facts\.push/);
  // The old party statistics row counted the rows that happened to load.
  assert.doesNotMatch(app, /label="Visas här"[\s\S]{0,200}desktop-profile-facts/);
});

test("a profile route lights no sidebar tab", () => {
  assert.match(app, /active=\{route\.view === "tab" \? route\.tab : null\}/);
  assert.match(app, /active: Tab \| null;/);
  assert.match(app, /className="desktop-profile-crumbs"/);
});

test("the released mobile profile is untouched", () => {
  // Same markup, same classes, same copy as the shipped mobile product.
  assert.match(app, /<section className="person-hero">/);
  assert.match(app, /<span className="party-pill">/);
  assert.match(app, /`Antal klipp: \$\{formatNumber\(total\)\}`/);
  assert.match(app, /<div className="stats party-stats">/);
  assert.match(app, /<Stat label="Visas här" value=\{formatNumber\(clips\.length\)\} \/>/);

  // Everything new is gated behind the desktop breakpoint.
  const desktopBreakpoint = styles.indexOf("@media (min-width: 1100px)");
  assert.ok(desktopBreakpoint > 0);
  assert.ok(styles.indexOf(".desktop-profile-hero {") > desktopBreakpoint);
  assert.ok(styles.indexOf(".desktop-gallery-scroll {") > desktopBreakpoint);
  assert.ok(styles.indexOf(".desktop-rail-person {") > desktopBreakpoint);
});

test("the saved archive keeps its own desktop treatment", () => {
  assert.match(styles, /\.saved-screen--desktop \.person-scroll\s*\{/);
  assert.match(styles, /\.saved-screen--desktop \.clip-grid\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(app, /className={presentation === "desktop" \? "desktop-profile-toolbar" : "person-topbar"}/);
});
