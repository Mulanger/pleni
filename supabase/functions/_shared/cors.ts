export const DEFAULT_ALLOWED_ORIGINS = [
  "https://pleni.se",
  "https://www.pleni.se",
  "https://rikettv.nbg1-3.instapods.app",
  "http://127.0.0.1:5199",
  "http://localhost:5199"
] as const;

export function allowedOrigins(value: string | undefined): Set<string> {
  const configured = value
    ?.split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return new Set(configured?.length ? configured : DEFAULT_ALLOWED_ORIGINS);
}

export function corsHeaders(origin: string | null, allowed: ReadonlySet<string>): Headers | null {
  if (!origin || !allowed.has(origin.replace(/\/$/, ""))) {
    return null;
  }
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  });
}

export function jsonResponse(
  body: unknown,
  status: number,
  cors: Headers,
  extra?: HeadersInit
): Response {
  const headers = new Headers(cors);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (extra) {
    new Headers(extra).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}
