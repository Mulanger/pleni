export class ServiceDatabaseError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(
    status: number,
    code: string,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.name = "ServiceDatabaseError";
  }
}

function serviceConfig(): { url: string; key: string } {
  const url = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) {
    throw new ServiceDatabaseError(500, "service_not_configured", "Missing Supabase service configuration");
  }
  return { url, key };
}

async function errorDetail(response: Response): Promise<{ code: string; detail: string }> {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : "database_error",
      detail:
        typeof value.message === "string"
          ? value.message
          : typeof value.details === "string"
            ? value.details
            : text.slice(0, 300)
    };
  } catch {
    return { code: "database_error", detail: text.slice(0, 300) };
  }
}

export async function callServiceRpc<T>(
  name: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const { url, key } = serviceConfig();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    const error = await errorDetail(response);
    throw new ServiceDatabaseError(response.status, error.code, error.detail);
  }
  return (await response.json()) as T;
}

export async function loadFeedCatalogue(limit: number, signal?: AbortSignal): Promise<unknown[]> {
  const { url, key } = serviceConfig();
  const params = new URLSearchParams({
    select: "*",
    order: "debate_date.desc,published_at.desc,id.asc",
    limit: String(Math.min(Math.max(limit, 1), 1000))
  });
  const response = await fetch(`${url}/rest/v1/feed_clip_catalogue?${params.toString()}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal
  });
  if (!response.ok) {
    const error = await errorDetail(response);
    throw new ServiceDatabaseError(response.status, error.code, error.detail);
  }
  return (await response.json()) as unknown[];
}

function inFilter(values: string[]): string {
  return `(${values.map((value) => `"${value.replace(/"/g, "")}"`).join(",")})`;
}

export async function loadInterestCatalogue(
  parties: string[],
  politicianIds: string[],
  limit: number,
  signal?: AbortSignal
): Promise<unknown[]> {
  if (parties.length === 0 && politicianIds.length === 0) {
    return [];
  }
  const filters: string[] = [];
  if (parties.length > 0) filters.push(`party.in.${inFilter(parties)}`);
  if (politicianIds.length > 0) {
    filters.push(`politician_id.in.${inFilter(politicianIds)}`);
  }
  const { url, key } = serviceConfig();
  const params = new URLSearchParams({
    select: "*",
    or: `(${filters.join(",")})`,
    order: "debate_date.desc,published_at.desc,id.asc",
    limit: String(Math.min(Math.max(limit, 1), 1000))
  });
  const response = await fetch(`${url}/rest/v1/feed_clip_catalogue?${params.toString()}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal
  });
  if (!response.ok) {
    const error = await errorDetail(response);
    throw new ServiceDatabaseError(response.status, error.code, error.detail);
  }
  return (await response.json()) as unknown[];
}
