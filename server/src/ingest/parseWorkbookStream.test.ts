import assert from "node:assert";
import test from "node:test";
import { detectHeaderBoundary } from "./parseWorkbookStream.js";

test("headerless workbook starts before first ER and keeps 0000/0001", () => {
  const result = detectHeaderBoundary([
    {
      rowNumber: 1,
      values: ["", "ER000000000001", "", "Device"],
    },
    { rowNumber: 2, values: ["", "0000", "", "without cable entries"] },
    { rowNumber: 3, values: ["", "0001", "", "cable entry M20"] },
  ]);
  assert.deepEqual(result, { headerRowIndex: 0, maxCol: 8 });
});

test("real header ends immediately before first article row", () => {
  const result = detectHeaderBoundary([
    { rowNumber: 1, values: ["#", "Артикул", "x", "Наименование"] },
    { rowNumber: 2, values: ["", "ER000000000001", "", "Device"] },
    { rowNumber: 3, values: ["", "0000", "", "without cable entries"] },
  ]);
  assert.deepEqual(result, { headerRowIndex: 1, maxCol: 8 });
});
