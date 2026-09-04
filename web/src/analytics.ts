import type { ClipItem } from "./types";

export const ANALYTICS_STATE_EVENT = "pleni:analytics-state";
export const QUALIFIED_IMPRESSION_FRACTION = 0.72;
export const QUALIFIED_IMPRESSION_DWELL_MS = 1_000;
export const QUALIFIED_VIEW_WATCH_MS = 3_000;

const DEFAULT_MEASUREMENT_ID = "G-STDL8RHDCX";
const SCRIPT_ID = "pleni-google-analytics";
const measurementId = import.meta.env.VITE_GA_MEASUREMENT_ID?.trim() || DEFAULT_MEASUREMENT_ID;

type GtagCommand = [command: string, ...values: unknown[]];
type AnalyticsParams = Record<string, string | number | boolean>;

export type FeedAnalyticsContext =
  | "home_for_you"
  | "home_latest"
  | "seo_clip"
  | "person"
  | "party"
  | "saved"
  | "search"
  | "debate";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: GtagCommand) => void;
  }
}

let enabled = false;
let configured = false;
const emitted = new Set<string>();

function gtag(...args: GtagCommand): void {
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push(args);
}

function announceState(): void {
  window.dispatchEvent(new CustomEvent(ANALYTICS_STATE_EVENT, { detail: { enabled } }));
}

export function isAnalyticsEnabled(): boolean {
  return enabled;
}

export function enableAnalytics(): void {
  if (enabled) return;
  enabled = true;
  window.gtag = gtag;

  gtag("consent", "default", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    wait_for_update: 500
  });
  gtag("set", "ads_data_redaction", true);
  gtag("consent", "update", { analytics_storage: "granted" });

  if (!configured) {
    configured = true;
    gtag("js", new Date());
    gtag("config", measurementId, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_flags: "SameSite=Lax;Secure",
      transport_type: "beacon"
    });
  }

  if (!document.getElementById(SCRIPT_ID)) {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.appendChild(script);
  }
  announceState();
}

function expireCookie(name: string, domain?: string): void {
  const domainPart = domain ? `;Domain=${domain}` : "";
  document.cookie = `${name}=;Max-Age=0;Path=/${domainPart};SameSite=Lax`;
}

export function clearGoogleAnalyticsCookies(): void {
  const names = document.cookie
    .split(";")
    .map((part) => part.split("=")[0]?.trim())
    .filter((name): name is string =>
      Boolean(name && (/^_ga(?:_|$)/.test(name) || /^_(?:gid|gat|gcl_au)$/.test(name)))
    );
  const hostname = window.location.hostname;
  const registrableDomain = hostname.endsWith("pleni.se") ? "pleni.se" : null;
  names.forEach((name) => {
    expireCookie(name);
    expireCookie(name, hostname);
    if (registrableDomain) {
      expireCookie(name, registrableDomain);
      expireCookie(name, `.${registrableDomain}`);
    }
  });
}

export function disableAnalytics(): void {
  if (enabled && window.gtag) {
    window.gtag("consent", "update", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
  }
  enabled = false;
  document.getElementById(SCRIPT_ID)?.remove();
  clearGoogleAnalyticsCookies();
  announceState();
}

function sendEvent(name: string, params: AnalyticsParams): boolean {
  if (!enabled || !window.gtag) return false;
  window.gtag("event", name, params);
  return true;
}

const TRANSLITERATION: Record<string, string> = {
  å: "a", ä: "a", ö: "o", á: "a", à: "a", é: "e", è: "e", ë: "e",
  í: "i", ó: "o", ô: "o", ú: "u", ü: "u", ø: "o", æ: "ae", ß: "ss",
  ñ: "n", ç: "c"
};

function cleanName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, "")
    .replace(/^.*ministern\s+/i, "")
    .replace(/^(Statsrådet|Ledamoten|Talmannen)\s+/i, "")
    .trim();
}

export function analyticsSlug(value: string, maxLength = 60): string {
  let out = "";
  for (const character of value.toLowerCase()) {
    out += TRANSLITERATION[character] ?? character;
  }
  return (
    out.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLength).replace(/-+$/g, "") ||
    "klipp"
  );
}

export function canonicalClipPath(clip: ClipItem): string {
  const name = cleanName(clip.politicianName ?? clip.speakerName);
  const descriptor = [name, clip.sourceTitle].filter(Boolean).join(" ");
  return `/klipp/${analyticsSlug(descriptor)}/${encodeURIComponent(clip.id)}/`;
}

function commonClipParams(
  clip: ClipItem,
  context: string,
  position?: number
): AnalyticsParams {
  return {
    clip_id: clip.id,
    feed_context: context,
    ...(position === undefined ? {} : { feed_position: position + 1 }),
    video_duration: Math.max(0, Math.round(clip.durationS))
  };
}

function once(key: string, send: () => boolean): boolean {
  if (emitted.has(key)) return false;
  if (!send()) return false;
  emitted.add(key);
  return true;
}

export function trackClipImpression(
  clip: ClipItem,
  context: string,
  position?: number
): boolean {
  if (clip.isSample) return false;
  return once(`impression:${clip.id}`, () => {
    const sent = sendEvent("clip_impression", commonClipParams(clip, context, position));
    if (!sent) return false;
    const path = canonicalClipPath(clip);
    const currentPath = window.location.pathname.endsWith("/")
      ? window.location.pathname
      : `${window.location.pathname}/`;
    if (currentPath !== path) {
      sendEvent("page_view", {
        page_title: clip.title,
        page_location: new URL(path, window.location.origin).toString(),
        page_path: path,
        content_type: "clip"
      });
    }
    return true;
  });
}

export function trackVideoStart(clip: ClipItem, context: string): boolean {
  if (clip.isSample) return false;
  return once(`start:${clip.id}`, () =>
    sendEvent("video_start", commonClipParams(clip, context))
  );
}

export function trackQualifiedView(clip: ClipItem, context: string): boolean {
  if (clip.isSample) return false;
  return once(`qualified:${clip.id}`, () =>
    sendEvent("qualified_view", {
      ...commonClipParams(clip, context),
      qualification_seconds: QUALIFIED_VIEW_WATCH_MS / 1_000
    })
  );
}

export function trackVideoProgress(
  clip: ClipItem,
  context: string,
  currentTime: number,
  duration: number
): void {
  if (clip.isSample || !Number.isFinite(duration) || duration <= 0) return;
  const percent = (currentTime / duration) * 100;
  [25, 50, 75].forEach((milestone) => {
    if (percent >= milestone) {
      once(`progress:${milestone}:${clip.id}`, () =>
        sendEvent("video_progress", {
          ...commonClipParams(clip, context),
          video_percent: milestone
        })
      );
    }
  });
}

export function trackVideoComplete(clip: ClipItem, context: string): boolean {
  if (clip.isSample) return false;
  return once(`complete:${clip.id}`, () =>
    sendEvent("video_complete", commonClipParams(clip, context))
  );
}

export function trackWatchTime(
  clip: ClipItem,
  context: string,
  watchMs: number
): boolean {
  if (clip.isSample || watchMs < 1_000) return false;
  return once(`watch:${clip.id}`, () =>
    sendEvent("watch_time", {
      ...commonClipParams(clip, context),
      watch_time_ms: Math.round(watchMs),
      watch_time_seconds: Math.round(watchMs / 100) / 10
    })
  );
}

/** Test-only reset. Kept explicit so tests never depend on module reload quirks. */
export function resetAnalyticsSessionForTests(): void {
  emitted.clear();
  enabled = false;
  configured = false;
}
