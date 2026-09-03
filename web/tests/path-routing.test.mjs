import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_SHELL_ROUTES,
  hashForRoute,
  initialRoute,
  partyPathSlug,
  pathForRoute,
  personPathSlug,
  routeFromHash,
  routeFromPath
} from "../src/navigation.ts";
import { PARTY_NAMES, cleanName, slugify } from "../seo/lib.mjs";

/**
 * SEO1 — path routing.
 *
 * Hash routes are invisible to search engines, so every route now has a real
 * path. Two properties matter and are asserted here: a canonical path
 * round-trips through the route model unchanged, and every legacy hash link
 * still lands on the same route it always did.
 */

const CANONICAL_PATHS = [
  "/",
  "/senaste/",
  "/foljer/",
  "/sok/",
  "/profil/",
  "/sparade/",
  "/sparade/klipp/",
  "/sparade/klipp/?clip=HD1_a-b_c01",
  "/legal/terms/",
  "/legal/privacy/",
  "/legal/storage/",
  "/legal/about/",
  "/politiker/490b6787-c178-42e1-9ab8-e9d233939643/",
  "/politiker/490b6787-c178-42e1-9ab8-e9d233939643/klipp/",
  "/politiker/490b6787-c178-42e1-9ab8-e9d233939643/?from=hem",
  "/politiker/490b6787-c178-42e1-9ab8-e9d233939643/klipp/?clip=HD1_a-b_c01",
  "/politiker/andreas-carlson/490b6787-c178-42e1-9ab8-e9d233939643/",
  "/politiker/andreas-carlson/490b6787-c178-42e1-9ab8-e9d233939643/klipp/",
  "/politiker/andreas-carlson/490b6787-c178-42e1-9ab8-e9d233939643/?from=hem",
  "/parti/moderaterna/",
  "/parti/sverigedemokraterna/klipp/",
  "/parti/socialdemokraterna/?from=foljer",
  "/foljer/?feed=senaste",
  "/politiker/abc/?feed=senaste"
];

test("every canonical path round-trips through the route model", () => {
  for (const path of CANONICAL_PATHS) {
    const [pathname, search = ""] = path.split("?", 2);
    const route = routeFromPath(pathname, search);
    assert.equal(pathForRoute(route), path, `round-trip failed for ${path}`);
  }
});

test("the home feed keeps its mode in the path, never a query", () => {
  assert.equal(pathForRoute({ view: "tab", tab: "hem", feedMode: "fordig" }), "/");
  assert.equal(pathForRoute({ view: "tab", tab: "hem", feedMode: "senaste" }), "/senaste/");
  assert.equal(routeFromPath("/").feedMode, "fordig");
  assert.equal(routeFromPath("/senaste").feedMode, "senaste");
});

test("default query values are omitted so each route has one canonical path", () => {
  // `feed=fordig` and `from=sok` are the defaults the parser already applies.
  assert.equal(pathForRoute(routeFromPath("/foljer", "feed=fordig")), "/foljer/");
  assert.equal(pathForRoute(routeFromPath("/politiker/abc", "from=sok")), "/politiker/abc/");
});

test("every legacy hash route lands on the route it always did", () => {
  const legacy = [
    "#/hem/fordig",
    "#/hem/senaste",
    "#/foljer?feed=senaste",
    "#/sok?feed=fordig",
    "#/profil?feed=fordig",
    "#/profil/saved?feed=fordig",
    "#/profil/saved/clips?feed=fordig&clip=HD1_a-b_c01",
    "#/legal/terms?feed=fordig",
    "#/legal/about?feed=senaste",
    "#/person/490b6787-c178-42e1-9ab8-e9d233939643?from=hem&feed=fordig",
    "#/person/abc/clips?from=sok&feed=fordig&clip=HD1_a-b_c01",
    "#/party/M?from=foljer&feed=fordig",
    "#/party/SD/clips?from=sok&feed=senaste"
  ];

  for (const hash of legacy) {
    const fromHash = routeFromHash(hash);
    const viaPath = routeFromPath(...splitPath(pathForRoute(fromHash)));
    assert.deepEqual(viaPath, fromHash, `legacy hash lost meaning: ${hash}`);
  }
});

test("a legacy hash link at the site root is honoured, a stray fragment is not", () => {
  const legacy = initialRoute({
    pathname: "/",
    search: "",
    hash: "#/person/abc?from=hem&feed=senaste"
  });
  assert.deepEqual(legacy, {
    view: "person",
    tab: "hem",
    feedMode: "senaste",
    personId: "abc"
  });

  // A real path route must never be overridden by a fragment left on the URL.
  const path = initialRoute({ pathname: "/parti/m", search: "", hash: "#/hem/fordig" });
  assert.deepEqual(path, { view: "party", tab: "sok", feedMode: "fordig", partyCode: "M" });

  assert.deepEqual(initialRoute({ pathname: "/senaste", search: "", hash: "" }), {
    view: "tab",
    tab: "hem",
    feedMode: "senaste"
  });
});

test("party paths accept the readable name and the bare code as an alias", () => {
  for (const [segment, code] of [
    ["moderaterna", "M"],
    ["Moderaterna", "M"],
    ["m", "M"],
    ["M", "M"],
    ["sverigedemokraterna", "SD"],
    ["sd", "SD"],
    ["KD", "KD"],
    ["vansterpartiet", "V"],
    ["miljopartiet", "MP"]
  ]) {
    assert.equal(routeFromPath(`/parti/${segment}`).partyCode, code);
  }

  // The readable name is what gets written, so it is the canonical form and
  // the bare code stays a working alias rather than a competing URL.
  assert.equal(pathForRoute(routeFromPath("/parti/m")), "/parti/moderaterna/");
  assert.equal(partyPathSlug("V"), "vansterpartiet");
  // `NONE` is a display bucket for party-less speakers, not an addressable party.
  for (const segment of ["none", "x", "abc", ""]) {
    assert.deepEqual(routeFromPath(`/parti/${segment}`), {
      view: "tab",
      tab: "hem",
      feedMode: "fordig"
    });
  }
});

test("malformed and unknown paths fail home rather than throwing", () => {
  for (const path of ["/nope", "/politiker", "/politiker/", "/legal", "/legal/nope", "/%"]) {
    const route = routeFromPath(...splitPath(path));
    assert.equal(route.view === "tab" || route.view === "legal", true);
    assert.doesNotThrow(() => pathForRoute(route));
  }
});

test("politician ids survive encoding in both directions", () => {
  const id = "id with space/slash";
  const path = pathForRoute({ view: "person", tab: "sok", feedMode: "fordig", personId: id });
  assert.equal(path, `/politiker/${encodeURIComponent(id)}/`);
  assert.equal(routeFromPath(...splitPath(path)).personId, id);
});

test("the shell route list covers every path the app can push without an id", () => {
  // The InstaPods pod 404s any path without a file, so a pushed path with no
  // generated shell breaks reload and sharing. Identity-bearing routes are
  // generated per entity by the prerenderer instead.
  const pushable = CANONICAL_PATHS.map((path) => splitPath(path)[0]).filter(
    (pathname) => !pathname.startsWith("/politiker/") && !pathname.startsWith("/parti/")
  );
  for (const pathname of new Set(pushable)) {
    assert.ok(
      APP_SHELL_ROUTES.includes(pathname),
      `${pathname} is pushable but has no shell in APP_SHELL_ROUTES`
    );
  }
});

test("hashForRoute stays available for legacy support", () => {
  assert.equal(hashForRoute({ view: "tab", tab: "hem", feedMode: "fordig" }), "#/hem/fordig");
});


test("the app and the prerenderer derive identical slugs", () => {
  // `personPathSlug` in navigation.ts and `slugify` in seo/lib.mjs must agree,
  // or the app would push a URL the prerenderer never generated and a reload
  // would 404. This test is the drift guard; there is no shared module because
  // one side is TypeScript in the bundle and the other plain Node in the build.
  const names = [
    "Infrastruktur- och bostadsministern Andreas Carlson (KD)",
    "Acko Ankarberg Johansson",
    "Åsa Ödman-Ärlig",
    "Jean-Pierre Sørensen",
    "Talmannen Ulf Kristersson (M)",
    "Statsrådet Elisabeth Svantesson (M)",
    "Zara Leghissa",
    "Ida Gabrielsson"
  ];
  for (const name of names) {
    const cleaned = cleanName(name) || name;
    assert.equal(personPathSlug(cleaned), slugify(cleaned), `slug drift for "${name}"`);
  }

  for (const [code, partyName] of Object.entries(PARTY_NAMES)) {
    assert.equal(partyPathSlug(code), slugify(partyName), `party slug drift for ${code}`);
  }
});

test("a decorative slug never changes which politician a path means", () => {
  const id = "490b6787-c178-42e1-9ab8-e9d233939643";
  const withSlug = routeFromPath(`/politiker/andreas-carlson/${id}`);
  const withWrongSlug = routeFromPath(`/politiker/nagon-helt-annan/${id}`);
  const withoutSlug = routeFromPath(`/politiker/${id}`);

  assert.equal(withSlug.personId, id);
  assert.equal(withWrongSlug.personId, id);
  assert.equal(withoutSlug.personId, id);
  assert.equal(withoutSlug.personSlug, undefined);

  // `klipp` can never be mistaken for an id, which is what makes all four
  // path shapes decidable.
  assert.equal(routeFromPath(`/politiker/${id}/klipp`).view, "person-clips");
  assert.equal(routeFromPath(`/politiker/andreas-carlson/${id}/klipp`).view, "person-clips");
  assert.equal(routeFromPath(`/politiker/andreas-carlson/${id}/klipp`).personSlug, "andreas-carlson");
});

function splitPath(path) {
  const [pathname, search = ""] = path.split("?", 2);
  return [pathname, search];
}
