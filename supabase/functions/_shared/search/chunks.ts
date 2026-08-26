export const SEARCH_EMBEDDING_MODEL = "text-embedding-3-large";
export const SEARCH_EMBEDDING_DIMENSIONS = 1024;
export const SEARCH_EMBEDDING_INDEX_VERSION =
  "openai:text-embedding-3-large:1024:v1";
export const MAX_PASSAGE_CHARACTERS = 700;

const MAX_SENTENCE_PART_CHARACTERS = Math.floor(
  (MAX_PASSAGE_CHARACTERS - 1) / 2,
);
const SENTENCE_END = new Set([".", "!", "?"]);
const SENTENCE_CLOSER = new Set(["\"", "'", "”", "’", ")", "]"]);

export interface SearchEmbeddingDocument {
  title: string;
  transcript: string;
}

export interface SearchEmbeddingPassage {
  chunkNo: number;
  passage: string;
  charStart: number;
  charEnd: number;
  embeddingInput: string;
  contentHash: string;
}

interface TextSpan {
  start: number;
  end: number;
}

export class SearchChunkError extends Error {
  readonly code: "empty_document";

  constructor() {
    super("The search document has no embeddable text.");
    this.name = "SearchChunkError";
    this.code = "empty_document";
  }
}

/** Normalize spacing only. Swedish words, punctuation and casing are preserved. */
export function normalizeSearchEmbeddingText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Build deterministic, sentence-oriented passages.
 *
 * Offsets count Unicode code points (not UTF-16 code units) in the normalized
 * transcript. If a legacy document has no transcript, its title is the
 * normalized document and passage source instead.
 */
export async function buildSearchEmbeddingPassages(
  document: SearchEmbeddingDocument,
  indexVersion = SEARCH_EMBEDDING_INDEX_VERSION,
): Promise<SearchEmbeddingPassage[]> {
  const normalizedTitle = normalizeSearchEmbeddingText(document.title);
  const normalizedTranscript = normalizeSearchEmbeddingText(document.transcript);
  const normalizedDocument = normalizedTranscript || normalizedTitle;
  if (!normalizedDocument) {
    throw new SearchChunkError();
  }

  const characters = Array.from(normalizedDocument);
  const sentenceSpans = splitLongSpans(
    findSentenceSpans(characters),
    characters,
    MAX_SENTENCE_PART_CHARACTERS,
  );
  const passageSpans = packWithSentenceOverlap(sentenceSpans);

  return Promise.all(
    passageSpans.map(async (span, chunkNo) => {
      const passage = characters.slice(span.start, span.end).join("");
      const embeddingInput = normalizedTitle
        ? `${normalizedTitle}\n\n${passage}`
        : passage;
      return {
        chunkNo,
        passage,
        charStart: span.start,
        charEnd: span.end,
        embeddingInput,
        contentHash: await sha256Hex(`${indexVersion}\u001f${embeddingInput}`),
      };
    }),
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function findSentenceSpans(characters: readonly string[]): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  let index = 0;

  while (index < characters.length) {
    if (!SENTENCE_END.has(characters[index])) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < characters.length && SENTENCE_END.has(characters[end])) {
      end += 1;
    }
    while (end < characters.length && SENTENCE_CLOSER.has(characters[end])) {
      end += 1;
    }

    if (end === characters.length || characters[end] === " ") {
      spans.push({ start, end });
      start = end;
      while (start < characters.length && characters[start] === " ") {
        start += 1;
      }
      index = start;
      continue;
    }
    index = end;
  }

  if (start < characters.length) {
    spans.push({ start, end: characters.length });
  }
  return spans;
}

function splitLongSpans(
  spans: readonly TextSpan[],
  characters: readonly string[],
  maximum: number,
): TextSpan[] {
  const split: TextSpan[] = [];
  for (const span of spans) {
    let start = span.start;
    while (span.end - start > maximum) {
      const hardEnd = start + maximum;
      let end = hardEnd;
      for (let candidate = hardEnd; candidate > start; candidate -= 1) {
        if (characters[candidate] === " ") {
          end = candidate;
          break;
        }
      }
      if (end === start) {
        end = hardEnd;
      }
      split.push({ start, end });
      start = end;
      while (start < span.end && characters[start] === " ") {
        start += 1;
      }
    }
    if (start < span.end) {
      split.push({ start, end: span.end });
    }
  }
  return split;
}

function packWithSentenceOverlap(spans: readonly TextSpan[]): TextSpan[] {
  if (spans.length === 0) {
    return [];
  }

  const packed: TextSpan[] = [];
  let current: TextSpan[] = [spans[0]];

  for (const next of spans.slice(1)) {
    const combinedLength = next.end - current[0].start;
    if (combinedLength <= MAX_PASSAGE_CHARACTERS) {
      current.push(next);
      continue;
    }

    packed.push({ start: current[0].start, end: current.at(-1)!.end });
    current = [current.at(-1)!, next];
  }

  packed.push({ start: current[0].start, end: current.at(-1)!.end });
  return packed;
}
