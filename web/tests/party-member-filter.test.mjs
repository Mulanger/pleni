import assert from "node:assert/strict";
import test from "node:test";

import {
  filterPartyMembers,
  normalizePartyMemberQuery
} from "../src/party-member-filter.ts";

const members = [
  { id: "1", name: "Anders Ygeman" },
  { id: "2", name: "Åsa Eriksson" },
  { id: "3", name: "Aida Birinxhiku" }
];

test("party member queries ignore case, accents and extra spacing", () => {
  assert.equal(normalizePartyMemberQuery("  ÅSA   ERIKSSON "), "asa eriksson");
  assert.deepEqual(filterPartyMembers(members, "asa").map((member) => member.id), ["2"]);
  assert.deepEqual(filterPartyMembers(members, "anders  yg").map((member) => member.id), ["1"]);
});

test("an empty query preserves every member and an unknown name returns none", () => {
  assert.deepEqual(filterPartyMembers(members, "").map((member) => member.id), ["1", "2", "3"]);
  assert.deepEqual(filterPartyMembers(members, "namn som saknas"), []);
});
