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
    db: path.join(os.tmpdir(), `eri-lazy-policy-${id}.sqlite`),
    xlsx: path.join(os.tmpdir(), `eri-lazy-policy-${id}.xlsx`),
  };
}

async function writeSmallWorkbook(filePath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["#", "Артикул", "x", "Наименование"]);
  ws.addRow(["1", "ER0001", "", "Base One"]);
  ws.addRow(["2", "ER0002", "", "Base Two"]);
  ws.addRow(["3", "0001", "", "Add One"]);
  ws.addRow(["4", "0002", "", "Add Two"]);
  await wb.xlsx.writeFile(filePath);
}

test("high estimatedPairs path uses lazy and persists membership for search", async () => {
  const p = tmpPaths();
  await writeSmallWorkbook(p.xlsx);
  const db = openDatabase(p.db);
  const jobId = randomUUID();
  db.prepare(
    `INSERT INTO import_jobs (id, started_at, status, summary_json, progress_json, diagnostics_json)
     VALUES (?, datetime('now'), 'pending', '{}', '{}', '{}')`
  ).run(jobId);

  const res = await runImportJob(
    db,
    jobId,
    [{ diskPath: p.xlsx, originalname: "large-simulated.xlsx" }],
    {
      policyOverride: {
        warnPairs: 1,
        lazyPairs: 2,
        rejectPairs: 3, // 2 bases * 2 adds = 4 => forced lazy
      },
    }
  );

  assert.equal(res.status, "completed");
  assert.equal(res.files[0]?.materializationMode, "lazy");

  const imported = db
    .prepare(
      `SELECT id, materialization_mode FROM imported_files WHERE import_job_id = ? LIMIT 1`
    )
    .get(jobId) as { id: number; materialization_mode: string } | undefined;
  assert.ok(imported);
  assert.equal(imported?.materialization_mode, "lazy");

  const mBase = db
    .prepare(
      `SELECT COUNT(*) AS c FROM import_file_bases WHERE imported_file_id = ?`
    )
    .get(imported!.id) as { c: number };
  const mAdd = db
    .prepare(
      `SELECT COUNT(*) AS c FROM import_file_adds WHERE imported_file_id = ?`
    )
    .get(imported!.id) as { c: number };
  assert.ok(mBase.c > 0);
  assert.ok(mAdd.c > 0);

  const hits = searchItems(db, "ER0001-0001", 20);
  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.result_mode, "lazy");

  db.close();
  try {
    fs.unlinkSync(p.db);
  } catch {}
  try {
    fs.unlinkSync(p.xlsx);
  } catch {}
});
