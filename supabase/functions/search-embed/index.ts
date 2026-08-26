import {
  createOpenAIEmbeddingProvider,
  createSupabaseSearchEmbeddingDatabase,
  processSearchEmbeddingBatch,
} from "../_shared/search/worker.ts";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, {
      Allow: "POST",
    });
  }

  const workerSecret = Deno.env.get("SEARCH_EMBED_WORKER_SECRET") ?? "";
  const suppliedSecret = request.headers.get("X-Search-Worker-Secret") ?? "";
  if (!workerSecret || !timingSafeEqual(workerSecret, suppliedSecret)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const openAIKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey || !openAIKey) {
    return jsonResponse({ error: "worker_not_configured" }, 503);
  }

  let limit = 5;
  try {
    const body = await readOptionalBody(request);
    if (body.limit !== undefined) {
      if (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 10) {
        return jsonResponse({ error: "invalid_limit" }, 400);
      }
      limit = body.limit;
    }
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  try {
    const database = createSupabaseSearchEmbeddingDatabase({
      supabaseUrl,
      serviceRoleKey,
    });
    const provider = createOpenAIEmbeddingProvider({
      apiKey: openAIKey,
      baseUrl: Deno.env.get("OPENAI_EMBEDDINGS_BASE_URL"),
      timeoutMs: 20_000,
    });
    const result = await processSearchEmbeddingBatch(database, provider, { limit });
    return jsonResponse(result, 200);
  } catch {
    return jsonResponse({ error: "worker_unavailable" }, 503);
  }
});

async function readOptionalBody(
  request: Request,
): Promise<{ limit?: number }> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  const payload: unknown = JSON.parse(text);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("invalid_json");
  }
  const keys = Object.keys(payload);
  if (keys.some((key) => key !== "limit")) {
    throw new Error("invalid_json");
  }
  return payload as { limit?: number };
}

function timingSafeEqual(expected: string, actual: string): boolean {
  let difference = expected.length ^ actual.length;
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (expected.charCodeAt(index) || 0) ^ (actual.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}
