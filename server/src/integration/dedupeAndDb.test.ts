import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../db.js";
import { compositeNormalizedKey, normalizeArticle } from "../normalize.js";

function tmpDb(): string {
  return path.join(os.tmpdir(), `eri-dedupe-${randomUUID()}.sqlite`);
}

test("SQLite file persists data across reopen", () => {
  const p = tmpDb();
  const jid = randomUUID();
  {
    const db = openDatabase(p);
    db.prepare(
      `INSERT INTO import_jobs (id, started_at, status, summary_json) VALUES (?, datetime('now'), 'completed', '{}')`
    ).run(jid);
    db.close();
  }
  {
    const db = openDatabase(p);
    const row = db.prepare(`SELECT id FROM import_jobs WHERE id = ?`).get(jid) as { id: string } | undefined;
    assert.ok(row);
    db.close();
  }
  fs.unlinkSync(p);
});

test("base_articles: duplicate base_art_normalized is rejected by DB", () => {
  const p = tmpDb();
  const db = openDatabase(p);
  const jid = randomUUID();
  db.prepare(
    `INSERT INTO import_jobs (id, started_at, status, summary_json) VALUES (?, datetime('now'), 'processing', '{}')`
  ).run(jid);
  const norm = normalizeArticle("ER1000");
  db.prepare(
    `INSERT INTO base_articles (base_art, base_art_normalized, base_name, source_filename, source_sheet, source_row, import_job_id)
     VALUES ('ER1000', ?, 'a', 'f1.xlsx', 'S', 2, ?)`
  ).run(norm, jid);
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO base_articles (base_art, base_art_normalized, base_name, source_filename, source_sheet, source_row, import_job_id)
       VALUES ('ER1000-B', ?, 'b', 'f2.xlsx', 'S', 3, ?)`
      )
      .run(norm, jid)
  );
  db.close();
  fs.unlinkSync(p);
});

test("search_variants: duplicate composite_art_normalized is rejected", () => {
  const p = tmpDb();
  const db = openDatabase(p);
  const jid = randomUUID();
  db.prepare(
    `INSERT INTO import_jobs (id, started_at, status, summary_json) VALUES (?, datetime('now'), 'processing', '{}')`
  ).run(jid);
  const bn = normalizeArticle("ER2000");
  const an = normalizeArticle("0001");
  db.prepare(
    `INSERT INTO base_articles (base_art, base_art_normalized, base_name, source_filename, source_sheet, source_row, import_job_id)
     VALUES ('ER2000', ?, 'b', 'f.xlsx', 'S', 2, ?)`
  ).run(bn, jid);
  db.prepare(
    `INSERT INTO add_articles (add_art, add_art_normalized, add_name, source_filename, source_sheet, source_row, import_job_id)
     VALUES ('0001', ?, 'a', 'f.xlsx', 'S', 3, ?)`
  ).run(an, jid);
  const bid = (db.prepare(`SELECT id FROM base_articles WHERE base_art_normalized = ?`).get(bn) as { id: number })
    .id;
  const aid = (db.prepare(`SELECT id FROM add_articles WHERE add_art_normalized = ?`).get(an) as { id: number })
    .id;
  const comp = "ER2000-0001";
  const compN = compositeNormalizedKey("ER2000", "0001");
  db.prepare(
    `INSERT INTO search_variants (
      base_article_id, add_article_id, base_art, add_art,
      composite_art_original, composite_art_normalized, base_name, add_name, display_name,
      source_filename, source_sheet, source_row_base, source_row_add, import_job_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    bid,
    aid,
    "ER2000",
    "0001",
    comp,
    compN,
    "b",
    "a",
    "b, a",
    "f.xlsx",
    "S+S",
    2,
    3,
    jid
  );
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO search_variants (
        base_article_id, add_article_id, base_art, add_art,
        composite_art_original, composite_art_normalized, base_name, add_name, display_name,
        source_filename, source_sheet, source_row_base, source_row_add, import_job_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        bid,
        aid,
        "ER2000",
        "0001",
        comp,
        compN,
        "b",
        "a",
        "b, a",
        "f.xlsx",
        "S+S",
        2,
        3,
        jid
      )
  );
  db.close();
  fs.unlinkSync(p);
});
