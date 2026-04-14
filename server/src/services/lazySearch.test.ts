import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../db.js";
import { compositeNormalizedKey, normalizeArticle } from "../normalize.js";
import { searchItems } from "./searchService.js";

function tmpDb(): string {
  return path.join(os.tmpdir(), `eri-lazy-${randomUUID()}.sqlite`);
}

test("lazy exact search returns synthetic result", () => {
  const p = tmpDb();
  const db = openDatabase(p);
  const jid = randomUUID();
  db.prepare(
    `INSERT INTO import_jobs (id, started_at, status, summary_json) VALUES (?, datetime('now'), 'completed', '{}')`
  ).run(jid);
  db.prepare(
    `INSERT INTO base_articles (base_art, base_art_normalized, base_name, source_filename, source_sheet, source_row, import_job_id)
     VALUES ('ER0100', ?, 'B', 'f.xlsx', 'S', 2, ?)`
  ).run(normalizeArticle("ER0100"), jid);
  db.prepare(
    `INSERT INTO add_articles (add_art, add_art_normalized, add_name, source_filename, source_sheet, source_row, import_job_id)
     VALUES ('0001', ?, 'A', 'f.xlsx', 'S', 3, ?)`
  ).run(normalizeArticle("0001"), jid);
  const bid = (db.prepare(`SELECT id FROM base_articles LIMIT 1`).get() as { id: number }).id;
  const aid = (db.prepare(`SELECT id FROM add_articles LIMIT 1`).get() as { id: number }).id;
  const fId = Number(
    db
      .prepare(
        `INSERT INTO imported_files (import_job_id, original_filename, fingerprint, byte_size, materialization_mode, unique_bases_count, unique_adds_count, estimated_pairs, warnings_json)
         VALUES (?, 'f.xlsx', 'fp', 10, 'lazy', 1, 1, 1, '[]')`
      )
      .run(jid).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO import_file_bases (imported_file_id, base_article_id) VALUES (?, ?)`
  ).run(fId, bid);
  db.prepare(
    `INSERT INTO import_file_adds (imported_file_id, add_article_id) VALUES (?, ?)`
  ).run(fId, aid);

  const out = searchItems(db, "ER0100-0001", 10);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.result_mode, "lazy");
  assert.equal(out[0]?.composite_art_normalized, compositeNormalizedKey("ER0100", "0001"));
  assert.equal(out[0]?.source_filename, "f.xlsx");
  assert.ok(String(out[0]?.source_sheet || "").startsWith("lazy/imported_files/"));

  db.close();
  fs.unlinkSync(p);
});
