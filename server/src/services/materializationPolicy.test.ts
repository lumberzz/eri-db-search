import assert from "node:assert";
import test from "node:test";
import { decideMaterializationMode } from "./materializationPolicy.js";

test("policy picks full for small pair count", () => {
  const d = decideMaterializationMode(10, 10, 100, {
    warnPairs: 1_000,
    lazyPairs: 10_000,
    rejectPairs: 100_000,
  });
  assert.equal(d.mode, "full");
  assert.equal(d.warnings.length, 0);
});

test("policy picks lazy above lazy threshold", () => {
  const d = decideMaterializationMode(1000, 2000, 2_000_000, {
    warnPairs: 100_000,
    lazyPairs: 1_000_000,
    rejectPairs: 10_000_000,
  });
  assert.equal(d.mode, "lazy");
});

test("policy forces lazy above hard limit (no data-loss reject)", () => {
  const d = decideMaterializationMode(1000, 2000, 20_000_000, {
    warnPairs: 100_000,
    lazyPairs: 1_000_000,
    rejectPairs: 10_000_000,
  });
  assert.equal(d.mode, "lazy");
  assert.equal(d.reason, "hard_limit_forced_lazy");
});
