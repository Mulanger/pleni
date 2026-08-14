/// <reference lib="webworker" />

export {};

type PrecacheEntry = string | { revision?: string | null; url: string };

declare global {
  interface Window {
    __WB_MANIFEST: PrecacheEntry[];
  }
}

const worker = self as unknown as ServiceWorkerGlobalScope;
const PRECACHE_MANIFEST = self.__WB_MANIFEST;
const CACHE_PREFIX = "pleni-";
const WORKER_RELEASE = "ui14-navigation-cache-1";
const ACTIVATE_UPDATE_MESSAGE = "SKIP_WAITING";

function entryUrl(entry: PrecacheEntry): string {
  return typeof entry === "string" ? entry : entry.url;
}

function manifestFingerprint(entries: PrecacheEntry[]): string {
  const identity = JSON.stringify(entries);
  let hash = 2166136261;

  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

const PRECACHE_NAME =
  `${CACHE_PREFIX}precache-${manifestFingerprint(PRECACHE_MANIFEST)}-${WORKER_RELEASE}`;
const PRECACHE_URLS = PRECACHE_MANIFEST.map((entry) =>
  new URL(entryUrl(entry), worker.registration.scope).href
);
const PRECACHE_URL_SET = new Set(PRECACHE_URLS);
const NAVIGATION_FALLBACK_URL = PRECACHE_URLS.find(
  (url) => new URL(url).pathname === "/index.html"
);

function isMediaRequest(request: Request, url: URL): boolean {
  const mediaExtensions = [".mp4", ".webm", ".m3u8", ".m4v", ".mov"];
  return (
    request.destination === "video" ||
    request.destination === "audio" ||
    request.headers.has("range") ||
    mediaExtensions.some((extension) => url.pathname.toLowerCase().endsWith(extension))
  );
}

function shouldBypass(request: Request, url: URL): boolean {
  return (
    request.method !== "GET" ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== worker.location.origin ||
    isMediaRequest(request, url)
  );
}

async function cacheFirstPrecached(request: Request): Promise<Response> {
  const cache = await caches.open(PRECACHE_NAME);
  const cached = await cache.match(request.url);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request.url, response.clone());
  }
  return response;
}

async function networkFirstNavigation(request: Request): Promise<Response> {
  try {
    // The static host does not send Cache-Control on index.html and removes old
    // hashed assets during a deploy. Never let the browser HTTP cache hand this
    // worker an older HTML shell that points at an asset the host has removed.
    return await fetch(request, { cache: "no-store" });
  } catch {
    if (NAVIGATION_FALLBACK_URL) {
      const cache = await caches.open(PRECACHE_NAME);
      const fallback = await cache.match(NAVIGATION_FALLBACK_URL);
      if (fallback) {
        return fallback;
      }
    }

    return new Response("Pleni kan inte öppnas utan nätverk ännu.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

worker.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(PRECACHE_NAME).then((cache) =>
      cache.addAll(
        PRECACHE_URLS.map(
          (url) => new Request(url, { cache: "reload", credentials: "same-origin" })
        )
      )
    )
  );
});

worker.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== PRECACHE_NAME)
            .map((name) => caches.delete(name))
        )
      ),
      worker.clients.claim()
    ])
  );
});

worker.addEventListener("message", (event: ExtendableMessageEvent) => {
  if (event.data?.type === ACTIVATE_UPDATE_MESSAGE) {
    event.waitUntil(worker.skipWaiting());
  }
});

worker.addEventListener("fetch", (event: FetchEvent) => {
  const request = event.request;
  const url = new URL(request.url);

  if (shouldBypass(request, url)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (PRECACHE_URL_SET.has(url.href)) {
    event.respondWith(cacheFirstPrecached(request));
  }
});
