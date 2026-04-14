/**
 * Быстрая ручная проверка: поднимает in-memory сценарий с большим числом пар
 * без UI. Запуск: `npm run perf:smoke` из каталога server.
 *
 * Переменные окружения: VARIANT_INSERT_BATCH, BASE_ARTICLE_PAGE, ADD_ARTICLE_PAGE.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/db.js";
import { normalizeArticle } from "../src/normalize.js";
import { materializeVariantsChunked } from "../src/services/importPipeline.js";

const tmp = path.join(os.tmpdir(), `eri-perf-${randomUUID()}.sqlite`);

function main(): void {
  const db = openDatabase(tmp);
  const jobId = randomUUID();
  const filename = "perf.xlsx";

  db.prepare(
    `INSERT INTO import_jobs (id, started_at, status, summary_json) VALUES (?, datetime('now'), 'processing', '{}')`
  ).run(jobId);

  const insBase = db.prepare(
    `INSERT INTO base_articles (base_art, base_art_normalized, base_name, source_filename, source_sheet, source_row, import_job_id)
     VALUES (@base_art, @norm, @name, @fn, 'S', @row, @jid)`
  );
  const insAdd = db.prepare(
    `INSERT INTO add_articles (add_art, add_art_normalized, add_name, source_filename, source_sheet, source_row, import_job_id)
     VALUES (@add_art, @norm, @name, @fn, 'S', @row, @jid)`
  );

  const nb = Math.min(800, parseInt(process.env.PERF_BASES || "400", 10) || 400);
  const na = Math.min(800, parseInt(process.env.PERF_ADDS || "200", 10) || 200);
  const baseNorms = new Set<string>();
  const addNorms = new Set<string>();

  const tIns0 = performance.now();
  for (let i = 0; i < nb; i++) {
    const art = `ER${String(1000 + i)}`;
    const norm = normalizeArticle(art);
    baseNorms.add(norm);
    insBase.run({
      base_art: art,
      norm,
      name: `Base ${i}`,
      fn: filename,
      row: i + 2,
      jid: jobId,
    });
  }
  for (let j = 0; j < na; j++) {
    const add = String(1000 + j).slice(-4).padStart(4, "0");
    const norm = normalizeArticle(add);
    addNorms.add(norm);
    insAdd.run({
      add_art: add,
      norm,
      name: `Add ${j}`,
      fn: filename,
      row: j + 2 + nb,
      jid: jobId,
    });
  }
  console.log(`insert bases/adds ms: ${Math.round(performance.now() - tIns0)}`);

  let lastReport = performance.now();
  const tVar0 = performance.now();
  const { inserted, skipped } = materializeVariantsChunked(
    db,
    jobId,
    filename,
    baseNorms,
    addNorms,
    () => {
      const now = performance.now();
      if (now - lastReport > 2000) {
        lastReport = now;
        console.log("…variants chunk progress");
      }
    }
  );
  console.log(
    `materializeVariantsChunked ms: ${Math.round(performance.now() - tVar0)} inserted=${inserted} skipped=${skipped} expected≈${nb * na}`
  );

  db.close();
  fs.unlinkSync(tmp);
}

main();
