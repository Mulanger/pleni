import {
  SEARCH_EMBEDDING_DIMENSIONS,
  SEARCH_EMBEDDING_MODEL,
} from "./chunks.ts";

export const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export const MAX_OPENAI_EMBEDDING_BATCH = 128;

export interface OpenAIEmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface OpenAIEmbeddingResult {
  embeddings: number[][];
  usage: OpenAIEmbeddingUsage;
}

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export class OpenAIEmbeddingError extends Error {
  readonly code:
    | "invalid_configuration"
    | "invalid_request"
    | "provider_timeout"
    | "provider_authentication"
    | "provider_quota_exhausted"
    | "provider_rate_limited"
    | "provider_request_rejected"
    | "provider_unavailable"
    | "invalid_response";
  readonly retryable: boolean;

  constructor(
    code: OpenAIEmbeddingError["code"],
    retryable: boolean,
  ) {
    super(code);
    this.name = "OpenAIEmbeddingError";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function createOpenAIEmbeddings(
  inputs: readonly string[],
  options: OpenAIEmbeddingOptions,
): Promise<OpenAIEmbeddingResult> {
  if (!options.apiKey.trim()) {
    throw new OpenAIEmbeddingError("invalid_configuration", false);
  }
  if (
    inputs.length === 0 ||
    inputs.length > MAX_OPENAI_EMBEDDING_BATCH ||
    inputs.some((input) => input.length === 0)
  ) {
    throw new OpenAIEmbeddingError("invalid_request", false);
  }

  const endpoint = buildEndpoint(options.baseUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 20_000,
  );
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SEARCH_EMBEDDING_MODEL,
        dimensions: SEARCH_EMBEDDING_DIMENSIONS,
        encoding_format: "float",
        input: inputs,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (controller.signal.aborted || isAbortError(error)) {
      throw new OpenAIEmbeddingError("provider_timeout", true);
    }
    throw new OpenAIEmbeddingError("provider_unavailable", true);
  }

  if (!response.ok) {
    const providerErrorCode = await readProviderErrorCode(response, controller);
    clearTimeout(timeoutId);
    if (response.status === 401 || response.status === 403) {
      throw new OpenAIEmbeddingError("provider_authentication", false);
    }
    if (response.status === 429) {
      if (providerErrorCode === "insufficient_quota") {
        throw new OpenAIEmbeddingError("provider_quota_exhausted", false);
      }
      throw new OpenAIEmbeddingError("provider_rate_limited", true);
    }
    if (response.status === 408 || response.status === 409) {
      throw new OpenAIEmbeddingError("provider_unavailable", true);
    }
    if (response.status >= 400 && response.status < 500) {
      throw new OpenAIEmbeddingError("provider_request_rejected", false);
    }
    throw new OpenAIEmbeddingError("provider_unavailable", response.status >= 500);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new OpenAIEmbeddingError("provider_timeout", true);
    }
    throw new OpenAIEmbeddingError("invalid_response", true);
  } finally {
    clearTimeout(timeoutId);
  }
  return validateOpenAIEmbeddingResponse(payload, inputs.length);
}

export function validateOpenAIEmbeddingResponse(
  payload: unknown,
  expectedCount: number,
): OpenAIEmbeddingResult {
  if (!isRecord(payload)) {
    throw new OpenAIEmbeddingError("invalid_response", true);
  }
  if (payload.object !== "list" || payload.model !== SEARCH_EMBEDDING_MODEL) {
    throw new OpenAIEmbeddingError("invalid_response", true);
  }
  if (!Array.isArray(payload.data) || payload.data.length !== expectedCount) {
    throw new OpenAIEmbeddingError("invalid_response", true);
  }

  const embeddings: number[][] = [];
  for (let index = 0; index < payload.data.length; index += 1) {
    const item = payload.data[index];
    if (
      !isRecord(item) ||
      item.object !== "embedding" ||
      item.index !== index ||
      !Array.isArray(item.embedding) ||
      item.embedding.length !== SEARCH_EMBEDDING_DIMENSIONS ||
      item.embedding.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    ) {
      throw new OpenAIEmbeddingError("invalid_response", true);
    }
    embeddings.push(item.embedding as number[]);
  }

  if (!isRecord(payload.usage)) {
    throw new OpenAIEmbeddingError("invalid_response", true);
  }
  const promptTokens = payload.usage.prompt_tokens;
  const totalTokens = payload.usage.total_tokens;
  if (
    !Number.isSafeInteger(promptTokens) ||
    !Number.isSafeInteger(totalTokens) ||
    (promptTokens as number) < 0 ||
    (totalTokens as number) < (promptTokens as number)
  ) {
    throw new OpenAIEmbeddingError("invalid_response", true);
  }

  return {
    embeddings,
    usage: {
      promptTokens: promptTokens as number,
      totalTokens: totalTokens as number,
    },
  };
}

function buildEndpoint(baseUrl: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl ?? DEFAULT_OPENAI_API_BASE_URL);
  } catch {
    throw new OpenAIEmbeddingError("invalid_configuration", false);
  }
  if (parsed.protocol !== "https:") {
    throw new OpenAIEmbeddingError("invalid_configuration", false);
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/u, "")}/embeddings`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function readProviderErrorCode(
  response: Response,
  controller: AbortController,
): Promise<string | null> {
  try {
    const payload: unknown = await response.json();
    if (
      isRecord(payload) &&
      isRecord(payload.error) &&
      typeof payload.error.code === "string" &&
      /^[a-z0-9_]{1,80}$/u.test(payload.error.code)
    ) {
      return payload.error.code;
    }
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new OpenAIEmbeddingError("provider_timeout", true);
    }
  }
  return null;
}
