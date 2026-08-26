import { SEARCH_EMBEDDING_DIMENSIONS } from "./chunks.ts";

export const SEARCH_RANKING_VERSION = "pleni-search-v2" as const;
export const SEARCH_SEMANTIC_SIMILARITY_FLOOR = 0.35;
export const SEARCH_SEMANTIC_ADMISSION_SIMILARITY = 0.53;
export const SEARCH_SEMANTIC_ADMISSION_LEXICAL_COVERAGE = 0.67;
export const SEARCH_RRF_K = 50;
export const SEARCH_KEYWORD_WEIGHT = 1.5;
export const SEARCH_SEMANTIC_WEIGHT = 1.0;

/** Encode a validated query vector for Postgres' halfvec text input. */
export function embeddingToHalfvec(embedding: readonly number[]): string {
  if (
    embedding.length !== SEARCH_EMBEDDING_DIMENSIONS ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("invalid_query_embedding");
  }
  return `[${embedding.join(",")}]`;
}

/**
 * Reserve conservatively before calling the provider. Swedish UTF-8 text uses
 * at most one token per two bytes for this short-query safety budget, plus a
 * small request overhead. Exact usage is intentionally not persisted.
 */
export function providerTokenReservation(topic: string): number {
  const bytes = new TextEncoder().encode(topic).byteLength;
  return Math.min(4096, Math.max(1, Math.ceil(bytes / 2) + 8));
}
