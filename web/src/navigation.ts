import { useCallback, useEffect, useRef, useState } from "react";
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
  | { view: "saved"; tab: "profil"; feedMode: FeedMode };

const HISTORY_KEY = "pleniNavigation";
const DEFAULT_ROUTE: AppRoute = { view: "tab", tab: "hem", feedMode: "fordig" };

function isTab(value: string | null): value is Tab {
  return value === "hem" || value === "foljer" || value === "sok" || value === "profil";
}

function feedMode(value: string | null): FeedMode {
  return value === "senaste" ? "senaste" : "fordig";
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
  if (segments[0] === "saved" || (segments[0] === "profil" && segments[1] === "saved")) {
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
 * Own Pleni's same-document history without adding a router dependency.
 *
 * `pushState` makes browser Back/Forward mirror app navigation. Hash URLs keep
 * deep links and reloads compatible with the static host, which has no SPA
 * fallback for path-based routes.
 */
export function useAppNavigation(): {
  route: AppRoute;
  navigate: (next: AppRoute, options?: { replace?: boolean }) => void;
  backTo: (fallback: AppRoute) => void;
} {
  const [route, setRoute] = useState<AppRoute>(() => routeFromHash(window.location.hash));
  const indexRef = useRef(historyIndex(window.history.state) ?? 0);

  useEffect(() => {
    const initial = routeFromHash(window.location.hash);
    const initialIndex = historyIndex(window.history.state) ?? 0;
    indexRef.current = initialIndex;
    window.history.replaceState(
      stateWithIndex(window.history.state, initialIndex),
      "",
      hashForRoute(initial)
    );
    setRoute(initial);

    const restore = () => {
      indexRef.current = historyIndex(window.history.state) ?? 0;
      setRoute(routeFromHash(window.location.hash));
    };
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("popstate", restore);
    };
  }, []);

  const navigate = useCallback((next: AppRoute, options?: { replace?: boolean }) => {
    const nextHash = hashForRoute(next);
    const replace = options?.replace === true;
    if (!replace && nextHash === window.location.hash) {
      setRoute(next);
      return;
    }

    const nextIndex = replace ? indexRef.current : indexRef.current + 1;
    const method = replace ? "replaceState" : "pushState";
    window.history[method](stateWithIndex(window.history.state, nextIndex), "", nextHash);
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
