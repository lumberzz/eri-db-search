import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { openDatabase } from "../db.js";
import { runImportJob } from "../services/importPipeline.js";
import { searchItems } from "../services/searchService.js";

function tmpPaths(): { db: string; xlsx: string } {
  const id = randomUUID();
  return {
    db: path.join(os.tmpdir(), `eri-seq-pair-${id}.sqlite`),
    xlsx: path.join(os.tmpdir(), `eri-seq-pair-${id}.xlsx`),
  };
}

/** Mirrors data/sample-import.xlsx structure from generate-sample-xlsx.ts */
async function writeSampleWorkbook(filePath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");
  ws.addRow(["A", "Артикул", "C", "Наименование"]);
  ws.addRow([
    "",
    "ER010000000001",
    "",
    "Коробка коммутационная взрывозащищенная",
  ]);
  ws.addRow(["", "0000", "", ", без каб вводов"]);
  ws.addRow(["", "0001", "", ", КВБ12, КВБ12"]);
  ws.addRow(["", "ER010000000002", "", "Второй базовый артикул"]);
  ws.addRow(["", "0002", "", "  , запасной вариант  "]);
  await wb.xlsx.writeFile(filePath);
}

test("import combines every base with every additional code in the file", async () => {
  const p = tmpPaths();
  await writeSampleWorkbook(p.xlsx);
  const db = openDatabase(p.db);
  const jobId = randomUUID();
  db.prepare(
    `INSERT INTO import_jobs (id, started_at, status, summary_json, progress_json, diagnostics_json)
     VALUES (?, datetime('now'), 'pending', '{}', '{}', '{}')`
  ).run(jobId);

  const res = await runImportJob(db, jobId, [{ diskPath: p.xlsx, originalname: "sample.xlsx" }]);
  assert.equal(res.status, "completed");
  assert.equal(res.files[0]?.estimatedPairs, 6, JSON.stringify(res.files[0]));

  const hit11 = searchItems(db, "ER010000000001-0001", 10);
  assert.equal(hit11.length, 1);
  assert.equal(hit11[0]?.add_art, "0001");
  assert.ok(hit11[0]?.add_name?.includes("КВБ12"));
  assert.equal(hit11[0]?.source_row_base, 2);
  assert.equal(hit11[0]?.source_row_add, 4);

  const byName = searchItems(db, "коммутационная Коробка 0001", 10);
  assert.ok(byName.length >= 1);
  assert.equal(byName[0]?.add_art, "0001");
  assert.ok(byName[0]?.base_name?.includes("Коробка"));

  const hit12 = searchItems(db, "ER010000000002-0002", 10);
  assert.equal(hit12.length, 1);
  assert.equal(hit12[0]?.add_art, "0002");
  assert.ok(hit12[0]?.add_name?.toLowerCase().includes("запасной"));
  assert.equal(hit12[0]?.source_row_base, 5);
  assert.equal(hit12[0]?.source_row_add, 6);

  const cross = searchItems(db, "ER010000000001-0002", 10);
  assert.equal(cross.length, 1);
  assert.equal(cross[0]?.source_row_base, 2);
  assert.equal(cross[0]?.source_row_add, 6);

  const withoutCableEntries = searchItems(db, "ER010000000002-0000", 10);
  assert.equal(withoutCableEntries.length, 1);
  assert.equal(withoutCableEntries[0]?.add_art, "0000");
  assert.ok(
    withoutCableEntries[0]?.add_name?.toLowerCase().includes("без каб")
  );
  assert.equal(withoutCableEntries[0]?.source_row_base, 5);
  assert.equal(withoutCableEntries[0]?.source_row_add, 3);

  db.close();
  try {
    fs.unlinkSync(p.db);
  } catch {}
  try {
    fs.unlinkSync(p.xlsx);
  } catch {}
});
