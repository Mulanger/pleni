import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("the search page asks for a party once, not twice", () => {
  // The chips and the `Riksdagspartier` list pointed at the same eight
  // parties from two places. The list is gone; the chips now appear only
  // once there are results to filter.
  assert.match(app, /<DesktopPartyDirectory/);
  assert.match(app, /\{\(presentation !== "desktop" \|\| showResults\) && \(/);
  assert.doesNotMatch(app, /<Group title="Riksdagspartier">/);
  assert.match(styles, /\.party-directory\b/);
});

test("each party button carries the verified mark and the whole name", () => {
  const directory = app.slice(
    app.indexOf("function DesktopPartyDirectory("),
    app.indexOf("function SearchScreen(")
  );
  // PartyAvatar renders party_profiles.logo_url with the party-coloured
  // letter as its fallback — the same component the old list used.
  assert.match(directory, /<PartyAvatar party=\{profile\.abbr\} color=\{profile\.color\} logoUrl=\{profile\.logoUrl\} \/>/);
  assert.match(directory, /<span className="party-directory-name">\{profile\.name\}<\/span>/);
  assert.match(styles, /\.party-directory-trigger \.party-avatar\s*\{[^}]*width:\s*32px/);
});

test("the button opens a roll-down instead of navigating", () => {
  const directory = app.slice(
    app.indexOf("function DesktopPartyDirectory("),
    app.indexOf("function SearchScreen(")
  );
  assert.match(directory, /aria-expanded=\{open\}/);
  assert.match(directory, /aria-haspopup="true"/);
  assert.match(directory, /aria-controls=\{panelId\}/);
  assert.match(directory, /onClick=\{\(\) => setOpenCode\(open \? null : profile\.abbr\)\}/);
  assert.match(directory, /role="menu"/);
});

test("a click outside, Escape or Tab closes it", () => {
  const directory = app.slice(
    app.indexOf("function DesktopPartyDirectory("),
    app.indexOf("function SearchScreen(")
  );
  assert.match(directory, /document\.addEventListener\("pointerdown", handlePointerDown\)/);
  assert.match(directory, /rootRef\.current\?\.contains\(event\.target\)/);
  assert.match(directory, /event\.key === "Escape"/);
  assert.match(directory, /event\.key === "Tab"/);
  // Escape hands focus back to the button it came from.
  assert.match(directory, /triggersRef\.current\.get\(openCode\);\s*\n\s*setOpenCode\(null\);\s*\n\s*trigger\?\.focus\(\)/);
  assert.match(directory, /document\.removeEventListener\("pointerdown", handlePointerDown\)/);
});

test("the members list scrolls inside the panel", () => {
  const directory = app.slice(
    app.indexOf("function DesktopPartyDirectory("),
    app.indexOf("function SearchScreen(")
  );
  assert.match(app, /const PARTY_MEMBER_LIMIT = 100;/);
  assert.match(directory, /loadPoliticiansForParty\(openCode, PARTY_MEMBER_LIMIT\)/);
  assert.match(styles, /\.party-menu-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /\.party-menu-scroll\s*\{[^}]*height:\s*clamp\(180px, 28vh, 260px\)/);
  assert.match(styles, /\.party-menu-scroll::-webkit-scrollbar\b/);
  // Tab must not walk 107 politicians; the arrows move inside instead.
  assert.match(directory, /tabIndex=\{-1\}/);
  assert.match(directory, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
});

test("politicians are fetched once per party and kept", () => {
  const directory = app.slice(
    app.indexOf("function DesktopPartyDirectory("),
    app.indexOf("function SearchScreen(")
  );
  assert.match(directory, /if \(openCode === null \|\| members\[openCode\] !== undefined\) \{\s*\n\s*return;/);
  assert.match(directory, /setMembers\(\(current\) => \(\{ \.\.\.current, \[openCode\]: rows \}\)\)/);
  // A failed fetch must not take the party page away with it.
  assert.match(directory, /Ledamöterna kunde inte hämtas\. Partisidan fungerar ändå\./);
});

test("the roll-down never hangs off the workspace", () => {
  // The last column in each row flips to right-aligned, and the column count
  // changes at 1360 where the longest party name stops truncating.
  assert.match(styles, /\.party-directory-item:nth-child\(3n\) \.party-menu\s*\{\s*right: 0;\s*left: auto;/);
  assert.match(styles, /@media \(min-width: 1360px\)/);
  const wide = styles.slice(styles.indexOf("@media (min-width: 1360px)"));
  assert.match(wide, /\.party-directory-grid\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(wide, /\.party-directory-item:nth-child\(4n\) \.party-menu\s*\{\s*right: 0;\s*left: auto;/);
});

test("the released mobile search page is untouched", () => {
  assert.match(app, /<Group title="Populära debatter">/);
  assert.match(app, /presentation === "mobile" && \(/);
  // The phone keeps the icon-only home chip; only desktop gets the label.
  assert.match(app, /presentation === "desktop" \? \(\s*\n\s*<span>Alla partier<\/span>/);
  const desktopBreakpoint = styles.indexOf("@media (min-width: 1100px)");
  assert.ok(desktopBreakpoint > 0);
  assert.ok(styles.indexOf(".party-directory {") > desktopBreakpoint);
  assert.ok(styles.indexOf(".party-menu {") > desktopBreakpoint);
});
