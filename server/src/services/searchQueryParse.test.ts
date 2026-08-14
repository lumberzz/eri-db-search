import assert from "node:assert";
import test from "node:test";
import { parseSearchQuery, splitCompositeFromQuery } from "./searchQueryParse.js";

test("parseSearchQuery: base name + add code", () => {
  const q = parseSearchQuery("Коробка коммутационная 0001");
  assert.equal(q.addCode, "0001");
  assert.ok(q.namePart?.includes("Коробка"));
});

test("parseSearchQuery: add code + base name", () => {
  const q = parseSearchQuery("0001 Коробка");
  assert.equal(q.addCode, "0001");
  assert.ok(q.namePart?.includes("Коробка"));
});

test("parseSearchQuery: ER with hyphen", () => {
  const q = parseSearchQuery("ER010000000001-0001");
  assert.equal(q.addCode, "0001");
  assert.equal(q.articleFlat, "ER0100000000010001");
});

test("parseSearchQuery: standalone 0000 and wildcard ER*-0001", () => {
  const zero = parseSearchQuery("0000");
  assert.equal(zero.addCode, "0000");
  assert.equal(zero.articleFlat, "0000");

  const wildcard = parseSearchQuery("ER*-0001");
  assert.equal(wildcard.addCode, "0001");
  assert.equal(wildcard.basePrefix, "ER");
  assert.equal(wildcard.articleFlat, "");
});

test("parseSearchQuery: name words and code may be in any order", () => {
  const q = parseSearchQuery("Коробка 0001 коммутационная");
  assert.equal(q.addCode, "0001");
  assert.deepEqual(q.nameTokens, ["КОРОБКА", "КОММУТАЦИОННАЯ"]);
  assert.equal(q.articleFlat, "");
});

test("splitCompositeFromQuery: requires hyphen for ambiguous ER bases", () => {
  assert.deepEqual(splitCompositeFromQuery("ER010000000001-0001", "ER0100000000010001"), {
    er: "ER010000000001",
    add: "0001",
  });
  assert.equal(splitCompositeFromQuery("ER0100000000010001", "ER0100000000010001"), null);
});
