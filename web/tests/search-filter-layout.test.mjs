import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

function allPartiesButtonSource() {
  const filterStart = appSource.indexOf('<div className="chips" aria-label="Filtrera på parti">');
  assert.notEqual(filterStart, -1, "party filter row must exist");
  const buttonStart = appSource.indexOf("<button", filterStart);
  const buttonEnd = appSource.indexOf("</button>", buttonStart);
  assert.notEqual(buttonStart, -1, "all-parties button must exist");
  assert.notEqual(buttonEnd, -1, "all-parties button must close");
  return appSource.slice(buttonStart, buttonEnd);
}

test("the all-parties filter is an accessible home icon without legacy content", () => {
  const button = allPartiesButtonSource();

  assert.match(button, /className=\{partyFilter === null \? "chips-home active" : "chips-home"\}/);
  assert.match(button, /onClick=\{\(\) => setPartyFilter\(null\)\}/);
  assert.match(button, /aria-label="Visa alla partier"/);
  assert.match(button, /<Home size=\{17\} aria-hidden="true" \/>/);
  assert.doesNotMatch(button, /<i\s*\/>/);
  assert.doesNotMatch(button, />\s*Alla\s*</);
});
