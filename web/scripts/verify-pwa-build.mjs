import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(webRoot, "dist");

function fail(message) {
  throw new Error(`PWA build verification failed: ${message}`);
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`${label} is missing at ${relative(webRoot, path)}`);
  }
  return readFileSync(path, "utf8");
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

const indexHtml = requireFile(join(distRoot, "index.html"), "production index");
const manifestSource = requireFile(
  join(distRoot, "manifest.json"),
  "web app manifest"
);
const serviceWorkerSource = requireFile(join(distRoot, "sw.js"), "service worker");
const manifest = JSON.parse(manifestSource);

if (manifest.display !== "standalone") {
  fail("manifest display is not standalone");
}
if (!indexHtml.includes('rel="manifest"') || !indexHtml.includes("/manifest.json")) {
  fail("production index does not link the manifest");
}
if (serviceWorkerSource.includes("self.__WB_MANIFEST")) {
  fail("service worker still contains an uninjected precache placeholder");
}
if (!serviceWorkerSource.includes("SKIP_WAITING")) {
  fail("service worker has no viewer-controlled activation message");
}
if (
  !/addEventListener\("message",[\s\S]{0,300}skipWaiting\(\)/.test(
    serviceWorkerSource
  ) ||
  /addEventListener\("install",[\s\S]{0,500}skipWaiting\(\)/.test(
    serviceWorkerSource
  )
) {
  fail("service worker activation is not restricted to the update message");
}
if (
  !serviceWorkerSource.includes('CACHE_PREFIX = "pleni-"') ||
  !serviceWorkerSource.includes("precache-")
) {
  fail("service worker has no versioned Pleni cache name");
}

const requiredBypassFragments = [
  'request.method !== "GET"',
  'request.destination === "video"',
  'request.headers.has("range")',
  "url.origin !== worker.location.origin"
];
for (const fragment of requiredBypassFragments) {
  if (!serviceWorkerSource.includes(fragment)) {
    fail(`service worker is missing bypass guard: ${fragment}`);
  }
}

const precacheMatch = serviceWorkerSource.match(
  /(?:const|let|var) PRECACHE_MANIFEST = (\[[\s\S]*?\]);/
);
if (!precacheMatch) {
  fail("cannot inspect the injected precache manifest");
}

const precacheEntries = JSON.parse(precacheMatch[1]);
const precacheUrls = precacheEntries.map((entry) =>
  typeof entry === "string" ? entry : entry.url
);
const forbiddenPrecache =
  /(?:\.(?:mp4|webm|m3u8)(?:$|[?#])|b-cdn|supabase|clerk)/i;
const forbiddenUrl = precacheUrls.find((url) => forbiddenPrecache.test(url));
if (forbiddenUrl) {
  fail(`forbidden media or private origin entered precache: ${forbiddenUrl}`);
}
if (!precacheUrls.some((url) => url.endsWith("index.html"))) {
  fail("offline navigation shell is absent from precache");
}
if (!precacheUrls.some((url) => url.endsWith(".js"))) {
  fail("revisioned JavaScript bundle is absent from precache");
}
if (!precacheUrls.some((url) => url.endsWith(".css"))) {
  fail("revisioned CSS bundle is absent from precache");
}

const appJavaScript = filesBelow(join(distRoot, "assets"))
  .filter((path) => path.endsWith(".js"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
if (!appJavaScript.includes("serviceWorker") || !appJavaScript.includes("sw.js")) {
  fail("production application bundle does not contain explicit worker registration");
}

function requestUrl(request) {
  return typeof request === "string" ? request : request.url;
}

async function verifyServiceWorkerRuntime() {
  const handlers = new Map();
  const cacheStores = new Map();
  let networkAvailable = true;
  let claimCount = 0;
  let skipWaitingCount = 0;

  async function networkFetch(request) {
    if (!networkAvailable) {
      throw new TypeError("Simulated offline network");
    }
    return new Response(`network:${requestUrl(request)}`, { status: 200 });
  }

  class MemoryCache {
    records = new Map();

    async addAll(requests) {
      for (const request of requests) {
        const response = await networkFetch(request);
        this.records.set(requestUrl(request), response.clone());
      }
    }

    async match(request) {
      return this.records.get(requestUrl(request))?.clone();
    }

    async put(request, response) {
      this.records.set(requestUrl(request), response.clone());
    }
  }

  const cacheStorage = {
    async delete(name) {
      return cacheStores.delete(name);
    },
    async keys() {
      return [...cacheStores.keys()];
    },
    async open(name) {
      if (!cacheStores.has(name)) {
        cacheStores.set(name, new MemoryCache());
      }
      return cacheStores.get(name);
    }
  };

  const serviceWorkerGlobal = {
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    clients: {
      async claim() {
        claimCount += 1;
      }
    },
    location: { origin: "https://pleni.test" },
    registration: { scope: "https://pleni.test/" },
    async skipWaiting() {
      skipWaitingCount += 1;
    }
  };

  runInNewContext(serviceWorkerSource, {
    Headers,
    JSON,
    Math,
    Promise,
    Request,
    Response,
    Set,
    URL,
    caches: cacheStorage,
    console,
    fetch: networkFetch,
    self: serviceWorkerGlobal
  });

  async function dispatchExtendable(type, values = {}) {
    const handler = handlers.get(type);
    if (!handler) {
      fail(`built worker did not register a ${type} handler`);
    }
    let pending = null;
    handler({
      ...values,
      waitUntil(value) {
        pending = Promise.resolve(value);
      }
    });
    if (!pending) {
      fail(`${type} handler did not extend its lifetime`);
    }
    await pending;
  }

  async function dispatchFetch(request) {
    const handler = handlers.get("fetch");
    if (!handler) {
      fail("built worker did not register a fetch handler");
    }
    let pending = null;
    handler({
      request,
      respondWith(value) {
        pending = Promise.resolve(value);
      }
    });
    return pending ? pending : null;
  }

  await dispatchExtendable("install");
  const cacheNamesAfterInstall = await cacheStorage.keys();
  const activeCacheName = cacheNamesAfterInstall.find((name) =>
    name.startsWith("pleni-precache-")
  );
  if (!activeCacheName || skipWaitingCount !== 0) {
    fail("install did not create a versioned cache or activated without consent");
  }
  const activeCache = await cacheStorage.open(activeCacheName);
  if (activeCache.records.size !== precacheUrls.length) {
    fail("install did not cache every injected app-shell entry");
  }

  cacheStores.set("pleni-precache-obsolete", new MemoryCache());
  cacheStores.set("unrelated-cache", new MemoryCache());
  await dispatchExtendable("activate");
  const cacheNamesAfterActivation = await cacheStorage.keys();
  if (
    cacheNamesAfterActivation.includes("pleni-precache-obsolete") ||
    !cacheNamesAfterActivation.includes("unrelated-cache") ||
    claimCount !== 1
  ) {
    fail("activation did not selectively clean Pleni caches and claim clients");
  }

  const sameOriginScript = new URL(
    precacheUrls.find((url) => url.endsWith(".js")),
    serviceWorkerGlobal.registration.scope
  ).href;
  networkAvailable = false;
  const cachedScript = await dispatchFetch(new Request(sameOriginScript));
  if (!cachedScript || !(await cachedScript).ok) {
    fail("precache assets are not served cache first while offline");
  }

  const offlineNavigation = await dispatchFetch({
    destination: "document",
    headers: new Headers(),
    method: "GET",
    mode: "navigate",
    url: "https://pleni.test/#profile"
  });
  if (!offlineNavigation || !(await offlineNavigation).ok) {
    fail("offline navigation did not fall back to the app shell");
  }

  const bypassRequests = [
    {
      destination: "video",
      headers: new Headers({ Range: "bytes=0-1023" }),
      method: "GET",
      mode: "cors",
      url: "https://riketnlooigm.b-cdn.net/clips/example.mp4"
    },
    {
      destination: "",
      headers: new Headers(),
      method: "GET",
      mode: "cors",
      url: "https://example.supabase.co/rest/v1/clips"
    },
    {
      destination: "",
      headers: new Headers(),
      method: "POST",
      mode: "same-origin",
      url: "https://pleni.test/api/event"
    }
  ];
  for (const request of bypassRequests) {
    if ((await dispatchFetch(request)) !== null) {
      fail(`worker intercepted a bypassed request: ${request.url}`);
    }
  }

  await dispatchExtendable("message", { data: { type: "SKIP_WAITING" } });
  if (skipWaitingCount !== 1) {
    fail("viewer activation message did not release the waiting worker");
  }
}

await verifyServiceWorkerRuntime();

console.log(
  `PWA build verified: ${precacheUrls.length} app-shell entries, offline lifecycle green, no video/private data.`
);
