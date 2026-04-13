import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compositeNormalizedKey,
  normalizeArticle,
  normalizeCompositeSearchInput,
} from "./normalize.js";

describe("normalize", () => {
  it("normalizeArticle", () => {
    assert.equal(normalizeArticle("ER010000000001"), "ER010000000001");
    assert.equal(normalizeArticle("  abc-12  "), "ABC12");
  });

  it("compositeNormalizedKey", () => {
    assert.equal(
      compositeNormalizedKey("ER010000000001", "0001"),
      "ER0100000000010001"
    );
  });

  it("normalizeCompositeSearchInput", () => {
    assert.equal(
      normalizeCompositeSearchInput("ER010000000001-0001"),
      "ER0100000000010001"
    );
    assert.equal(
      normalizeCompositeSearchInput("er0100000000010001"),
      "ER0100000000010001"
    );
    assert.equal(
      normalizeCompositeSearchInput("ER010000000001 - 0001"),
      "ER0100000000010001"
    );
  });
});
