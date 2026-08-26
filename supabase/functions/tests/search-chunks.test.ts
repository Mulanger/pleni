import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSearchEmbeddingPassages,
  MAX_PASSAGE_CHARACTERS,
  normalizeSearchEmbeddingText,
  SEARCH_EMBEDDING_INDEX_VERSION,
  SearchChunkError,
} from "../_shared/search/chunks.ts";

test("normalizes whitespace without altering Swedish words", () => {
  assert.equal(
    normalizeSearchEmbeddingText("  Åtgärder\t för\n elsparkcyklar  "),
    "Åtgärder för elsparkcyklar",
  );
});

test("creates deterministic sentence passages with one-sentence overlap", async () => {
  const first = `Första ${"skatt ".repeat(44).trim()}.`;
  const second = `Andra ${"välfärd ".repeat(37).trim()}.`;
  const third = `Tredje ${"budget ".repeat(42).trim()}.`;
  const transcript = `${first} ${second} ${third}`;

  const passages = await buildSearchEmbeddingPassages({
    title: "Skatter 2017",
    transcript,
  });
  const repeated = await buildSearchEmbeddingPassages({
    title: "Skatter 2017",
    transcript,
  });

  assert.equal(passages.length, 2);
  assert.equal(passages[0].passage, `${first} ${second}`);
  assert.equal(passages[1].passage, `${second} ${third}`);
  assert.equal(passages[1].charStart, Array.from(first).length + 1);
  assert.deepEqual(passages, repeated);
  for (const [index, passage] of passages.entries()) {
    assert.equal(passage.chunkNo, index);
    assert.ok(Array.from(passage.passage).length <= MAX_PASSAGE_CHARACTERS);
    assert.match(passage.contentHash, /^[0-9a-f]{64}$/u);
    assert.equal(
      passage.embeddingInput,
      `Skatter 2017\n\n${passage.passage}`,
    );
  }
});

test("uses Unicode code-point offsets and hard-wraps an unusual long sentence", async () => {
  const transcript = `🔎 ${"ö".repeat(760)} slut.`;
  const normalized = normalizeSearchEmbeddingText(transcript);
  const characters = Array.from(normalized);
  const passages = await buildSearchEmbeddingPassages({ title: "Ämne", transcript });

  assert.ok(passages.length >= 2);
  assert.equal(passages[0].charStart, 0);
  assert.equal(passages.at(-1)?.charEnd, characters.length);
  for (const passage of passages) {
    assert.equal(
      passage.passage,
      characters.slice(passage.charStart, passage.charEnd).join(""),
    );
    assert.ok(Array.from(passage.passage).length <= MAX_PASSAGE_CHARACTERS);
  }
});

test("uses a legacy title as the document only when transcript is empty", async () => {
  const [passage] = await buildSearchEmbeddingPassages({
    title: "  Elsparkcyklar i trafiken  ",
    transcript: "\n\t",
  });
  assert.equal(passage.passage, "Elsparkcyklar i trafiken");
  assert.equal(
    passage.embeddingInput,
    "Elsparkcyklar i trafiken\n\nElsparkcyklar i trafiken",
  );
});

test("hashes include the index version", async () => {
  const document = { title: "Skatt", transcript: "Samma text." };
  const [current] = await buildSearchEmbeddingPassages(
    document,
    SEARCH_EMBEDDING_INDEX_VERSION,
  );
  const [next] = await buildSearchEmbeddingPassages(document, "next-version");
  assert.notEqual(current.contentHash, next.contentHash);
});

test("never emits an empty passage", async () => {
  await assert.rejects(
    buildSearchEmbeddingPassages({ title: " ", transcript: "\n\t" }),
    (error) => error instanceof SearchChunkError && error.code === "empty_document",
  );
});
