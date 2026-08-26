import type { ClipSearchRequest, ClipSearchResponse } from "./types";

export type TopicSearchApiErrorKind =
  | "not_configured"
  | "rate_limited"
  | "unavailable"
  | "rejected"
  | "invalid_response"
  | "network";

export class TopicSearchApiError extends Error {
  readonly kind: TopicSearchApiErrorKind;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: TopicSearchApiErrorKind,
    message: string,
    options: { status?: number; retryAfterSeconds?: number } = {}
  ) {
    super(message);
    this.name = "TopicSearchApiError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export interface TopicSearchClientOptions {
  supabaseUrl: string;
  publishableKey: string;
  fetcher?: typeof fetch;
  parseRequest: (value: unknown) => ClipSearchRequest;
  parseResponse: (value: unknown) => ClipSearchResponse;
}

/**
 * Create the browser's anonymous topic-search client.
 *
 * The endpoint URL is fixed. The transient query is carried only in the POST
 * body, never in a URL, browser cache key or persistent client store.
 */
export function createTopicSearchClient(options: TopicSearchClientOptions) {
  const baseUrl = options.supabaseUrl.trim().replace(/\/$/, "");
  const publishableKey = options.publishableKey.trim();
  const fetcher = options.fetcher ?? fetch;
  const parseRequest = options.parseRequest;
  const parseResponse = options.parseResponse;
  const endpoint = `${baseUrl}/functions/v1/clip-search`;

  return async function searchTopic(
    request: ClipSearchRequest,
    signal?: AbortSignal
  ): Promise<ClipSearchResponse> {
    if (!baseUrl || !publishableKey) {
      throw new TopicSearchApiError(
        "not_configured",
        "Topic search is not configured in this build"
      );
    }

    const parsedRequest = parseRequest(request);
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          apikey: publishableKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(parsedRequest),
        signal
      });
    } catch (error: unknown) {
      if (isAbortError(error) || signal?.aborted) {
        throw error;
      }
      throw new TopicSearchApiError("network", "Topic search could not be reached");
    }

    if (!response.ok) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
      if (response.status === 429) {
        throw new TopicSearchApiError("rate_limited", "Topic search is temporarily busy", {
          status: response.status,
          ...(retryAfterSeconds === null ? {} : { retryAfterSeconds })
        });
      }
      if (response.status >= 500) {
        throw new TopicSearchApiError("unavailable", "Topic search is temporarily unavailable", {
          status: response.status
        });
      }
      throw new TopicSearchApiError("rejected", "Topic search rejected the request", {
        status: response.status
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
      return parseResponse(payload);
    } catch (error: unknown) {
      throw new TopicSearchApiError(
        "invalid_response",
        "Topic search returned an invalid response",
        { status: response.status }
      );
    }
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value.trim())) {
    return null;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}
