import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mergeDisplayName } from "../domain/erArticles.js";
import { parseXlsxBuffer } from "../ingest/parseWorkbook.js";
import type { ParsedAddRow, ParsedBaseRow } from "../ingest/parseWorkbook.js";
import { compositeNormalizedKey, normalizeArticle } from "../normalize.js";

export type ImportFileSummary = {
  filename: string;
  sheets: {
    sheet: string;
    rowsRead: number;
    baseRows: number;
    addRows: number;
    rowsSkipped: number;
    issueCount: number;
  }[];
};

export type ImportJobResult = {
  jobId: string;
  status: "completed" | "failed";
  message?: string;
  totals: {
    rowsRead: number;
    rowsSkipped: number;
    errorsLogged: number;
    basesInserted: number;
    basesSkipped: number;
    addsInserted: number;
    addsSkipped: number;
    variantsInserted: number;
    variantsSkipped: number;
  };
  files: ImportFileSummary[];
};

function materializeVariantsForFile(
  db: Database.Database,
  jobId: string,
  filename: string
): { inserted: number; skipped: number } {
  const bases = db
    .prepare(
      `SELECT id, base_art, base_name, source_sheet, source_row
       FROM base_articles WHERE source_filename = ?`
    )
    .all(filename) as {
    id: number;
    base_art: string;
    base_name: string;
    source_sheet: string;
    source_row: number;
  }[];

  const adds = db
    .prepare(
      `SELECT id, add_art, add_name, add_art_normalized, source_sheet, source_row
       FROM add_articles WHERE source_filename = ?`
    )
    .all(filename) as {
    id: number;
    add_art: string;
    add_name: string;
    add_art_normalized: string;
    source_sheet: string;
    source_row: number;
  }[];

  const byNorm = new Map<string, (typeof adds)[0]>();
  for (const a of adds) {
    const cur = byNorm.get(a.add_art_normalized);
    if (!cur || a.id > cur.id) byNorm.set(a.add_art_normalized, a);
  }
  const uniqAdds = [...byNorm.values()];

  let inserted = 0;
  let skipped = 0;

  const insertVar = db.prepare(
    `INSERT OR IGNORE INTO search_variants (
      base_article_id, add_article_id,
      base_art, add_art,
      composite_art_original, composite_art_normalized,
      base_name, add_name, display_name,
      source_filename, source_sheet, source_row_base, source_row_add,
      import_job_id
    ) VALUES (
      @base_article_id, @add_article_id,
      @base_art, @add_art,
      @composite_art_original, @composite_art_normalized,
      @base_name, @add_name, @display_name,
      @source_filename, @source_sheet, @source_row_base, @source_row_add,
      @import_job_id
    )`
  );

  const insertFts = db.prepare(
    `INSERT INTO search_variants_fts (rowid, composite_art_normalized, display_name, base_name, add_name)
     VALUES (?,?,?,?,?)`
  );

  for (const b of bases) {
    for (const a of uniqAdds) {
      const compositeOriginal = `${b.base_art}-${a.add_art}`;
      const compositeNorm = compositeNormalizedKey(b.base_art, a.add_art);
      const displayName = mergeDisplayName(b.base_name, a.add_name);
      const info = insertVar.run({
        base_article_id: b.id,
        add_article_id: a.id,
        base_art: b.base_art,
        add_art: a.add_art,
        composite_art_original: compositeOriginal,
        composite_art_normalized: compositeNorm,
        base_name: b.base_name,
        add_name: a.add_name,
        display_name: displayName,
        source_filename: filename,
        source_sheet: `${b.source_sheet} + ${a.source_sheet}`,
        source_row_base: b.source_row,
        source_row_add: a.source_row,
        import_job_id: jobId,
      });
      if (info.changes > 0) {
        const rowid = Number(info.lastInsertRowid);
        insertFts.run(
          rowid,
          compositeNorm,
          displayName,
          b.base_name,
          a.add_name
        );
        inserted += 1;
      } else {
        skipped += 1;
      }
    }
  }

  return { inserted, skipped };
}

function upsertBase(
  db: Database.Database,
  row: ParsedBaseRow,
  jobId: string
): { inserted: boolean } {
  const insert = db.prepare(
    `INSERT INTO base_articles (
      base_art, base_art_normalized, base_name,
      source_filename, source_sheet, source_row, import_job_id
    ) VALUES (@base_art, @base_art_normalized, @base_name,
      @source_filename, @source_sheet, @source_row, @import_job_id)
    ON CONFLICT(source_filename, source_sheet, source_row) DO NOTHING`
  );
  const norm = normalizeArticle(row.baseArt);
  const r = insert.run({
    base_art: row.baseArt.trim(),
    base_art_normalized: norm,
    base_name: row.baseName.trim(),
    source_filename: row.sourceFilename,
    source_sheet: row.sourceSheet,
    source_row: row.sourceRow,
    import_job_id: jobId,
  });
  return { inserted: r.changes > 0 };
}

function upsertAdd(
  db: Database.Database,
  row: ParsedAddRow,
  jobId: string
): { inserted: boolean } {
  const insert = db.prepare(
    `INSERT INTO add_articles (
      add_art, add_art_normalized, add_name,
      source_filename, source_sheet, source_row, import_job_id
    ) VALUES (@add_art, @add_art_normalized, @add_name,
      @source_filename, @source_sheet, @source_row, @import_job_id)
    ON CONFLICT(source_filename, source_sheet, source_row) DO NOTHING`
  );
  const t = row.addArt.trim();
  const r = insert.run({
    add_art: t,
    add_art_normalized: normalizeArticle(t),
    add_name: row.addName,
    source_filename: row.sourceFilename,
    source_sheet: row.sourceSheet,
    source_row: row.sourceRow,
    import_job_id: jobId,
  });
  return { inserted: r.changes > 0 };
}

export async function runImport(
  db: Database.Database,
  files: { buffer: Buffer; originalname: string }[]
): Promise<ImportJobResult> {
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();

  const insertJob = db.prepare(
    `INSERT INTO import_jobs (id, started_at, status, summary_json) VALUES (?, ?, 'running', '{}')`
  );
  const finalizeJob = db.prepare(
    `UPDATE import_jobs SET finished_at = ?, status = ?, summary_json = ? WHERE id = ?`
  );
  const insertError = db.prepare(
    `INSERT INTO import_row_errors (import_job_id, filename, sheet, row_num, message) VALUES (?,?,?,?,?)`
  );

  insertJob.run(jobId, startedAt);

  let rowsRead = 0;
  let rowsSkipped = 0;
  let errorsLogged = 0;
  let basesInserted = 0;
  let basesSkipped = 0;
  let addsInserted = 0;
  let addsSkipped = 0;
  let variantsInserted = 0;
  let variantsSkipped = 0;
  const fileSummaries: ImportFileSummary[] = [];

  try {
    for (const file of files) {
      const name = file.originalname || "upload.xlsx";
      const parsed = await parseXlsxBuffer(file.buffer, name);
      const sheetSummaries: ImportFileSummary["sheets"] = [];

      const runFile = db.transaction(() => {
        for (const sh of parsed.sheets) {
          rowsRead += sh.rowsRead;
          rowsSkipped += sh.rowsSkipped;
          for (const issue of sh.issues) {
            insertError.run(jobId, issue.filename, issue.sheet, issue.row, issue.message);
            errorsLogged += 1;
          }

          for (const b of sh.bases) {
            const { inserted } = upsertBase(db, b, jobId);
            if (inserted) basesInserted += 1;
            else basesSkipped += 1;
          }
          for (const a of sh.adds) {
            const { inserted } = upsertAdd(db, a, jobId);
            if (inserted) addsInserted += 1;
            else addsSkipped += 1;
          }

          sheetSummaries.push({
            sheet: sh.sheet,
            rowsRead: sh.rowsRead,
            baseRows: sh.bases.length,
            addRows: sh.adds.length,
            rowsSkipped: sh.rowsSkipped,
            issueCount: sh.issues.length,
          });
        }

        const { inserted, skipped } = materializeVariantsForFile(db, jobId, parsed.filename);
        variantsInserted += inserted;
        variantsSkipped += skipped;
      });

      runFile();
      fileSummaries.push({ filename: parsed.filename, sheets: sheetSummaries });
    }

    const summary: ImportJobResult = {
      jobId,
      status: "completed",
      totals: {
        rowsRead,
        rowsSkipped,
        errorsLogged,
        basesInserted,
        basesSkipped,
        addsInserted,
        addsSkipped,
        variantsInserted,
        variantsSkipped,
      },
      files: fileSummaries,
    };

    finalizeJob.run(new Date().toISOString(), "completed", JSON.stringify(summary), jobId);

    return summary;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finalizeJob.run(
      new Date().toISOString(),
      "failed",
      JSON.stringify({ error: msg }),
      jobId
    );
    return {
      jobId,
      status: "failed",
      message: msg,
      totals: {
        rowsRead,
        rowsSkipped,
        errorsLogged,
        basesInserted,
        basesSkipped,
        addsInserted,
        addsSkipped,
        variantsInserted: 0,
        variantsSkipped: 0,
      },
      files: fileSummaries,
    };
  }
}
