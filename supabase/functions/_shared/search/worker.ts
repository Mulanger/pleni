import {
  buildSearchEmbeddingPassages,
  SEARCH_EMBEDDING_DIMENSIONS,
  type SearchEmbeddingPassage,
} from "./chunks.ts";
import {
  createOpenAIEmbeddings,
  MAX_OPENAI_EMBEDDING_BATCH,
  OpenAIEmbeddingError,
  type OpenAIEmbeddingOptions,
} from "./openai.ts";

export interface SearchEmbeddingJob {
  messageId: number;
  attempt: number;
  clipId: string;
  sourceHash: string;
  indexVersion: string;
  title: string;
  transcript: string;
}

export interface CompletedSearchEmbeddingChunk
  extends Omit<SearchEmbeddingPassage, "embeddingInput"> {
  embedding: number[];
}

export type CompletionStatus = "completed" | "stale" | "missing";
export type FailureStatus = "retry_scheduled" | "failed" | "stale" | "missing";

export interface SearchEmbeddingDatabase {
  claim(limit: number, visibilityTimeoutSeconds: number): Promise<SearchEmbeddingJob[]>;
  complete(
    job: SearchEmbeddingJob,
    chunks: readonly CompletedSearchEmbeddingChunk[],
  ): Promise<CompletionStatus>;
  fail(
    job: SearchEmbeddingJob,
    errorCode: string,
    retryable: boolean,
  ): Promise<FailureStatus>;
}

export interface SearchEmbeddingProvider {
  createEmbeddings(inputs: readonly string[]): Promise<{
    embeddings: number[][];
    promptTokens: number;
  }>;
}

export interface SearchEmbeddingBatchOptions {
  limit?: number;
  visibilityTimeoutSeconds?: number;
  providerBatchSize?: number;
}

export interface SearchEmbeddingBatchResult {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  stale: number;
  promptTokens: number;
}

export interface SupabaseSearchEmbeddingDatabaseOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetcher?: typeof fetch;
}

export async function processSearchEmbeddingBatch(
  database: SearchEmbeddingDatabase,
  provider: SearchEmbeddingProvider,
  options: SearchEmbeddingBatchOptions = {},
): Promise<SearchEmbeddingBatchResult> {
  const limit = clampInteger(options.limit ?? 5, 1, 10);
  const visibilityTimeoutSeconds = clampInteger(
    options.visibilityTimeoutSeconds ?? 120,
    30,
    900,
  );
  const providerBatchSize = clampInteger(
    options.providerBatchSize ?? MAX_OPENAI_EMBEDDING_BATCH,
    1,
    MAX_OPENAI_EMBEDDING_BATCH,
  );
  const jobs = await database.claim(limit, visibilityTimeoutSeconds);
  const result: SearchEmbeddingBatchResult = {
    claimed: jobs.length,
    completed: 0,
    retried: 0,
    failed: 0,
    stale: 0,
    promptTokens: 0,
  };

  for (const job of jobs) {
    try {
      const passages = await buildSearchEmbeddingPassages(
        { title: job.title, transcript: job.transcript },
        job.indexVersion,
      );
      const embeddings: number[][] = [];
      for (let offset = 0; offset < passages.length; offset += providerBatchSize) {
        const batch = passages.slice(offset, offset + providerBatchSize);
        const providerResult = await provider.createEmbeddings(
          batch.map((passage) => passage.embeddingInput),
        );
        validateWorkerEmbeddings(providerResult.embeddings, batch.length);
        embeddings.push(...providerResult.embeddings);
        result.promptTokens += providerResult.promptTokens;
      }

      const completion = await database.complete(
        job,
        passages.map((passage, index) => ({
          chunkNo: passage.chunkNo,
          passage: passage.passage,
          charStart: passage.charStart,
          charEnd: passage.charEnd,
          contentHash: passage.contentHash,
          embedding: embeddings[index],
        })),
      );
      if (completion === "completed") {
        result.completed += 1;
      } else {
        result.stale += 1;
      }
    } catch (error) {
      const failure = classifyWorkerFailure(error);
      const status = await database.fail(
        job,
        failure.code,
        failure.retryable,
      );
      if (status === "retry_scheduled") {
        result.retried += 1;
      } else if (status === "failed") {
        result.failed += 1;
      } else {
        result.stale += 1;
      }
    }
  }
  return result;
}

export function createOpenAIEmbeddingProvider(
  options: OpenAIEmbeddingOptions,
): SearchEmbeddingProvider {
  return {
    async createEmbeddings(inputs) {
      const result = await createOpenAIEmbeddings(inputs, options);
      return {
        embeddings: result.embeddings,
        promptTokens: result.usage.promptTokens,
      };
    },
  };
}

export function createSupabaseSearchEmbeddingDatabase(
  options: SupabaseSearchEmbeddingDatabaseOptions,
): SearchEmbeddingDatabase {
  const endpoint = buildSupabaseRpcEndpoint(options.supabaseUrl);
  const fetcher = options.fetcher ?? fetch;

  async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`${endpoint}/${name}`, {
        method: "POST",
        headers: {
          apikey: options.serviceRoleKey,
          Authorization: `Bearer ${options.serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new SearchWorkerError("database_unavailable", true);
    }
    if (!response.ok) {
      throw new SearchWorkerError("database_unavailable", true);
    }
    try {
      return await response.json();
    } catch {
      throw new SearchWorkerError("database_response_invalid", true);
    }
  }

  return {
    async claim(limit, visibilityTimeoutSeconds) {
      const payload = await rpc("claim_search_embedding_jobs", {
        p_limit: limit,
        p_visibility_timeout_seconds: visibilityTimeoutSeconds,
      });
      return parseClaimedJobs(payload);
    },
    async complete(job, chunks) {
      const payload = await rpc("complete_search_embedding_job", {
        p_msg_id: job.messageId,
        p_clip_id: job.clipId,
        p_source_hash: job.sourceHash,
        p_index_version: job.indexVersion,
        p_chunks: chunks,
      });
      return parseRpcStatus<CompletionStatus>(payload, [
        "completed",
        "stale",
        "missing",
      ]);
    },
    async fail(job, errorCode, retryable) {
      const payload = await rpc("fail_search_embedding_job", {
        p_msg_id: job.messageId,
        p_clip_id: job.clipId,
        p_source_hash: job.sourceHash,
        p_index_version: job.indexVersion,
        p_error_code: errorCode,
        p_retryable: retryable,
      });
      return parseRpcStatus<FailureStatus>(payload, [
        "retry_scheduled",
        "failed",
        "stale",
        "missing",
      ]);
    },
  };
}

class SearchWorkerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "SearchWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function validateWorkerEmbeddings(
  embeddings: readonly number[][],
  expectedCount: number,
): void {
  if (
    embeddings.length !== expectedCount ||
    embeddings.some(
      (embedding) =>
        embedding.length !== SEARCH_EMBEDDING_DIMENSIONS ||
        embedding.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new SearchWorkerError("provider_response_invalid", true);
  }
}

function classifyWorkerFailure(error: unknown): {
  code: string;
  retryable: boolean;
} {
  if (error instanceof OpenAIEmbeddingError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (error instanceof SearchWorkerError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "empty_document"
  ) {
    return { code: "empty_document", retryable: false };
  }
  return { code: "worker_error", retryable: true };
}

function buildSupabaseRpcEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SearchWorkerError("invalid_database_configuration", false);
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") {
    throw new SearchWorkerError("invalid_database_configuration", false);
  }
  url.pathname = "/rest/v1/rpc";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function parseClaimedJobs(payload: unknown): SearchEmbeddingJob[] {
  if (!Array.isArray(payload)) {
    throw new SearchWorkerError("database_response_invalid", true);
  }
  return payload.map((item) => {
    if (
      !isRecord(item) ||
      !Number.isSafeInteger(item.msg_id) ||
      !Number.isSafeInteger(item.read_ct) ||
      typeof item.clip_id !== "string" ||
      typeof item.source_hash !== "string" ||
      typeof item.index_version !== "string" ||
      typeof item.title !== "string" ||
      typeof item.transcript !== "string"
    ) {
      throw new SearchWorkerError("database_response_invalid", true);
    }
    return {
      messageId: item.msg_id as number,
      attempt: item.read_ct as number,
      clipId: item.clip_id,
      sourceHash: item.source_hash,
      indexVersion: item.index_version,
      title: item.title,
      transcript: item.transcript,
    };
  });
}

function parseRpcStatus<T extends string>(
  payload: unknown,
  allowed: readonly T[],
): T {
  if (typeof payload !== "string" || !allowed.includes(payload as T)) {
    throw new SearchWorkerError("database_response_invalid", true);
  }
  return payload as T;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
