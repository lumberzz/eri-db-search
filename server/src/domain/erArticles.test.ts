import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanAddName,
  isAddFourDigitArticle,
  isBaseErArticle,
  mergeDisplayName,
} from "./erArticles.js";

describe("erArticles", () => {
  it("isBaseErArticle", () => {
    assert.equal(isBaseErArticle("ER010000000001"), true);
    assert.equal(isBaseErArticle("er010000000001"), true);
    assert.equal(isBaseErArticle("  ER01"), true);
    assert.equal(isBaseErArticle("0001"), false);
    assert.equal(isBaseErArticle("XR01"), false);
  });

  it("isAddFourDigitArticle", () => {
    assert.equal(isAddFourDigitArticle("0001"), true);
    assert.equal(isAddFourDigitArticle("0123"), true);
    assert.equal(isAddFourDigitArticle("  0000 "), true);
    assert.equal(isAddFourDigitArticle("00001"), false);
    assert.equal(isAddFourDigitArticle("a001"), false);
  });

  it("cleanAddName", () => {
    assert.equal(cleanAddName(", без каб вводов"), "без каб вводов");
    assert.equal(cleanAddName('", КВБ12, КВБ12'), "КВБ12, КВБ12");
    assert.equal(cleanAddName(null), "");
    assert.equal(cleanAddName(""), "");
    assert.equal(cleanAddName("  ,  текст"), "текст");
  });

  it("mergeDisplayName", () => {
    assert.equal(
      mergeDisplayName(
        "Коробка ККВ",
        "КВБ12, КВБ12"
      ),
      "Коробка ККВ, КВБ12, КВБ12"
    );
    assert.equal(mergeDisplayName("База,", "добавка"), "База, добавка");
    assert.equal(mergeDisplayName("База", ""), "База");
    assert.equal(mergeDisplayName("", "только добавка"), "только добавка");
  });
});
