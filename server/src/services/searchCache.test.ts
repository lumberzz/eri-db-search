import assert from "node:assert";
import test from "node:test";
import type { SearchHit } from "../types/searchHit.js";
import {
  bumpSearchCacheGeneration,
  currentSearchCacheGeneration,
  searchCacheGet,
  searchCacheSet,
} from "./searchCache.js";

const sampleHit = (): SearchHit => ({
  id: 1,
  rank: 1,
  composite_art: "ER1-0001",
  composite_art_normalized: "ER10001",
  base_art: "ER1",
  add_art: "0001",
  display_name: "D",
  base_name: "B",
  add_name: "A",
  source_filename: "f.xlsx",
  source_sheet: "S",
  source_row_base: 2,
  source_row_add: 3,
  import_job_id: "job",
  created_at: "now",
});

test("search cache returns stored hits for current generation", () => {
  const gen = currentSearchCacheGeneration();
  const h = sampleHit();
  searchCacheSet(gen, "k1", [h], 1);
  const got = searchCacheGet(gen, "k1");
  assert.ok(got);
  assert.equal(got.count, 1);
  assert.equal(got.items[0]?.composite_art, "ER1-0001");
});

test("search cache invalidates after generation bump (import completed)", () => {
  const gen = currentSearchCacheGeneration();
  searchCacheSet(gen, "k2", [sampleHit()], 1);
  assert.ok(searchCacheGet(gen, "k2"));
  bumpSearchCacheGeneration();
  const gen2 = currentSearchCacheGeneration();
  assert.equal(gen2, gen + 1);
  assert.equal(searchCacheGet(gen2, "k2"), null);
});
