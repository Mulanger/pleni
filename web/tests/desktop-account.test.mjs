import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));

test("the account page leads with a masthead band, not a panel header", () => {
  assert.match(app, /className="desktop-account-band"/);
  assert.match(app, /className="desktop-account-band-inner"/);
  assert.match(styles, /\.desktop-account-band\s*\{[^}]*background:\s*#fbfbf9/);
  // The desktop branch renders no <Header>; its rules are gone with it.
  assert.doesNotMatch(styles, /\.profile-screen--desktop \.panel-header/);
});

test("identity is Pleni's own, not Clerk's widget", () => {
  assert.match(app, /function DesktopAccountIdentity\(\)/);
  assert.match(app, /className="desktop-account-avatar"/);
  // The portrait is still Clerk's; only the frame around it is ours.
  assert.match(app, /user\?\.imageUrl \?\? null/);
  // The sidebar's widget used a 38px avatar box; the mobile account card
  // still uses its own 46px one, so name the exact usage that went away.
  assert.doesNotMatch(app, /userButtonAvatarBox: \{ width: 38, height: 38 \}/);
  assert.match(app, /function DesktopSidebarAccount\(/);
  assert.match(app, /<DesktopSidebarAccount onOpen=\{\(\) => onChange\("profil"\)\}/);
});

test("manage and sign out are both quiet, and management stays Clerk's", () => {
  const actions = slice("function DesktopAccountActions()", "function DesktopSignInPanel(");
  assert.match(actions, /clerk\.openUserProfile\(\)/);
  assert.match(actions, /<SignOutButton>/);
  // No navy primary: the only candidate would have been sign-out.
  assert.doesNotMatch(actions, /is-primary/);
});

test("counts appear only when there is an account they belong to", () => {
  assert.match(app, /\{signedIn && \(\s*\n\s*<dl className="desktop-account-facts">/);
  assert.match(app, /<dt>Sparade klipp<\/dt>\s*\n\s*<dd>\{formatNumber\(savedCount\)\}<\/dd>/);
  assert.match(app, /<dt>Följer<\/dt>\s*\n\s*<dd>\{formatNumber\(totalFollowed\)\}<\/dd>/);
});

test("the two columns have a rule behind them", () => {
  assert.match(app, /className="desktop-account-main"/);
  assert.match(app, /className="desktop-account-rail"/);
  assert.match(app, /<Group title="Ditt innehåll">/);
  assert.match(app, /<Group title="Dina data">/);
  assert.match(app, /<Group title="Villkor och information">/);
  assert.match(styles, /\.desktop-account-body\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 380px/);
  // The arbitrary 1fr 1fr split is gone.
  assert.doesNotMatch(app, /profile-desktop-grid/);
  assert.doesNotMatch(styles, /profile-desktop-grid/);
});

test("deleting looks like deleting", () => {
  assert.match(app, /tone=\{presentation === "desktop" \? "danger" : undefined\}\s*\n\s*onClick=\{recommendationAction \? undefined : onDeleteRecommendationData\}/);
  assert.match(app, /className="profile-danger-note"/);
  assert.match(styles, /\.profile-danger-note\s*\{/);
  // The shared danger tone already colours the title and icon.
  assert.match(styles, /\.danger \.row-copy strong,\s*\n\.danger \.row-icon/);
});

test("analytics settings survive the account-page merge in both layouts", () => {
  assert.match(app, /const analyticsGroup = \(\s*\n\s*<Group title="Integritet">/);
  assert.match(app, /title="Analys och cookies"/);
  assert.match(app, /onClick=\{onOpenAnalyticsSettings\}/);

  const desktopRail = slice('<aside className="desktop-account-rail">', '<div className="profile-legal-group">');
  assert.ok(desktopRail.indexOf("{analyticsGroup}") >= 0);
  assert.ok(desktopRail.indexOf("{analyticsGroup}") < desktopRail.indexOf('<Group title="Dina data">'));

  const mobile = slice('<section className="panel-screen profile-screen">', "function DesktopAccountIdentity");
  assert.match(mobile, /<Group title="Personalisering">\{consentGroupRows\}<\/Group>\s*\n\s*\{analyticsGroup\}/);
});

test("data controls need the account they act on", () => {
  // `recommendationsConnected` is a build flag, not a session, so the group
  // used to offer export/reset/delete to a signed-out viewer.
  assert.match(app, /\{signedIn && recommendationRows && \(/);
});

test("the sign-in module is the one the Följer page uses", () => {
  assert.match(app, /function DesktopSignInPanel\(/);
  assert.match(app, /<SignInButton mode="modal">/);
  assert.match(app, /<SignUpButton mode="modal">/);
  assert.match(app, /Är du under 13 år behöver du din vårdnadshavares tillstånd/);
  assert.match(styles, /\.desktop-signin-panel\s*\{/);
});

test("the released mobile account page is untouched", () => {
  const mobile = slice('<section className="panel-screen profile-screen">', "function DesktopAccountIdentity");
  assert.match(mobile, /<Header title="Profil" \/>/);
  assert.match(mobile, /<AccountCard signedIn=\{signedIn\} onOpenLegal=\{onOpenLegal\} \/>/);
  assert.match(mobile, /<Group title="Konto">/);
  assert.match(mobile, /<Group title="Mina intressen">/);
  assert.match(mobile, /<Group title="Mina rekommendationsdata">/);
  assert.match(mobile, /\{legalLinks\}/);
  assert.match(app, /className="profile-legal-links"/);

  const desktopBreakpoint = styles.indexOf("@media (min-width: 1100px)");
  assert.ok(desktopBreakpoint > 0);
  for (const rule of [".desktop-account-band {", ".desktop-account-body {", ".desktop-signin-panel {", ".desktop-account-me {"]) {
    assert.ok(styles.indexOf(rule) > desktopBreakpoint, `${rule} must sit behind the desktop breakpoint`);
  }
});

test("every group is built once and composed twice", () => {
  // One source for each row, so the phone and desktop cannot drift apart.
  for (const name of ["accountRows", "installGroup", "interestsRow", "consentGroupRows", "analyticsGroup", "recommendationRows", "legalLinks", "versionLine"]) {
    assert.ok(app.includes(`const ${name} =`), `${name} should be built once`);
  }
});
