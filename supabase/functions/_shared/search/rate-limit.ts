export interface SearchRateLimitDecision {
  allowed: boolean;
  reason: string | null;
  retryAfterSeconds: number;
}

export function searchClientAddress(request: Request): string {
  const forwarded = request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim();
  const value =
    request.headers.get("CF-Connecting-IP")?.trim() ||
    forwarded ||
    request.headers.get("X-Real-IP")?.trim() ||
    "unknown";
  return value.slice(0, 512);
}

export async function dailySearchClientKey(
  address: string,
  secret: string,
  now = new Date(),
): Promise<string> {
  if (secret.length < 32) throw new Error("rate_limit_not_configured");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const utcDay = now.toISOString().slice(0, 10);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${utcDay}\n${address}`),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseSearchRateLimitDecision(value: unknown): SearchRateLimitDecision {
  if (!isRecord(value) || typeof value.allowed !== "boolean") {
    throw new Error("invalid_rate_limit_response");
  }
  const reason = value.reason;
  const retry = value.retryAfterSeconds;
  if (
    reason !== null && typeof reason !== "string" ||
    !Number.isSafeInteger(retry) ||
    (retry as number) < 0
  ) {
    throw new Error("invalid_rate_limit_response");
  }
  return {
    allowed: value.allowed,
    reason: reason as string | null,
    retryAfterSeconds: retry as number,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
