import { SEARCH_EMBEDDING_DIMENSIONS } from "./chunks.ts";

export const SEARCH_RANKING_VERSION = "pleni-search-v3" as const;
export const SEARCH_RANKING_ROLLBACK_VERSION = "pleni-search-v2" as const;
export const SEARCH_SEMANTIC_SIMILARITY_FLOOR = 0.35;

/**
 * Query-level semantic safety gate, unchanged from v2. It decides whether the
 * query has any semantic footing at all: a keyword anchor exists, or the whole
 * query clears one of these two floors.
 */
export const SEARCH_SEMANTIC_ADMISSION_SIMILARITY = 0.53;
export const SEARCH_SEMANTIC_ADMISSION_LEXICAL_COVERAGE = 0.67;

/**
 * Candidate-level admission, added in v3. Every semantic-only candidate must
 * clear one of these on its own evidence; a strong candidate elsewhere in the
 * query never admits a weaker one. Keyword-matched candidates are exempt and
 * always survive. Selected offline by
 * `scripts/evaluate_topic_search.py admission-grid` against the frozen capture,
 * using the roadmap's conservative order rather than any judged metric.
 */
export const SEARCH_CANDIDATE_ADMISSION_SIMILARITY = 0.50;
export const SEARCH_CANDIDATE_ADMISSION_LEXICAL_COVERAGE = 0.67;

export const SEARCH_RRF_K = 50;
export const SEARCH_KEYWORD_WEIGHT = 1.5;
export const SEARCH_SEMANTIC_WEIGHT = 1.0;

/**
 * Candidate-level admission for one candidate, mirroring migration 029's
 * `semantic_admitted` predicate. Kept here so the Edge tests can exercise the
 * rule the SQL enforces without a database.
 */
export function admitsSemanticCandidate(candidate: {
  keywordMatched: boolean;
  similarity: number | null;
  lexicalCoverage: number | null;
}): boolean {
  if (candidate.keywordMatched) return true;
  const meetsSimilarity = candidate.similarity !== null &&
    candidate.similarity >= SEARCH_CANDIDATE_ADMISSION_SIMILARITY;
  const meetsCoverage = candidate.lexicalCoverage !== null &&
    candidate.lexicalCoverage >= SEARCH_CANDIDATE_ADMISSION_LEXICAL_COVERAGE;
  return meetsSimilarity || meetsCoverage;
}

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
