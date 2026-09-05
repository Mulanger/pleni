import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const followingStart = app.indexOf("function FollowingScreen(");
const desktopStart = app.indexOf('if (presentation === "desktop") {', followingStart);
const mobileStart = app.indexOf(
  '<section className="panel-screen following-screen">',
  desktopStart
);
const desktopBranch = app.slice(desktopStart, mobileStart);
const mobileBranch = app.slice(mobileStart, app.indexOf("function DesktopPartyDirectory", mobileStart));

test("signed-out desktop Following explains value without inventing zero counts", () => {
  assert.match(desktopBranch, /Dina val kan forma För dig/);
  assert.match(desktopBranch, /Valen hålls isär per konto på den här enheten/);
  assert.match(desktopBranch, /Ingenting används av För dig innan du själv aktiverar personalisering/);
  assert.match(desktopBranch, /Se senaste klippen/);
  assert.match(desktopBranch, /Sök politiker och partier/);
  assert.match(desktopBranch, /<DesktopSignInPanel onOpenLegal=\{onOpenLegal\} onSignIn=\{onSignIn\} \/>/);
  assert.doesNotMatch(desktopBranch, /Behåll dina följningar/);
  assert.doesNotMatch(desktopBranch, /0 partier · 0 personer/);
});

test("signed-in desktop Following uses honest facts and the existing routes", () => {
  assert.match(desktopBranch, /libraryReady/);
  assert.match(desktopBranch, /label: "Partier"/);
  assert.match(desktopBranch, /label: "Politiker"/);
  assert.doesNotMatch(desktopBranch, /Senast tillagd/);
  assert.match(desktopBranch, /Öppna För dig/);
  assert.match(desktopBranch, /Dina följningar påverkar inte För dig ännu/);
  assert.match(desktopBranch, /onOpenProfile/);
});

test("politicians lead and parties move to the desktop side column", () => {
  assert.ok(
    desktopBranch.indexOf("desktop-following-people") <
      desktopBranch.indexOf("desktop-following-parties")
  );
  assert.match(styles, /\.desktop-following-library:not\(\.has-no-parties\)\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 336px/);
  assert.match(styles, /\.desktop-unfollow:hover,[\s\S]*border-color:\s*#b64c46/);
  assert.match(desktopBranch, /event\.stopPropagation\(\);[\s\S]*onTogglePerson/);
  assert.match(desktopBranch, /event\.stopPropagation\(\);[\s\S]*onToggleParty/);
});

test("the released mobile Following branch keeps its existing structure", () => {
  assert.match(mobileBranch, /<Header[\s\S]*title="Följer"/);
  assert.match(mobileBranch, /subtitle=\{`\$\{followedParties\.length\} partier · \$\{followedPoliticians\.length\} personer`\}/);
  assert.match(mobileBranch, /className="panel-empty following-sign-in"/);
  assert.match(mobileBranch, /className="following-groups"/);
});
