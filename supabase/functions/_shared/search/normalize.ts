import type { SearchToken, TextSpan } from "./types.ts";

const TOKEN_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;
const PARTY_SUFFIX = /\s+\((?:S|M|SD|C|V|KD|MP|L)\)\s*$/iu;
const ROLE_TOKEN = /(?:ministern|minister|statsrådet|talmannen|talman|ordföranden|ordförande|partiledaren|partiledare)$/iu;
const EDGE_PUNCTUATION = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
const PUNCTUATION_TOKEN = /(^|\s)[\p{P}\p{S}]+(?=\s|$)/gu;

const SWEDISH_DEBRIS = new Set([
  "att",
  "av",
  "den",
  "det",
  "en",
  "ett",
  "för",
  "från",
  "i",
  "med",
  "och",
  "om",
  "på",
  "sedan",
  "som",
  "till",
]);

export function normalizeSearchDisplay(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function normalizeSearchLookup(value: string): string {
  return normalizeSearchDisplay(value)
    .toLocaleLowerCase("sv-SE")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

export function foldSearchLookup(value: string): string {
  return normalizeSearchLookup(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function tokenizeSearchText(value: string): SearchToken[] {
  const display = normalizeSearchDisplay(value);
  return Array.from(display.matchAll(TOKEN_PATTERN), (match, index) => {
    const text = match[0];
    const start = match.index ?? 0;
    return {
      text,
      normalized: normalizeSearchLookup(text),
      folded: foldSearchLookup(text),
      index,
      start,
      end: start + text.length,
    };
  });
}

export function stripSearchPersonDecorations(value: string): string {
  const withoutParty = stripSearchPersonPartySuffix(value);
  const tokens = tokenizeSearchText(withoutParty);
  let finalRoleIndex = -1;
  for (const token of tokens) {
    if (ROLE_TOKEN.test(token.normalized)) finalRoleIndex = token.index;
  }
  if (finalRoleIndex >= 0 && tokens.length - finalRoleIndex - 1 >= 2) {
    return withoutParty.slice(tokens[finalRoleIndex + 1].start).trim();
  }
  return withoutParty;
}

export function stripSearchPersonPartySuffix(value: string): string {
  return normalizeSearchDisplay(value).replace(PARTY_SUFFIX, "").trim();
}

export function subtractSearchSpans(value: string, spans: readonly TextSpan[]): string | null {
  const display = normalizeSearchDisplay(value);
  // RegExp match indexes and String.slice use UTF-16 offsets. Split the same
  // way so an emoji before a matched Swedish token cannot shift subtraction.
  const removed = display.split("");
  for (const span of spans) {
    const start = Math.max(0, Math.min(display.length, span.start));
    const end = Math.max(start, Math.min(display.length, span.end));
    for (let index = start; index < end; index += 1) removed[index] = " ";
  }

  const residual = removed
    .join("")
    .replace(PUNCTUATION_TOKEN, " ")
    .replace(EDGE_PUNCTUATION, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!residual) return null;

  const tokens = tokenizeSearchText(residual);
  if (tokens.length === 0 || tokens.every((token) => SWEDISH_DEBRIS.has(token.normalized))) {
    return null;
  }
  return residual;
}

export function spansOverlap(left: TextSpan, right: TextSpan): boolean {
  return left.start < right.end && right.start < left.end;
}
