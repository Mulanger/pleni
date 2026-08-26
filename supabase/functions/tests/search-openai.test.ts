import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAIEmbeddings,
  OpenAIEmbeddingError,
  validateOpenAIEmbeddingResponse,
} from "../_shared/search/openai.ts";
import {
  SEARCH_EMBEDDING_DIMENSIONS,
  SEARCH_EMBEDDING_MODEL,
} from "../_shared/search/chunks.ts";

const VECTOR = Array.from(
  { length: SEARCH_EMBEDDING_DIMENSIONS },
  (_, index) => index / SEARCH_EMBEDDING_DIMENSIONS,
);

test("sends the locked model and 1024 dimensions in one batched request", async () => {
  let captured: Record<string, unknown> | null = null;
  const fetcher: typeof fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(validPayload(2)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await createOpenAIEmbeddings(["ett", "två"], {
    apiKey: "test-key",
    fetcher,
  });
  assert.deepEqual(captured, {
    model: SEARCH_EMBEDDING_MODEL,
    dimensions: 1024,
    encoding_format: "float",
    input: ["ett", "två"],
  });
  assert.equal(result.embeddings.length, 2);
  assert.deepEqual(result.usage, { promptTokens: 12, totalTokens: 12 });
});

for (const [label, payload, expectedCount] of [
  ["wrong item count", validPayload(1), 2],
  [
    "wrong dimension",
    {
      ...validPayload(1),
      data: [{ object: "embedding", index: 0, embedding: [0, 1] }],
    },
    1,
  ],
  [
    "wrong order",
    {
      ...validPayload(2),
      data: [
        { object: "embedding", index: 1, embedding: VECTOR },
        { object: "embedding", index: 0, embedding: VECTOR },
      ],
    },
    2,
  ],
  [
    "non-finite value",
    {
      ...validPayload(1),
      data: [
        {
          object: "embedding",
          index: 0,
          embedding: [Number.POSITIVE_INFINITY, ...VECTOR.slice(1)],
        },
      ],
    },
    1,
  ],
  ["unexpected model", { ...validPayload(1), model: "different-model" }, 1],
] as const) {
  test(`rejects ${label}`, () => {
    assert.throws(
      () => validateOpenAIEmbeddingResponse(payload, expectedCount),
      (error) =>
        error instanceof OpenAIEmbeddingError && error.code === "invalid_response",
    );
  });
}

test("classifies provider throttling as retryable without returning provider content", async () => {
  await assert.rejects(
    createOpenAIEmbeddings(["skatt"], {
      apiKey: "test-key",
      fetcher: async () => new Response("sensitive provider body", { status: 429 }),
    }),
    (error) =>
      error instanceof OpenAIEmbeddingError &&
      error.code === "provider_rate_limited" &&
      error.retryable,
  );
});

test("classifies insufficient quota separately from a temporary rate limit", async () => {
  await assert.rejects(
    createOpenAIEmbeddings(["skatt"], {
      apiKey: "test-key",
      fetcher: async () =>
        new Response(
          JSON.stringify({
            error: { code: "insufficient_quota", message: "must not escape" },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
    }),
    (error) =>
      error instanceof OpenAIEmbeddingError &&
      error.code === "provider_quota_exhausted" &&
      !error.retryable,
  );
});

test("classifies an invalid provider credential as non-retryable", async () => {
  await assert.rejects(
    createOpenAIEmbeddings(["skatt"], {
      apiKey: "test-key",
      fetcher: async () => new Response("credential detail", { status: 401 }),
    }),
    (error) =>
      error instanceof OpenAIEmbeddingError &&
      error.code === "provider_authentication" &&
      !error.retryable,
  );
});

test("classifies a rejected request without exposing its response body", async () => {
  await assert.rejects(
    createOpenAIEmbeddings(["skatt"], {
      apiKey: "test-key",
      fetcher: async () => new Response("request detail", { status: 400 }),
    }),
    (error) =>
      error instanceof OpenAIEmbeddingError &&
      error.code === "provider_request_rejected" &&
      !error.retryable,
  );
});

test("aborts a timed-out provider call", async () => {
  const fetcher: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  await assert.rejects(
    createOpenAIEmbeddings(["budget"], {
      apiKey: "test-key",
      fetcher,
      timeoutMs: 5,
    }),
    (error) =>
      error instanceof OpenAIEmbeddingError &&
      error.code === "provider_timeout" &&
      error.retryable,
  );
});

test("keeps the timeout active while reading the provider response body", async () => {
  const fetcher: typeof fetch = async (_input, init) =>
    ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    }) as Response;

  await assert.rejects(
    createOpenAIEmbeddings(["välfärd"], {
      apiKey: "test-key",
      fetcher,
      timeoutMs: 5,
    }),
    (error) =>
      error instanceof OpenAIEmbeddingError &&
      error.code === "provider_timeout" &&
      error.retryable,
  );
});

function validPayload(count: number): Record<string, unknown> {
  return {
    object: "list",
    model: SEARCH_EMBEDDING_MODEL,
    data: Array.from({ length: count }, (_, index) => ({
      object: "embedding",
      index,
      embedding: VECTOR,
    })),
    usage: { prompt_tokens: 12, total_tokens: 12 },
  };
}
