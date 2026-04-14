import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const LEGACY_DROP = `
DROP TABLE IF EXISTS items_fts;
DROP TABLE IF EXISTS items;
`;

/** Схема для новых установок и после миграций. */
const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  progress_json TEXT NOT NULL DEFAULT '{}',
  diagnostics_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS import_file_cache (
  fingerprint TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (fingerprint, original_filename)
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

CREATE VIRTUAL TABLE IF NOT EXISTS search_variants_fts USING fts5(
  composite_art_normalized,
  display_name,
  base_name,
  add_name,
  content='',
  tokenize='unicode61 remove_diacritics 1',
  prefix='2 3 4 5 6 7 8 9 10'
);

CREATE TABLE IF NOT EXISTS imported_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_job_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  materialization_mode TEXT NOT NULL,
  unique_bases_count INTEGER NOT NULL,
  unique_adds_count INTEGER NOT NULL,
  estimated_pairs INTEGER NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_file_bases (
  imported_file_id INTEGER NOT NULL,
  base_article_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (imported_file_id, base_article_id),
  FOREIGN KEY (imported_file_id) REFERENCES imported_files(id) ON DELETE CASCADE,
  FOREIGN KEY (base_article_id) REFERENCES base_articles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_file_adds (
  imported_file_id INTEGER NOT NULL,
  add_article_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (imported_file_id, add_article_id),
  FOREIGN KEY (imported_file_id) REFERENCES imported_files(id) ON DELETE CASCADE,
  FOREIGN KEY (add_article_id) REFERENCES add_articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_base_file ON base_articles(source_filename);
CREATE INDEX IF NOT EXISTS idx_add_file ON add_articles(source_filename);
CREATE INDEX IF NOT EXISTS idx_sv_orig ON search_variants(composite_art_original);
CREATE INDEX IF NOT EXISTS idx_sv_base_art ON search_variants(base_art);
CREATE INDEX IF NOT EXISTS idx_sv_add_art ON search_variants(add_art);
CREATE INDEX IF NOT EXISTS idx_import_errors_job ON import_row_errors(import_job_id);
CREATE INDEX IF NOT EXISTS idx_imported_files_fingerprint ON imported_files(fingerprint);
CREATE INDEX IF NOT EXISTS idx_imported_files_mode ON imported_files(materialization_mode);
CREATE INDEX IF NOT EXISTS idx_ifb_base_id ON import_file_bases(base_article_id);
CREATE INDEX IF NOT EXISTS idx_ifa_add_id ON import_file_adds(add_article_id);
`;

function migrateLegacyImportJobs(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(import_jobs)`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("progress_json")) {
    db.exec(`ALTER TABLE import_jobs ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}';`);
  }
  if (!names.has("diagnostics_json")) {
    db.exec(`ALTER TABLE import_jobs ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}';`);
  }
}

/** Глобальная дедупликация + уникальные индексы по нормализованным ключам. */
function migrateGlobalDedupeV2(db: Database.Database): void {
  const v = db.pragma("user_version", { simple: true }) as number;
  if (v >= 2) return;

  const hasNew = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='index' AND name='ux_base_art_normalized'`
    )
    .get();
  if (hasNew) {
    db.pragma("user_version = 2");
    return;
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(`
      UPDATE search_variants SET base_article_id = (
        SELECT MIN(b.id) FROM base_articles b
        WHERE b.base_art_normalized = (
          SELECT base_art_normalized FROM base_articles WHERE id = search_variants.base_article_id
        )
      );

      UPDATE search_variants SET add_article_id = (
        SELECT MIN(a.id) FROM add_articles a
        WHERE a.add_art_normalized = (
          SELECT add_art_normalized FROM add_articles WHERE id = search_variants.add_article_id
        )
      );

      DELETE FROM base_articles WHERE id NOT IN (
        SELECT MIN(id) FROM base_articles GROUP BY base_art_normalized
      );

      DELETE FROM add_articles WHERE id NOT IN (
        SELECT MIN(id) FROM add_articles GROUP BY add_art_normalized
      );

      DELETE FROM search_variants_fts WHERE rowid IN (
        SELECT id FROM search_variants WHERE id NOT IN (
          SELECT MIN(id) FROM search_variants GROUP BY composite_art_normalized
        )
      );

      DELETE FROM search_variants WHERE id NOT IN (
        SELECT MIN(id) FROM search_variants GROUP BY composite_art_normalized
      );
    `);

    db.exec(`
      DROP INDEX IF EXISTS ux_base_source_row;
      DROP INDEX IF EXISTS ux_add_source_row;
      DROP INDEX IF EXISTS ux_variant_pair;
      DROP INDEX IF EXISTS idx_base_norm;
      DROP INDEX IF EXISTS idx_add_norm;
      DROP INDEX IF EXISTS idx_sv_norm;
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_base_art_normalized ON base_articles(base_art_normalized);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_add_art_normalized ON add_articles(add_art_normalized);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_sv_composite_norm ON search_variants(composite_art_normalized);
    `);

    db.exec("COMMIT;");
    db.pragma("user_version = 2");
  } catch (e) {
    db.exec("ROLLBACK;");
    throw e;
  }
}

function migrateLazyMembershipV3(db: Database.Database): void {
  const v = db.pragma("user_version", { simple: true }) as number;
  if (v >= 3) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS imported_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_job_id TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      materialization_mode TEXT NOT NULL,
      unique_bases_count INTEGER NOT NULL,
      unique_adds_count INTEGER NOT NULL,
      estimated_pairs INTEGER NOT NULL,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS import_file_bases (
      imported_file_id INTEGER NOT NULL,
      base_article_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (imported_file_id, base_article_id),
      FOREIGN KEY (imported_file_id) REFERENCES imported_files(id) ON DELETE CASCADE,
      FOREIGN KEY (base_article_id) REFERENCES base_articles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS import_file_adds (
      imported_file_id INTEGER NOT NULL,
      add_article_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (imported_file_id, add_article_id),
      FOREIGN KEY (imported_file_id) REFERENCES imported_files(id) ON DELETE CASCADE,
      FOREIGN KEY (add_article_id) REFERENCES add_articles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_imported_files_fingerprint ON imported_files(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_imported_files_mode ON imported_files(materialization_mode);
    CREATE INDEX IF NOT EXISTS idx_ifb_base_id ON import_file_bases(base_article_id);
    CREATE INDEX IF NOT EXISTS idx_ifa_add_id ON import_file_adds(add_article_id);
  `);
  db.pragma("user_version = 3");
}

function ensureIndexesFreshInstall(db: Database.Database): void {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='ux_base_art_normalized'`)
    .get();
  if (!row) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_base_art_normalized ON base_articles(base_art_normalized);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_add_art_normalized ON add_articles(add_art_normalized);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_sv_composite_norm ON search_variants(composite_art_normalized);
    `);
  }
}

function applyPerformancePragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -64000");
  db.pragma("mmap_size = 268435456");
}

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
  migrateLegacyImportJobs(db);
  migrateGlobalDedupeV2(db);
  migrateLazyMembershipV3(db);
  ensureIndexesFreshInstall(db);
  applyPerformancePragmas(db);
  return db;
}
