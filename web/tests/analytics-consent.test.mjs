import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypescript(relativePath, replacements = []) {
  let source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  for (const [pattern, value] of replacements) source = source.replace(pattern, value);
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}#${Math.random()}`);
}

function browserHarness() {
  let script = null;
  const cookieWrites = [];
  const events = [];
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  };
  globalThis.window = {
    location: { hostname: "www.pleni.se", origin: "https://www.pleni.se", pathname: "/" },
    dispatchEvent(event) { events.push(event); },
    dataLayer: []
  };
  globalThis.document = {
    head: { appendChild(node) { script = node; } },
    createElement() { return { id: "", async: false, src: "", remove() { script = null; } }; },
    getElementById(id) { return script?.id === id ? script : null; },
    get cookie() { return "_ga=client; _ga_STDL8RHDCX=session; necessary=keep"; },
    set cookie(value) { cookieWrites.push(value); }
  };
  return { cookieWrites, events, getScript: () => script };
}

const clip = {
  id: "HD-test_c01",
  politicianName: "Statsrådet Åsa Öberg (S)",
  speakerName: "Åsa Öberg (S)",
  sourceTitle: "Bostäder och trygghet",
  title: "Ett offentligt anförande",
  durationS: 40,
  isSample: false
};

test("Google-taggen laddas först efter ett uttryckligt ja", async () => {
  const browser = browserHarness();
  const analytics = await importTypescript("../src/analytics.ts", [
    [/import\.meta\.env\.VITE_GA_MEASUREMENT_ID\?\.trim\(\)/g, "undefined"]
  ]);

  assert.equal(analytics.isAnalyticsEnabled(), false);
  assert.equal(browser.getScript(), null);
  assert.equal(analytics.trackVideoStart(clip, "home_latest"), false);
  assert.equal(window.dataLayer.length, 0);

  analytics.enableAnalytics();
  assert.equal(analytics.isAnalyticsEnabled(), true);
  assert.match(browser.getScript().src, /googletagmanager\.com\/gtag\/js\?id=G-STDL8RHDCX/);
  assert.deepEqual(window.dataLayer[0].slice(0, 2), ["consent", "default"]);
  assert.equal(window.dataLayer[0][2].analytics_storage, "denied");
  assert.equal(window.dataLayer[2][2].analytics_storage, "granted");
});

test("klippmått dedupliceras och använder den kanoniska SEO-adressen", async () => {
  browserHarness();
  const analytics = await importTypescript("../src/analytics.ts", [
    [/import\.meta\.env\.VITE_GA_MEASUREMENT_ID\?\.trim\(\)/g, "undefined"]
  ]);
  analytics.enableAnalytics();
  const baseline = window.dataLayer.length;

  assert.equal(analytics.trackClipImpression(clip, "home_latest", 2), true);
  assert.equal(analytics.trackClipImpression(clip, "home_latest", 2), false);
  analytics.trackVideoStart(clip, "home_latest");
  analytics.trackVideoStart(clip, "home_latest");
  analytics.trackQualifiedView(clip, "home_latest");
  analytics.trackVideoProgress(clip, "home_latest", 31, 40);
  analytics.trackVideoProgress(clip, "home_latest", 39, 40);
  analytics.trackVideoComplete(clip, "home_latest");
  analytics.trackVideoComplete(clip, "home_latest");
  analytics.trackWatchTime(clip, "home_latest", 4_250);
  analytics.trackWatchTime(clip, "home_latest", 5_000);

  const commands = window.dataLayer.slice(baseline).filter(([kind]) => kind === "event");
  const names = commands.map(([, name]) => name);
  assert.equal(names.filter((name) => name === "clip_impression").length, 1);
  assert.equal(names.filter((name) => name === "page_view").length, 1);
  assert.equal(names.filter((name) => name === "video_start").length, 1);
  assert.equal(names.filter((name) => name === "qualified_view").length, 1);
  assert.equal(names.filter((name) => name === "video_progress").length, 3);
  assert.equal(names.filter((name) => name === "video_complete").length, 1);
  assert.equal(names.filter((name) => name === "watch_time").length, 1);
  const pageView = commands.find(([, name]) => name === "page_view");
  assert.equal(
    pageView[2].page_path,
    "/klipp/asa-oberg-bostader-och-trygghet/HD-test_c01/"
  );
  const serialized = JSON.stringify(commands);
  for (const forbidden of ["user_id", "email", "search_term", "comment", "followed", "liked", "saved"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("avslag stoppar nya händelser och rensar endast analyscookies", async () => {
  const browser = browserHarness();
  const analytics = await importTypescript("../src/analytics.ts", [
    [/import\.meta\.env\.VITE_GA_MEASUREMENT_ID\?\.trim\(\)/g, "undefined"]
  ]);
  analytics.enableAnalytics();
  analytics.disableAnalytics();
  const afterDisable = window.dataLayer.length;
  assert.equal(browser.getScript(), null);
  assert.equal(analytics.trackVideoStart({ ...clip, id: "other" }, "home_latest"), false);
  assert.equal(window.dataLayer.length, afterDisable);
  assert.ok(browser.cookieWrites.some((value) => value.startsWith("_ga=")));
  assert.ok(browser.cookieWrites.some((value) => value.startsWith("_ga_STDL8RHDCX=")));
  assert.equal(browser.cookieWrites.some((value) => value.startsWith("necessary=")), false);
});

test("demo- och förladdningsklipp kan inte bli analysvisningar", async () => {
  browserHarness();
  const analytics = await importTypescript("../src/analytics.ts", [
    [/import\.meta\.env\.VITE_GA_MEASUREMENT_ID\?\.trim\(\)/g, "undefined"]
  ]);
  analytics.enableAnalytics();
  const baseline = window.dataLayer.length;
  assert.equal(analytics.trackClipImpression({ ...clip, isSample: true }, "home_latest"), false);
  assert.equal(window.dataLayer.length, baseline);
});

test("samtyckesposten är versionsbunden och lagrar både ja och nej", async () => {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, value); }
    }
  };
  const consent = await importTypescript("../src/analytics-consent.ts");
  assert.equal(consent.readAnalyticsConsent(), null);
  consent.writeAnalyticsConsent("denied");
  assert.equal(consent.readAnalyticsConsent().analytics, "denied");
  values.set(consent.ANALYTICS_CONSENT_STORAGE_KEY, JSON.stringify({
    version: "old", analytics: "granted", decidedAt: new Date().toISOString()
  }));
  assert.equal(consent.readAnalyticsConsent(), null);
});

test("spelarintegrationen kräver synlighet, verklig uppspelning och wall clock", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /QUALIFIED_IMPRESSION_DWELL_MS/);
  assert.match(source, /document\.visibilityState === "visible"/);
  assert.match(source, /intersectionRatio/);
  assert.match(source, /!video\.paused/);
  assert.match(source, /performance\.now\(\)/);
  assert.match(source, /clipSource === "supabase"/);
  assert.match(source, /trackVideoComplete/);
});

test("förstagångsfrågan väntar tills sidan laddat och håller texten kort", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const bannerSource = await readFile(
    new URL("../src/AnalyticsConsentBanner.tsx", import.meta.url),
    "utf8"
  );

  assert.match(appSource, /document\.readyState === "complete"/);
  assert.match(appSource, /window\.addEventListener\("load", revealAfterPageLoad/);
  assert.match(appSource, /ANALYTICS_PROMPT_DELAY_MS = 900/);
  assert.match(
    appSource,
    /analyticsConsent === null && analyticsPromptReady/
  );
  assert.doesNotMatch(bannerSource, /fungerar lika bra om du tackar nej/i);
});
