import { useCallback, useEffect, useRef, useState } from "react";
import type { LegalPageId } from "./legal";
import type { FeedMode, PartyCode, Tab } from "./types";

export type AppRoute =
  | { view: "tab"; tab: Tab; feedMode: FeedMode }
  | { view: "person"; tab: Tab; feedMode: FeedMode; personId: string }
  | {
      view: "person-clips";
      tab: Tab;
      feedMode: FeedMode;
      personId: string;
      startId: string | null;
    }
  | { view: "party"; tab: Tab; feedMode: FeedMode; partyCode: PartyCode }
  | {
      view: "party-clips";
      tab: Tab;
      feedMode: FeedMode;
      partyCode: PartyCode;
      startId: string | null;
    }
  | { view: "saved"; tab: "profil"; feedMode: FeedMode }
  | { view: "saved-clips"; tab: "profil"; feedMode: FeedMode; startId: string | null }
  | { view: "legal"; tab: "profil"; feedMode: FeedMode; page: LegalPageId };

const HISTORY_KEY = "pleniNavigation";
const DEFAULT_ROUTE: AppRoute = { view: "tab", tab: "hem", feedMode: "fordig" };

function isTab(value: string | null): value is Tab {
  return value === "hem" || value === "foljer" || value === "sok" || value === "profil";
}

function feedMode(value: string | null): FeedMode {
  return value === "senaste" ? "senaste" : "fordig";
}

function legalPage(value: string | null): LegalPageId | null {
  return value === "terms" || value === "privacy" || value === "storage" || value === "about"
    ? value
    : null;
}

function partyCode(value: string | null): PartyCode | null {
  const normalized = value?.toUpperCase() ?? "";
  return normalized === "S" || normalized === "M" || normalized === "SD" ||
    normalized === "C" || normalized === "V" || normalized === "KD" ||
    normalized === "MP" || normalized === "L"
    ? normalized
    : null;
}

function decodeSegment(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Parse a static-host-safe Pleni hash route. Unknown or malformed routes fail home. */
export function routeFromHash(hash: string): AppRoute {
  const raw = hash.replace(/^#/, "");
  const [pathname, query = ""] = raw.split("?", 2);
  const segments = pathname.split("/").filter(Boolean);
  const params = new URLSearchParams(query);
  const mode = feedMode(params.get("feed") ?? segments[1] ?? null);

  if (segments[0] === "hem") {
    return { view: "tab", tab: "hem", feedMode: mode };
  }
  if (segments[0] === "legal") {
    const page = legalPage(segments[1] ?? null);
    return page
      ? { view: "legal", tab: "profil", feedMode: feedMode(params.get("feed")), page }
      : { view: "tab", tab: "profil", feedMode: feedMode(params.get("feed")) };
  }
  if (segments[0] === "saved" || (segments[0] === "profil" && segments[1] === "saved")) {
    const clipsSegment = segments[0] === "saved" ? segments[1] : segments[2];
    if (clipsSegment === "clips") {
      return {
        view: "saved-clips",
        tab: "profil",
        feedMode: feedMode(params.get("feed")),
        startId: params.get("clip")
      };
    }
    return { view: "saved", tab: "profil", feedMode: feedMode(params.get("feed")) };
  }
  if (isTab(segments[0])) {
    return { view: "tab", tab: segments[0], feedMode: feedMode(params.get("feed")) };
  }
  if (segments[0] === "person") {
    const personId = decodeSegment(segments[1]);
    if (!personId) {
      return DEFAULT_ROUTE;
    }
    const fromValue = params.get("from");
    const from: Tab = isTab(fromValue) ? fromValue : "sok";
    const preservedMode = feedMode(params.get("feed"));
    if (segments[2] === "clips") {
      return {
        view: "person-clips",
        tab: from,
        feedMode: preservedMode,
        personId,
        startId: params.get("clip")
      };
    }
    return { view: "person", tab: from, feedMode: preservedMode, personId };
  }
  if (segments[0] === "party") {
    const code = partyCode(decodeSegment(segments[1]));
    if (!code) {
      return DEFAULT_ROUTE;
    }
    const fromValue = params.get("from");
    const from: Tab = isTab(fromValue) ? fromValue : "sok";
    const preservedMode = feedMode(params.get("feed"));
    if (segments[2] === "clips") {
      return {
        view: "party-clips",
        tab: from,
        feedMode: preservedMode,
        partyCode: code,
        startId: params.get("clip")
      };
    }
    return { view: "party", tab: from, feedMode: preservedMode, partyCode: code };
  }
  return DEFAULT_ROUTE;
}

/**
 * Path routing (SEO1).
 *
 * Hash routes are invisible to search engines — everything after `#` is
 * discarded — so the whole catalogue resolved to a single indexable URL. These
 * two functions give every route a real path, and `useAppNavigation` writes
 * paths from now on. `routeFromHash`/`hashForRoute` stay exported and supported
 * for legacy inbound links, which are rewritten once on load.
 *
 * The InstaPods pod returns 404 for any path without a file, so every path
 * produced here must have a generated shell page. `web/seo/prerender.mjs` owns
 * that, and `APP_SHELL_ROUTES` below is the list it builds from. Adding a route
 * here without adding it there makes direct entry and reload 404.
 *
 * Identity is the only thing a path segment carries. There is deliberately no
 * decorative name slug in politician or party paths: the app pushes these URLs
 * itself and only ever holds the id, so a slug would produce two URLs for one
 * entity and two history entries for one page. The name ranks from the page's
 * title, heading and body, not from the URL. See ADR 014.
 */

const PARTY_PATH_CODES: Record<string, PartyCode> = {
  s: "S",
  m: "M",
  sd: "SD",
  c: "C",
  v: "V",
  kd: "KD",
  mp: "MP",
  l: "L"
};

function partyCodeFromPath(value: string | null): PartyCode | null {
  return value !== null && value.toLowerCase() in PARTY_PATH_CODES
    ? PARTY_PATH_CODES[value.toLowerCase()]
    : null;
}

/** Every path the app can push. `web/seo/prerender.mjs` writes a shell for each. */
export const APP_SHELL_ROUTES: readonly string[] = [
  "/",
  "/senaste",
  "/foljer",
  "/sok",
  "/profil",
  "/sparade",
  "/sparade/klipp",
  "/legal/terms",
  "/legal/privacy",
  "/legal/storage",
  "/legal/about"
];

/** Parse a real path into a route. Unknown or malformed paths fail home. */
export function routeFromPath(pathname: string, search = ""): AppRoute {
  const segments = pathname.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  const rawSegments = pathname.split("/").filter(Boolean);
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  const mode = feedMode(params.get("feed"));

  if (segments.length === 0) {
    return { view: "tab", tab: "hem", feedMode: "fordig" };
  }
  if (segments[0] === "senaste") {
    return { view: "tab", tab: "hem", feedMode: "senaste" };
  }
  if (segments[0] === "foljer" || segments[0] === "sok" || segments[0] === "profil") {
    return { view: "tab", tab: segments[0], feedMode: mode };
  }
  if (segments[0] === "sparade") {
    return segments[1] === "klipp"
      ? { view: "saved-clips", tab: "profil", feedMode: mode, startId: params.get("clip") }
      : { view: "saved", tab: "profil", feedMode: mode };
  }
  if (segments[0] === "legal") {
    const page = legalPage(segments[1] ?? null);
    return page
      ? { view: "legal", tab: "profil", feedMode: mode, page }
      : { view: "tab", tab: "profil", feedMode: mode };
  }

  const fromValue = params.get("from");
  const from: Tab = isTab(fromValue) ? fromValue : "sok";

  if (segments[0] === "politiker") {
    const personId = decodeSegment(rawSegments[1]);
    if (!personId) {
      return DEFAULT_ROUTE;
    }
    return segments[2] === "klipp"
      ? {
          view: "person-clips",
          tab: from,
          feedMode: mode,
          personId,
          startId: params.get("clip")
        }
      : { view: "person", tab: from, feedMode: mode, personId };
  }
  if (segments[0] === "parti") {
    const code = partyCodeFromPath(decodeSegment(rawSegments[1]));
    if (!code) {
      return DEFAULT_ROUTE;
    }
    return segments[2] === "klipp"
      ? {
          view: "party-clips",
          tab: from,
          feedMode: mode,
          partyCode: code,
          startId: params.get("clip")
        }
      : { view: "party", tab: from, feedMode: mode, partyCode: code };
  }
  return DEFAULT_ROUTE;
}

/**
 * Serialize a route into its canonical path.
 *
 * `feed` and `from` are written only when they carry information, so the
 * canonical form of a route is a single string and `pathForRoute(routeFromPath(p))`
 * is stable.
 */
export function pathForRoute(route: AppRoute): string {
  const params = new URLSearchParams();
  if (route.feedMode === "senaste" && !(route.view === "tab" && route.tab === "hem")) {
    params.set("feed", "senaste");
  }

  if (route.view === "tab") {
    if (route.tab === "hem") {
      return route.feedMode === "senaste" ? "/senaste" : "/";
    }
    return withQuery(`/${route.tab}`, params);
  }
  if (route.view === "saved") {
    return withQuery("/sparade", params);
  }
  if (route.view === "saved-clips") {
    if (route.startId) {
      params.set("clip", route.startId);
    }
    return withQuery("/sparade/klipp", params);
  }
  if (route.view === "legal") {
    return withQuery(`/legal/${route.page}`, params);
  }

  if (route.tab !== "sok") {
    params.set("from", route.tab);
  }
  if (route.view === "party" || route.view === "party-clips") {
    const base = `/parti/${route.partyCode.toLowerCase()}`;
    if (route.view === "party") {
      return withQuery(base, params);
    }
    if (route.startId) {
      params.set("clip", route.startId);
    }
    return withQuery(`${base}/klipp`, params);
  }

  const base = `/politiker/${encodeURIComponent(route.personId)}`;
  if (route.view === "person") {
    return withQuery(base, params);
  }
  if (route.startId) {
    params.set("clip", route.startId);
  }
  return withQuery(`${base}/klipp`, params);
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Serialize navigation into the hash so reloads work on the static InstaPods host. */
export function hashForRoute(route: AppRoute): string {
  if (route.view === "tab") {
    return route.tab === "hem"
      ? `#/hem/${route.feedMode}`
      : `#/${route.tab}?feed=${route.feedMode}`;
  }
  if (route.view === "saved") {
    return `#/profil/saved?feed=${route.feedMode}`;
  }
  if (route.view === "saved-clips") {
    const params = new URLSearchParams({ feed: route.feedMode });
    if (route.startId) {
      params.set("clip", route.startId);
    }
    return `#/profil/saved/clips?${params.toString()}`;
  }
  if (route.view === "legal") {
    return `#/legal/${route.page}?feed=${route.feedMode}`;
  }

  const params = new URLSearchParams({ from: route.tab, feed: route.feedMode });
  if (route.view === "party" || route.view === "party-clips") {
    if (route.view === "party-clips" && route.startId) {
      params.set("clip", route.startId);
    }
    const suffix = route.view === "party-clips" ? "/clips" : "";
    return `#/party/${route.partyCode}${suffix}?${params.toString()}`;
  }
  if (route.view === "person-clips" && route.startId) {
    params.set("clip", route.startId);
  }
  const suffix = route.view === "person-clips" ? "/clips" : "";
  return `#/person/${encodeURIComponent(route.personId)}${suffix}?${params.toString()}`;
}

function historyRecord(state: unknown): Record<string, unknown> {
  return state !== null && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
}

function historyIndex(state: unknown): number | null {
  if (state === null || typeof state !== "object") {
    return null;
  }
  const marker = (state as Record<string, unknown>)[HISTORY_KEY];
  if (marker === null || typeof marker !== "object") {
    return null;
  }
  const index = (marker as Record<string, unknown>).index;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : null;
}

function stateWithIndex(state: unknown, index: number): Record<string, unknown> {
  return { ...historyRecord(state), [HISTORY_KEY]: { index } };
}

/**
 * Resolve the route a page load started on.
 *
 * A legacy `pleni.se/#/person/<id>` link is recognised only in its original
 * shape — a hash route at the site root — so a genuine path route can never be
 * overridden by a stray fragment. Everything else reads the path.
 */
export function initialRoute(location: {
  pathname: string;
  search: string;
  hash: string;
}): AppRoute {
  const legacyHash = location.hash.startsWith("#/") && location.pathname === "/";
  return legacyHash
    ? routeFromHash(location.hash)
    : routeFromPath(location.pathname, location.search);
}

/**
 * Own Pleni's same-document history without adding a router dependency.
 *
 * `pushState` makes browser Back/Forward mirror app navigation, and since SEO1
 * it writes real paths so every route is addressable and indexable. A legacy
 * hash URL is rewritten once with `replaceState` on load — a client-side
 * redirect, because the static host cannot issue a 301.
 */
export function useAppNavigation(): {
  route: AppRoute;
  navigate: (next: AppRoute, options?: { replace?: boolean }) => void;
  backTo: (fallback: AppRoute) => void;
} {
  const [route, setRoute] = useState<AppRoute>(() => initialRoute(window.location));
  const indexRef = useRef(historyIndex(window.history.state) ?? 0);

  useEffect(() => {
    const initial = initialRoute(window.location);
    const initialIndex = historyIndex(window.history.state) ?? 0;
    indexRef.current = initialIndex;
    window.history.replaceState(
      stateWithIndex(window.history.state, initialIndex),
      "",
      pathForRoute(initial)
    );
    setRoute(initial);

    const restore = () => {
      indexRef.current = historyIndex(window.history.state) ?? 0;
      setRoute(routeFromPath(window.location.pathname, window.location.search));
    };
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("popstate", restore);
    };
  }, []);

  const navigate = useCallback((next: AppRoute, options?: { replace?: boolean }) => {
    const nextPath = pathForRoute(next);
    const replace = options?.replace === true;
    if (!replace && nextPath === `${window.location.pathname}${window.location.search}`) {
      setRoute(next);
      return;
    }

    const nextIndex = replace ? indexRef.current : indexRef.current + 1;
    const method = replace ? "replaceState" : "pushState";
    window.history[method](stateWithIndex(window.history.state, nextIndex), "", nextPath);
    indexRef.current = nextIndex;
    setRoute(next);
  }, []);

  const backTo = useCallback(
    (fallback: AppRoute) => {
      if (indexRef.current > 0) {
        window.history.back();
        return;
      }
      navigate(fallback, { replace: true });
    },
    [navigate]
  );

  return { route, navigate, backTo };
}
