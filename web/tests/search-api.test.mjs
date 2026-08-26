import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TopicSearchApiError,
  createTopicSearchClient,
} from "../src/search/api.ts";
import {
  parseClipSearchRequest,
  parseClipSearchResponse,
} from "../src/search/types.ts";

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/search-contract/valid.json", import.meta.url), "utf8"),
);

function clientOptions(overrides = {}) {
  return {
    supabaseUrl: "https://project.supabase.co",
    publishableKey: "publishable-test-key",
    parseRequest: parseClipSearchRequest,
    parseResponse: parseClipSearchResponse,
    ...overrides,
  };
}

test("topic search posts the transient query to a fixed Function URL", async () => {
  const calls = [];
  const client = createTopicSearchClient(clientOptions({
    supabaseUrl: "https://project.supabase.co/",
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return Response.json(fixtures.responses[0]);
    },
  }));

  const result = await client({
    query: "  magdalena andersson skatter 2017  ",
    limit: 60,
  });

  assert.equal(result.mode, "hybrid");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://project.supabase.co/functions/v1/clip-search");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.apikey, "publishable-test-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: "magdalena andersson skatter 2017",
    limit: 60,
  });
  assert.equal(String(calls[0].url).includes("magdalena"), false);
  assert.equal(String(calls[0].url).includes("?"), false);
});

test("topic search classifies rate limits without reading or exposing the response body", async () => {
  const client = createTopicSearchClient(clientOptions({
    fetcher: async () =>
      new Response("private provider detail", {
        status: 429,
        headers: { "Retry-After": "17" },
      }),
  }));

  await assert.rejects(
    client({ query: "elsparkcyklar" }),
    (error) => {
      assert.ok(error instanceof TopicSearchApiError);
      assert.equal(error.kind, "rate_limited");
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterSeconds, 17);
      assert.equal(error.message.includes("private provider detail"), false);
      return true;
    },
  );
});

test("topic search rejects malformed success payloads at the browser boundary", async () => {
  const client = createTopicSearchClient(clientOptions({
    fetcher: async () => Response.json({ mode: "hybrid", results: [] }),
  }));

  await assert.rejects(
    client({ query: "skatter" }),
    (error) => error instanceof TopicSearchApiError && error.kind === "invalid_response",
  );
});

test("topic search preserves AbortError so stale submissions stay silent", async () => {
  const client = createTopicSearchClient(clientOptions({
    fetcher: async () => {
      throw new DOMException("aborted", "AbortError");
    },
  }));

  await assert.rejects(client({ query: "skatter" }), { name: "AbortError" });
});

test("an unconfigured build fails before any network request", async () => {
  let calls = 0;
  const client = createTopicSearchClient(clientOptions({
    supabaseUrl: "",
    publishableKey: "",
    fetcher: async () => {
      calls += 1;
      return Response.json(fixtures.responses[0]);
    },
  }));

  await assert.rejects(
    client({ query: "skatter" }),
    (error) => error instanceof TopicSearchApiError && error.kind === "not_configured",
  );
  assert.equal(calls, 0);
});
