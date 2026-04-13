import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const LEGACY_DROP = `
DROP TABLE IF EXISTS items_fts;
DROP TABLE IF EXISTS items;
`;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS import_row_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_job_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  sheet TEXT NOT NULL,
  row_num INTEGER NOT NULL,
  message TEXT NOT NULL,
  FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS base_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_art TEXT NOT NULL,
  base_art_normalized TEXT NOT NULL,
  base_name TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  import_job_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_base_source_row
  ON base_articles(source_filename, source_sheet, source_row);

CREATE INDEX IF NOT EXISTS idx_base_norm ON base_articles(base_art_normalized);
CREATE INDEX IF NOT EXISTS idx_base_file ON base_articles(source_filename);

CREATE TABLE IF NOT EXISTS add_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  add_art TEXT NOT NULL,
  add_art_normalized TEXT NOT NULL,
  add_name TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  import_job_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_add_source_row
  ON add_articles(source_filename, source_sheet, source_row);

CREATE INDEX IF NOT EXISTS idx_add_file ON add_articles(source_filename);
CREATE INDEX IF NOT EXISTS idx_add_norm ON add_articles(add_art_normalized);

CREATE TABLE IF NOT EXISTS search_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_article_id INTEGER NOT NULL,
  add_article_id INTEGER NOT NULL,
  base_art TEXT NOT NULL,
  add_art TEXT NOT NULL,
  composite_art_original TEXT NOT NULL,
  composite_art_normalized TEXT NOT NULL,
  base_name TEXT NOT NULL,
  add_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row_base INTEGER NOT NULL,
  source_row_add INTEGER NOT NULL,
  import_job_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (base_article_id) REFERENCES base_articles(id) ON DELETE CASCADE,
  FOREIGN KEY (add_article_id) REFERENCES add_articles(id) ON DELETE CASCADE,
  FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_variant_pair
  ON search_variants(base_article_id, add_article_id);

CREATE INDEX IF NOT EXISTS idx_sv_norm ON search_variants(composite_art_normalized);
CREATE INDEX IF NOT EXISTS idx_sv_orig ON search_variants(composite_art_original);

CREATE VIRTUAL TABLE IF NOT EXISTS search_variants_fts USING fts5(
  composite_art_normalized,
  display_name,
  base_name,
  add_name,
  content='',
  tokenize='unicode61 remove_diacritics 1',
  prefix='2 3 4 5 6 7 8 9 10'
);

CREATE INDEX IF NOT EXISTS idx_import_errors_job ON import_row_errors(import_job_id);
`;

export function openDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");

  const legacy = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='items'`)
    .get();
  if (legacy) {
    db.exec(LEGACY_DROP);
  }

  db.exec(SCHEMA);
  return db;
}
