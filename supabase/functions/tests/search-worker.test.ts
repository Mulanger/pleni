import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SEARCH_EMBEDDING_DIMENSIONS } from "../_shared/search/chunks.ts";
import {
  processSearchEmbeddingBatch,
  type CompletedSearchEmbeddingChunk,
  type FailureStatus,
  type SearchEmbeddingDatabase,
  type SearchEmbeddingJob,
  type SearchEmbeddingProvider,
} from "../_shared/search/worker.ts";

const VECTOR = Array.from({ length: SEARCH_EMBEDDING_DIMENSIONS }, () => 0.125);

test("claims, batches passages and completes one job", async () => {
  const database = new FakeDatabase([job("clip-1", "En mening. En till.")]);
  let providerCalls = 0;
  const provider: SearchEmbeddingProvider = {
    async createEmbeddings(inputs) {
      providerCalls += 1;
      return {
        embeddings: inputs.map(() => VECTOR),
        promptTokens: 9,
      };
    },
  };

  const result = await processSearchEmbeddingBatch(database, provider);
  assert.equal(providerCalls, 1);
  assert.equal(database.completed.length, 1);
  assert.equal(database.failed.length, 0);
  assert.deepEqual(result, {
    claimed: 1,
    completed: 1,
    retried: 0,
    failed: 0,
    stale: 0,
    promptTokens: 9,
  });
  const chunks = database.completed[0].chunks;
  assert.equal(chunks[0].embedding.length, 1024);
  assert.match(chunks[0].contentHash, /^[0-9a-f]{64}$/u);
});

test("one failed job does not prevent another claimed job from completing", async () => {
  const database = new FakeDatabase([
    job("clip-fail", "fel."),
    job("clip-good", "fungerar."),
  ]);
  const provider: SearchEmbeddingProvider = {
    async createEmbeddings(inputs) {
      if (inputs.some((input) => input.includes("fel"))) {
        throw new Error("provider details must not be stored");
      }
      return { embeddings: inputs.map(() => VECTOR), promptTokens: 4 };
    },
  };

  const result = await processSearchEmbeddingBatch(database, provider);
  assert.equal(database.completed[0].job.clipId, "clip-good");
  assert.deepEqual(database.failed[0], {
    job: database.jobs[0],
    errorCode: "worker_error",
    retryable: true,
  });
  assert.equal(result.completed, 1);
  assert.equal(result.retried, 1);
});

test("wrong dimensions fail validation before database replacement", async () => {
  const database = new FakeDatabase([job("clip-bad-vector", "Text.")], "failed");
  const provider: SearchEmbeddingProvider = {
    async createEmbeddings(inputs) {
      return { embeddings: inputs.map(() => [1, 2]), promptTokens: 2 };
    },
  };

  const result = await processSearchEmbeddingBatch(database, provider);
  assert.equal(database.completed.length, 0);
  assert.equal(database.failed[0].errorCode, "provider_response_invalid");
  assert.equal(database.failed[0].retryable, true);
  assert.equal(result.failed, 1);
});

test("does not call the provider when the provider-off claim returns no jobs", async () => {
  const database = new FakeDatabase([]);
  const provider: SearchEmbeddingProvider = {
    async createEmbeddings() {
      throw new Error("must not be called");
    },
  };
  assert.deepEqual(await processSearchEmbeddingBatch(database, provider), {
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    stale: 0,
    promptTokens: 0,
  });
});

test("migration 024 locks queue, retry, vector, privacy and no-backfill behavior", () => {
  const up = readFileSync(
    new URL("../../../migrations/024_search_embeddings.up.sql", import.meta.url),
    "utf8",
  );
  const down = readFileSync(
    new URL("../../../migrations/024_search_embeddings.down.sql", import.meta.url),
    "utf8",
  );

  assert.match(up, /embedding extensions\.halfvec\(1024\)/iu);
  assert.match(up, /using hnsw \(embedding extensions\.halfvec_cosine_ops\)/iu);
  assert.match(up, /pgmq\.create\('search_embeddings'\)/iu);
  assert.match(up, /pgmq\.read\(/iu);
  assert.match(up, /pgmq\.set_vt\(/iu);
  assert.match(up, /message_read_count >= 5/iu);
  assert.match(up, /pgmq\.archive\(/iu);
  assert.match(up, /delete from private\.clip_search_chunks[\s\S]+insert into private\.clip_search_chunks/iu);
  assert.match(up, /semantic_index_version = 'openai:text-embedding-3-large:1024:v1'/iu);
  assert.match(up, /provider_enabled = false/iu);
  assert.match(up, /provider_kill_switch = true/iu);
  assert.match(up, /clip_search_documents_queue_embedding/iu);
  assert.match(up, /search_embed_worker_secret/iu);
  assert.doesNotMatch(up, /insert into pgmq\.q_search_embeddings[\s\S]+select[\s\S]+clip_search_documents/iu);
  assert.doesNotMatch(
    up,
    /grant\s+(?:select|insert|update|delete|execute)[\s\S]{0,100}\b(?:anon|authenticated)\b/iu,
  );
  assert.match(down, /drop_queue\('search_embeddings'\)/iu);
  assert.match(down, /semantic_index_version = null/iu);
});

test("migration 025 repairs applied runtime expressions without editing 024", () => {
  const up = readFileSync(
    new URL(
      "../../../migrations/025_search_embeddings_runtime_fix.up.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const down = readFileSync(
    new URL(
      "../../../migrations/025_search_embeddings_runtime_fix.down.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(up, /82eddffc99a29f8fe81858c13d910f0c138a9f3a590cf0d4d0ce38e55fc5aa58/iu);
  assert.match(up, /pg_catalog\.pg_get_functiondef/iu);
  assert.match(up, /'pg_catalog\.greatest',\s*'greatest'/iu);
  assert.match(up, /'pg_catalog\.least',\s*'least'/iu);
  assert.match(up, /provider-off claim runtime check/iu);
  assert.match(down, /'greatest', 'pg_catalog\.greatest'/iu);
  assert.match(down, /'least',\s*'pg_catalog\.least'/iu);
});

class FakeDatabase implements SearchEmbeddingDatabase {
  readonly jobs: SearchEmbeddingJob[];
  private readonly failureStatus: FailureStatus;
  readonly completed: Array<{
    job: SearchEmbeddingJob;
    chunks: readonly CompletedSearchEmbeddingChunk[];
  }> = [];
  readonly failed: Array<{
    job: SearchEmbeddingJob;
    errorCode: string;
    retryable: boolean;
  }> = [];

  constructor(
    jobs: SearchEmbeddingJob[],
    failureStatus: FailureStatus = "retry_scheduled",
  ) {
    this.jobs = jobs;
    this.failureStatus = failureStatus;
  }

  async claim(): Promise<SearchEmbeddingJob[]> {
    return this.jobs;
  }

  async complete(
    claimedJob: SearchEmbeddingJob,
    chunks: readonly CompletedSearchEmbeddingChunk[],
  ): Promise<"completed"> {
    this.completed.push({ job: claimedJob, chunks });
    return "completed";
  }

  async fail(
    claimedJob: SearchEmbeddingJob,
    errorCode: string,
    retryable: boolean,
  ): Promise<FailureStatus> {
    this.failed.push({ job: claimedJob, errorCode, retryable });
    return this.failureStatus;
  }
}

function job(clipId: string, transcript: string): SearchEmbeddingJob {
  return {
    messageId: clipId === "clip-fail" ? 1 : 2,
    attempt: 1,
    clipId,
    sourceHash: "a".repeat(64),
    indexVersion: "openai:text-embedding-3-large:1024:v1",
    title: "Titel",
    transcript,
  };
}
