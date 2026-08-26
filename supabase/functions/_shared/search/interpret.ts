import type {
  PartyCode,
  SearchAmbiguity,
  SearchAmbiguityOption,
  SearchFacet,
} from "../search-types.ts";
import {
  foldSearchLookup,
  normalizeSearchDisplay,
  normalizeSearchLookup,
  spansOverlap,
  stripSearchPersonDecorations,
  stripSearchPersonPartySuffix,
  subtractSearchSpans,
  tokenizeSearchText,
} from "./normalize.ts";
import {
  PERSON_FUZZY_MIN_MARGIN,
  PERSON_FUZZY_MIN_SCORE,
  SEARCH_INTERPRETER_VERSION,
  type ConsumedFacetKind,
  type ConsumedSearchSpan,
  type DateInterpretation,
  type SearchEntityAlias,
  type SearchEntityCatalog,
  type SearchEventEntity,
  type SearchInterpretationRequest,
  type SearchInterpretationResult,
  type SearchPartyEntity,
  type SearchPersonEntity,
  type SearchToken,
  type TextSpan,
} from "./types.ts";

export const DEFAULT_SEARCH_PARTIES: readonly SearchPartyEntity[] = [
  { party: "S", label: "Socialdemokraterna", aliases: ["S", "Socialdemokraterna"] },
  { party: "M", label: "Moderaterna", aliases: ["M", "Moderaterna"] },
  { party: "SD", label: "Sverigedemokraterna", aliases: ["SD", "Sverigedemokraterna"] },
  { party: "C", label: "Centerpartiet", aliases: ["C", "Centerpartiet"] },
  { party: "V", label: "Vänsterpartiet", aliases: ["V", "Vänsterpartiet"] },
  { party: "KD", label: "Kristdemokraterna", aliases: ["KD", "Kristdemokraterna"] },
  { party: "MP", label: "Miljöpartiet", aliases: ["MP", "Miljöpartiet"] },
  { party: "L", label: "Liberalerna", aliases: ["L", "Liberalerna"] },
] as const;

interface SpanMatch<T> extends TextSpan {
  entity: T;
  tokenCount: number;
}

interface ScoredPersonMatch extends SpanMatch<SearchPersonEntity> {
  score: number;
}

interface Resolution<T> {
  match: SpanMatch<T> | null;
  ambiguity: SearchAmbiguity | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_RANGE = /(?<!\d)([12]\d{3})\s*[-–—]\s*([12]\d{3})(?!\d)/gu;
const DATE_FROM = /(?<![\p{L}\p{N}])(från|sedan)\s+([12]\d{3})(?!\d)/giu;
const SINGLE_YEAR = /(?<!\d)([12]\d{3})(?!\d)/gu;

export function interpretSearchQuery(
  request: SearchInterpretationRequest,
  catalog: SearchEntityCatalog,
): SearchInterpretationResult {
  try {
    return interpretSearchQueryUnsafe(request, catalog);
  } catch {
    return wholeQueryFallback(request);
  }
}

function interpretSearchQueryUnsafe(
  request: SearchInterpretationRequest,
  catalog: SearchEntityCatalog,
): SearchInterpretationResult {
  const displayQuery = normalizeSearchDisplay(request.query);
  const tokens = tokenizeSearchText(displayQuery);
  const disabled = new Set(request.disabledFacets ?? []);
  const consumed: ConsumedSearchSpan[] = [];

  const detectedDate = extractSearchDate(displayQuery);
  const activeDate = detectedDate && !disabled.has("date") ? detectedDate : null;
  if (activeDate) consumed.push(consumedSpan("date", activeDate, displayQuery));

  const person = disabled.has("person")
    ? { match: null, ambiguity: null }
    : resolvePerson(tokens, catalog.people, consumed);
  if (person.match) consumed.push(consumedSpan("person", person.match, displayQuery));

  const parties = catalog.parties ?? [...DEFAULT_SEARCH_PARTIES];
  const party = disabled.has("party")
    ? null
    : resolveParty(tokens, parties, consumed);
  if (party) consumed.push(consumedSpan("party", party, displayQuery));

  const event = disabled.has("event")
    ? { match: null, ambiguity: null }
    : resolveEvent(tokens, catalog.events, consumed, activeDate);
  if (event.match) consumed.push(consumedSpan("event", event.match, displayQuery));

  const topic = subtractSearchSpans(displayQuery, consumed);
  const facets: SearchFacet[] = [];
  if (person.match) {
    facets.push({
      kind: "person",
      key: "person",
      label: person.match.entity.label,
      politicianId: person.match.entity.id,
      removable: true,
    });
  }
  if (party) {
    facets.push({
      kind: "party",
      key: "party",
      label: party.entity.label,
      party: party.entity.party,
      removable: true,
    });
  }
  if (event.match) {
    facets.push({
      kind: "event",
      key: "event",
      label: event.match.entity.label,
      eventId: event.match.entity.id,
      removable: true,
    });
  }
  if (activeDate) {
    facets.push({
      kind: "date",
      key: "date",
      label: activeDate.label,
      from: activeDate.from,
      to: activeDate.to,
      removable: true,
    });
  }
  if (topic) {
    facets.push({ kind: "topic", key: "topic", label: topic, removable: true });
  }

  const ambiguity = person.ambiguity ?? event.ambiguity;
  const politicianId = person.match?.entity.id ?? null;
  const partyCode = party?.entity.party ?? null;
  const eventId = event.match?.entity.id ?? null;
  const sourceIds = event.match ? [...event.match.entity.sourceIds].sort() : null;
  return {
    facets,
    ambiguity,
    plan: {
      version: SEARCH_INTERPRETER_VERSION,
      originalQuery: request.query,
      displayQuery,
      topic,
      politicianId,
      party: partyCode,
      eventId,
      sourceIds,
      dateFrom: activeDate?.from ?? null,
      dateTo: activeDate?.to ?? null,
      hasRetrievalAnchor: Boolean(topic || politicianId || partyCode || eventId),
      fallback: false,
      consumedSpans: consumed.sort((left, right) => left.start - right.start),
    },
  };
}

export function extractSearchDate(displayQuery: string): DateInterpretation | null {
  const candidates: Array<DateInterpretation & { priority: number }> = [];
  for (const match of displayQuery.matchAll(DATE_RANGE)) {
    const fromYear = Number(match[1]);
    const toYear = Number(match[2]);
    if (fromYear > toYear) continue;
    candidates.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      label: `${fromYear}–${toYear}`,
      from: `${fromYear}-01-01`,
      to: `${toYear}-12-31`,
      priority: 0,
    });
  }
  for (const match of displayQuery.matchAll(DATE_FROM)) {
    const year = Number(match[2]);
    const prefix = match[1].toLocaleLowerCase("sv-SE");
    candidates.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      label: `${prefix} ${year}`,
      from: `${year}-01-01`,
      to: "9999-12-31",
      priority: 1,
    });
  }
  for (const match of displayQuery.matchAll(SINGLE_YEAR)) {
    const start = match.index ?? 0;
    const span = { start, end: start + match[0].length };
    if (candidates.some((candidate) => spansOverlap(candidate, span))) continue;
    const year = Number(match[1]);
    candidates.push({
      ...span,
      label: `${year}`,
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      priority: 2,
    });
  }
  candidates.sort((left, right) => left.start - right.start || left.priority - right.priority);
  const selected = candidates[0];
  if (!selected) return null;
  const { priority: _priority, ...date } = selected;
  return date;
}

function resolvePerson(
  tokens: SearchToken[],
  people: SearchPersonEntity[],
  blocked: readonly TextSpan[],
): Resolution<SearchPersonEntity> {
  const exact: Array<SpanMatch<SearchPersonEntity>> = [];
  for (const person of people) {
    for (const form of personLookupForms(person.aliases)) {
      for (const match of exactTokenMatches(tokens, form, blocked)) {
        exact.push({ ...match, entity: person });
      }
    }
  }

  const deduplicatedExact = deduplicateMatches(exact);
  deduplicatedExact.sort(compareSpanMatches);
  const bestExact = deduplicatedExact[0];
  if (bestExact) {
    const contenders = deduplicatedExact.filter(
      (candidate) => candidate.start === bestExact.start && candidate.end === bestExact.end,
    );
    const owners = uniqueEntities(contenders);
    if (owners.length === 1) return { match: bestExact, ambiguity: null };
    return { match: null, ambiguity: personAmbiguity(owners) };
  }

  const fuzzy = fuzzyPersonMatches(tokens, people, blocked);
  const bestFuzzy = fuzzy[0];
  if (!bestFuzzy || bestFuzzy.score < PERSON_FUZZY_MIN_SCORE) {
    return { match: null, ambiguity: null };
  }
  const second = fuzzy.find((candidate) => candidate.entity.id !== bestFuzzy.entity.id);
  if (!second || bestFuzzy.score - second.score >= PERSON_FUZZY_MIN_MARGIN) {
    return { match: bestFuzzy, ambiguity: null };
  }
  const close = fuzzy.filter(
    (candidate) => bestFuzzy.score - candidate.score < PERSON_FUZZY_MIN_MARGIN,
  );
  return { match: null, ambiguity: personAmbiguity(uniqueEntities(close)) };
}

function resolveParty(
  tokens: SearchToken[],
  parties: SearchPartyEntity[],
  blocked: readonly TextSpan[],
): SpanMatch<SearchPartyEntity> | null {
  const matches: Array<SpanMatch<SearchPartyEntity>> = [];
  for (const party of parties) {
    for (const alias of party.aliases) {
      for (const match of exactTokenMatches(tokens, alias, blocked)) {
        matches.push({ ...match, entity: party });
      }
    }
  }
  matches.sort(compareSpanMatches);
  return matches[0] ?? null;
}

function resolveEvent(
  tokens: SearchToken[],
  events: SearchEventEntity[],
  blocked: readonly TextSpan[],
  date: DateInterpretation | null,
): Resolution<SearchEventEntity> {
  const matches: Array<SpanMatch<SearchEventEntity>> = [];
  for (const event of events) {
    if (!event.verified) continue;
    for (const alias of event.aliases) {
      if (!alias.verified) continue;
      for (const match of exactTokenMatches(tokens, alias.value, blocked)) {
        matches.push({ ...match, entity: event });
      }
    }
  }
  const deduplicated = deduplicateMatches(matches);
  deduplicated.sort(compareSpanMatches);
  const best = deduplicated[0];
  if (!best) return { match: null, ambiguity: null };

  let contenders = deduplicated.filter(
    (candidate) => candidate.start === best.start && candidate.end === best.end,
  );
  if (date) contenders = contenders.filter((candidate) => eventOverlapsDate(candidate.entity, date));
  const owners = uniqueEntities(contenders);
  if (owners.length === 1) {
    const selected = contenders.find((candidate) => candidate.entity.id === owners[0].id) ?? null;
    return { match: selected, ambiguity: null };
  }
  if (owners.length >= 2) return { match: null, ambiguity: eventAmbiguity(owners) };
  return { match: null, ambiguity: null };
}

function personLookupForms(aliases: SearchEntityAlias[]): string[] {
  const fullForms = new Set<string>();
  const surnameForms = new Set<string>();
  for (const alias of aliases) {
    if (!alias.verified) continue;
    const raw = normalizeSearchDisplay(alias.value);
    const withoutParty = stripSearchPersonPartySuffix(raw);
    const cleaned = stripSearchPersonDecorations(raw);
    if (raw) fullForms.add(raw);
    if (withoutParty) fullForms.add(withoutParty);
    if (cleaned) fullForms.add(cleaned);
    const tokens = tokenizeSearchText(cleaned);
    if (tokens.length >= 2) surnameForms.add(tokens[tokens.length - 1].text);
  }
  return [...fullForms, ...surnameForms];
}

function exactTokenMatches(
  queryTokens: SearchToken[],
  alias: string,
  blocked: readonly TextSpan[],
): TextSpan[] & Array<{ tokenCount: number }> {
  const aliasTokens = tokenizeSearchText(alias);
  const matches: Array<TextSpan & { tokenCount: number }> = [];
  if (aliasTokens.length === 0 || aliasTokens.length > queryTokens.length) return matches;

  for (let startIndex = 0; startIndex <= queryTokens.length - aliasTokens.length; startIndex += 1) {
    const window = queryTokens.slice(startIndex, startIndex + aliasTokens.length);
    const exact = window.every(
      (token, index) => token.normalized === aliasTokens[index].normalized,
    );
    const folded = window.every((token, index) => token.folded === aliasTokens[index].folded);
    if (!exact && !folded) continue;
    const span = {
      start: window[0].start,
      end: window[window.length - 1].end,
      tokenCount: window.length,
    };
    if (!blocked.some((candidate) => spansOverlap(candidate, span))) matches.push(span);
  }
  return matches;
}

function fuzzyPersonMatches(
  queryTokens: SearchToken[],
  people: SearchPersonEntity[],
  blocked: readonly TextSpan[],
): ScoredPersonMatch[] {
  const matches: ScoredPersonMatch[] = [];
  for (const person of people) {
    for (const form of personLookupForms(person.aliases)) {
      const aliasTokens = tokenizeSearchText(form);
      if (aliasTokens.length < 2 || aliasTokens.length > queryTokens.length) continue;
      const aliasKey = foldSearchLookup(form);
      for (let startIndex = 0; startIndex <= queryTokens.length - aliasTokens.length; startIndex += 1) {
        const window = queryTokens.slice(startIndex, startIndex + aliasTokens.length);
        const span = { start: window[0].start, end: window[window.length - 1].end };
        if (blocked.some((candidate) => spansOverlap(candidate, span))) continue;
        const queryKey = window.map((token) => token.folded).join(" ");
        matches.push({
          ...span,
          entity: person,
          tokenCount: window.length,
          score: levenshteinSimilarity(queryKey, aliasKey),
        });
      }
    }
  }

  const bestByEntityAndSpan = new Map<string, ScoredPersonMatch>();
  for (const match of matches) {
    const key = `${match.entity.id}:${match.start}:${match.end}`;
    const previous = bestByEntityAndSpan.get(key);
    if (!previous || match.score > previous.score) bestByEntityAndSpan.set(key, match);
  }
  return [...bestByEntityAndSpan.values()].sort(
    (left, right) =>
      right.score - left.score ||
      right.tokenCount - left.tokenCount ||
      left.start - right.start ||
      left.entity.label.localeCompare(right.entity.label, "sv-SE") ||
      left.entity.id.localeCompare(right.entity.id),
  );
}

function levenshteinSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function eventOverlapsDate(event: SearchEventEntity, date: DateInterpretation): boolean {
  const from = validIsoDate(event.dateFrom) ? event.dateFrom : "0001-01-01";
  const to = validIsoDate(event.dateTo) ? event.dateTo : "9999-12-31";
  return from <= date.to && to >= date.from;
}

function validIsoDate(value: string | null): value is string {
  return value !== null && ISO_DATE.test(value);
}

function compareSpanMatches<T>(left: SpanMatch<T>, right: SpanMatch<T>): number {
  return (
    right.tokenCount - left.tokenCount ||
    right.end - right.start - (left.end - left.start) ||
    left.start - right.start
  );
}

function deduplicateMatches<T>(matches: Array<SpanMatch<T> & { entity: T & { id: string } }>): Array<SpanMatch<T & { id: string }>> {
  const byKey = new Map<string, SpanMatch<T & { id: string }>>();
  for (const match of matches) {
    byKey.set(`${match.entity.id}:${match.start}:${match.end}`, match);
  }
  return [...byKey.values()];
}

function uniqueEntities<T extends { id: string }>(matches: Array<{ entity: T }>): T[] {
  const entities = new Map<string, T>();
  for (const match of matches) entities.set(match.entity.id, match.entity);
  return [...entities.values()].sort(
    (left, right) =>
      ("label" in left && "label" in right
        ? String(left.label).localeCompare(String(right.label), "sv-SE")
        : 0) || left.id.localeCompare(right.id),
  );
}

function personAmbiguity(people: SearchPersonEntity[]): SearchAmbiguity {
  return {
    kind: "person",
    message: "Vem menar du?",
    options: people.map((person) => ({
      id: person.id,
      label: person.label,
      detail: person.partyLabel ?? person.party,
    })),
  };
}

function eventAmbiguity(events: SearchEventEntity[]): SearchAmbiguity {
  return {
    kind: "event",
    message: "Vilken händelse menar du?",
    options: [...events]
      .sort(
        (left, right) =>
          (left.dateFrom ?? "9999-12-31").localeCompare(right.dateFrom ?? "9999-12-31") ||
          left.label.localeCompare(right.label, "sv-SE") ||
          left.id.localeCompare(right.id),
      )
      .map<SearchAmbiguityOption>((event) => ({
        id: event.id,
        label: event.label,
        detail: event.dateLabel ?? eventDateDetail(event),
      })),
  };
}

function eventDateDetail(event: SearchEventEntity): string {
  if (event.dateFrom && event.dateTo && event.dateFrom !== event.dateTo) {
    return `${event.dateFrom}–${event.dateTo}`;
  }
  return event.dateFrom ?? event.dateTo ?? "Datum saknas";
}

function consumedSpan(
  kind: ConsumedFacetKind,
  span: TextSpan,
  displayQuery: string,
): ConsumedSearchSpan {
  return {
    kind,
    start: span.start,
    end: span.end,
    text: displayQuery.slice(span.start, span.end),
  };
}

function wholeQueryFallback(request: SearchInterpretationRequest): SearchInterpretationResult {
  let displayQuery: string;
  try {
    displayQuery = normalizeSearchDisplay(request.query);
  } catch {
    displayQuery = String(request.query).trim();
  }
  const topic = displayQuery || null;
  const facets: SearchFacet[] = topic
    ? [{ kind: "topic", key: "topic", label: topic, removable: true }]
    : [];
  return {
    facets,
    ambiguity: null,
    plan: {
      version: SEARCH_INTERPRETER_VERSION,
      originalQuery: request.query,
      displayQuery,
      topic,
      politicianId: null,
      party: null,
      eventId: null,
      sourceIds: null,
      dateFrom: null,
      dateTo: null,
      hasRetrievalAnchor: topic !== null,
      fallback: true,
      consumedSpans: [],
    },
  };
}
