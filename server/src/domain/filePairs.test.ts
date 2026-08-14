import assert from "node:assert";
import test from "node:test";
import { FileCombinationCollector } from "./filePairs.js";

test("file combinations include every base with 0000 and 0001", () => {
  const c = new FileCombinationCollector();
  c.onBase({
    baseArt: "ER0001",
    baseName: "Device One",
    sourceFilename: "f.xlsx",
    sourceSheet: "S",
    sourceRow: 1,
  });
  c.onBase({
    baseArt: "ER0002",
    baseName: "Device Two",
    sourceFilename: "f.xlsx",
    sourceSheet: "S",
    sourceRow: 2,
  });
  c.onAdd({
    addArt: "0000",
    addName: "without cable entries",
    sourceFilename: "f.xlsx",
    sourceSheet: "S",
    sourceRow: 3,
  });
  c.onAdd({
    addArt: "0001",
    addName: "cable entry M20",
    sourceFilename: "f.xlsx",
    sourceSheet: "S",
    sourceRow: 4,
  });

  assert.equal(c.estimatedPairs, 4);
  assert.deepEqual(
    c.pairs().map((pair) => `${pair.baseArt}-${pair.addArt}`),
    ["ER0001-0000", "ER0001-0001", "ER0002-0000", "ER0002-0001"]
  );
});
