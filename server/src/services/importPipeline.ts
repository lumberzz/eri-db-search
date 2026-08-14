import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { mergeDisplayName } from "../domain/erArticles.js";
import {
  FileCombinationCollector,
  type FileAddArticle,
  type FileArticlePair,
  type FileBaseArticle,
} from "../domain/filePairs.js";
import { parseXlsxFileStream } from "../ingest/parseWorkbookStream.js";
import type { ParsedAddRow, ParsedBaseRow } from "../ingest/parseWorkbook.js";
import { compositeNormalizedKey, normalizeArticle } from "../normalize.js";
import {
  VARIANT_INSERT_BATCH,
  ROW_PARSE_YIELD_EVERY,
  MATERIALIZE_WARN_PAIRS,
  MATERIALIZE_LAZY_PAIRS,
  MATERIALIZE_REJECT_PAIRS,
} from "../config.js";
import { bumpSearchCacheGeneration } from "./searchCache.js";
import { mergeTopLevelProgress, patchJobFile } from "./importProgress.js";
import {
  decideMaterializationMode,
  type MaterializationMode,
} from "./materializationPolicy.js";

export type ImportFileSummary = {
  filename: string;
  fingerprint?: string;
  cacheHit?: boolean;
  duplicateFile?: boolean;
  materializationMode?: MaterializationMode;
  uniqueBases?: number;
  uniqueAdds?: number;
  estimatedPairs?: number;
  warnings?: string[];
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
  async?: boolean;
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
    cacheHits: number;
  };
  files: ImportFileSummary[];
  diagnostics?: Record<string, number | string>;
};

const IMPORT_CACHE_VERSION = 2;

function parseCachedFileSummary(
  raw: string
): {
  version: number;
  sheets: ImportFileSummary["sheets"];
  totals: Partial<ImportJobResult["totals"]>;
} {
  try {
    const parsed = JSON.parse(raw) as
      | {
          version?: number;
          sheets?: ImportFileSummary["sheets"];
          totals?: Partial<ImportJobResult["totals"]>;
        }
      | null;
    return {
      version: parsed?.version ?? 0,
      sheets: Array.isArray(parsed?.sheets) ? parsed.sheets : [],
      totals: parsed?.totals ?? {},
    };
  } catch {
    return { version: 0, sheets: [], totals: {} };
  }
}

export async function sha256File(
  filePath: string,
  onProgress?: (read: number, total: number) => void
): Promise<{ hash: string; size: number }> {
  const st = await stat(filePath);
  const total = st.size;
  const hash = createHash("sha256");
  let read = 0;
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(filePath);
    s.on("data", (chunk: string | Buffer) => {
      const c = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      read += c.length;
      hash.update(c);
      onProgress?.(read, total);
    });
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  return { hash: hash.digest("hex"), size: total };
}

function upsertBase(
  db: Database.Database,
  row: ParsedBaseRow,
  jobId: string
): boolean {
  const insert = db.prepare(
    `INSERT INTO base_articles (
      base_art, base_art_normalized, base_name,
      source_filename, source_sheet, source_row, import_job_id
    ) VALUES (@base_art, @base_art_normalized, @base_name,
      @source_filename, @source_sheet, @source_row, @import_job_id)
    ON CONFLICT(base_art_normalized) DO NOTHING`
  );
  const r = insert.run({
    base_art: row.baseArt.trim(),
    base_art_normalized: normalizeArticle(row.baseArt),
    base_name: row.baseName.trim(),
    source_filename: row.sourceFilename,
    source_sheet: row.sourceSheet,
    source_row: row.sourceRow,
    import_job_id: jobId,
  });
  return r.changes > 0;
}

function upsertAdd(db: Database.Database, row: ParsedAddRow, jobId: string): boolean {
  const insert = db.prepare(
    `INSERT INTO add_articles (
      add_art, add_art_normalized, add_name,
      source_filename, source_sheet, source_row, import_job_id
    ) VALUES (@add_art, @add_art_normalized, @add_name,
      @source_filename, @source_sheet, @source_row, @import_job_id)
    ON CONFLICT(add_art_normalized) DO NOTHING`
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
  return r.changes > 0;
}

type VariantInsertRow = {
  base_article_id: number;
  add_article_id: number;
  base_art: string;
  add_art: string;
  composite_art_original: string;
  composite_art_normalized: string;
  base_name: string;
  add_name: string;
  display_name: string;
  source_filename: string;
  source_sheet: string;
  source_row_base: number;
  source_row_add: number;
  import_job_id: string;
};

function clearVariantsForSourceFile(db: Database.Database, filename: string): void {
  const rows = db
    .prepare(`SELECT id FROM search_variants WHERE source_filename = ?`)
    .all(filename) as { id: number }[];
  if (rows.length === 0) return;
  const delFts = db.prepare(
    `INSERT INTO search_variants_fts(search_variants_fts, rowid, composite_art_normalized, display_name, base_name, add_name)
     VALUES ('delete', ?, '', '', '', '')`
  );
  const del = db.transaction((ids: number[]) => {
    for (const id of ids) delFts.run(id);
    db.prepare(`DELETE FROM search_variants WHERE source_filename = ?`).run(filename);
  });
  del(rows.map((r) => r.id));
}

function clearImportedFileMembership(
  db: Database.Database,
  filename: string
): void {
  db.prepare(`DELETE FROM imported_files WHERE original_filename = ?`).run(
    filename
  );
}

function upsertSearchVariant(
  db: Database.Database,
  row: VariantInsertRow
): "inserted" | "updated" | "skipped" {
  const existing = db
    .prepare(`SELECT id FROM search_variants WHERE composite_art_normalized = ?`)
    .get(row.composite_art_normalized) as { id: number } | undefined;

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO search_variants (
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
      )
      .run(row);
    const rowid = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO search_variants_fts (rowid, composite_art_normalized, display_name, base_name, add_name)
       VALUES (?,?,?,?,?)`
    ).run(rowid, row.composite_art_normalized, row.display_name, row.base_name, row.add_name);
    return "inserted";
  }

  db.prepare(
    `UPDATE search_variants SET
      base_article_id = @base_article_id,
      add_article_id = @add_article_id,
      base_art = @base_art,
      add_art = @add_art,
      composite_art_original = @composite_art_original,
      base_name = @base_name,
      add_name = @add_name,
      display_name = @display_name,
      source_filename = @source_filename,
      source_sheet = @source_sheet,
      source_row_base = @source_row_base,
      source_row_add = @source_row_add,
      import_job_id = @import_job_id
    WHERE id = @id`
  ).run({ ...row, id: existing.id });

  db.prepare(
    `INSERT INTO search_variants_fts(search_variants_fts, rowid, composite_art_normalized, display_name, base_name, add_name)
     VALUES ('delete', ?, '', '', '', '')`
  ).run(existing.id);
  db.prepare(
    `INSERT INTO search_variants_fts (rowid, composite_art_normalized, display_name, base_name, add_name)
     VALUES (?,?,?,?,?)`
  ).run(existing.id, row.composite_art_normalized, row.display_name, row.base_name, row.add_name);
  return "updated";
}

function registerImportedFileAndMembership(
  db: Database.Database,
  args: {
    jobId: string;
    filename: string;
    fingerprint: string;
    byteSize: number;
    mode: MaterializationMode;
    uniqueBases: number;
    uniqueAdds: number;
    estimatedPairs: number;
    warnings: string[];
    bases: FileBaseArticle[];
    adds: FileAddArticle[];
  }
): void {
  const insFile = db.prepare(
    `INSERT INTO imported_files (
      import_job_id, original_filename, fingerprint, byte_size, materialization_mode,
      unique_bases_count, unique_adds_count, estimated_pairs, warnings_json
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const importedFileId = Number(
    insFile.run(
      args.jobId,
      args.filename,
      args.fingerprint,
      args.byteSize,
      args.mode,
      args.uniqueBases,
      args.uniqueAdds,
      args.estimatedPairs,
      JSON.stringify(args.warnings)
    ).lastInsertRowid
  );
  if (importedFileId <= 0) return;

  const insertBaseMembership = db.prepare(
    `INSERT OR REPLACE INTO import_file_bases (
      imported_file_id, base_article_id, file_base_art, file_base_name,
      source_sheet, source_row
    )
    SELECT ?, b.id, ?, ?, ?, ?
    FROM base_articles b
    WHERE b.base_art_normalized = ?`
  );
  for (const base of args.bases) {
    insertBaseMembership.run(
      importedFileId,
      base.baseArt.trim(),
      base.baseName.trim(),
      base.sourceSheet,
      base.sourceRow,
      base.baseNorm
    );
  }

  const insertAddMembership = db.prepare(
    `INSERT OR REPLACE INTO import_file_adds (
      imported_file_id, add_article_id, file_add_art, file_add_name,
      source_sheet, source_row
    )
    SELECT ?, a.id, ?, ?, ?, ?
    FROM add_articles a
    WHERE a.add_art_normalized = ?`
  );
  for (const add of args.adds) {
    insertAddMembership.run(
      importedFileId,
      add.addArt.trim(),
      add.addName,
      add.sourceSheet,
      add.sourceRow,
      add.addNorm
    );
  }
}

export function materializeVariantsChunked(
  db: Database.Database,
  jobId: string,
  filename: string,
  pairs: FileArticlePair[],
  onChunk: (written: number, skipped: number, totalPairsProcessed: number) => void
): { inserted: number; skipped: number } {
  if (pairs.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  const lookupBase = db.prepare(
    `SELECT id, base_art FROM base_articles WHERE base_art_normalized = ?`
  );
  const lookupAdd = db.prepare(
    `SELECT id, add_art FROM add_articles WHERE add_art_normalized = ?`
  );

  let inserted = 0;
  let skipped = 0;
  let pairsProcessed = 0;

  const flushBatch = db.transaction((batch: VariantInsertRow[]) => {
    for (const p of batch) {
      const result = upsertSearchVariant(db, p);
      if (result === "inserted") inserted += 1;
      else if (result === "updated") inserted += 1;
      else skipped += 1;
    }
  });

  for (let i = 0; i < pairs.length; i += VARIANT_INSERT_BATCH) {
    const slice = pairs.slice(i, i + VARIANT_INSERT_BATCH);
    const acc: VariantInsertRow[] = [];

    for (const pair of slice) {
      const b = lookupBase.get(pair.baseNorm) as
        | { id: number; base_art: string }
        | undefined;
      const a = lookupAdd.get(pair.addNorm) as
        | { id: number; add_art: string }
        | undefined;
      if (!b || !a) continue;

      acc.push({
        base_article_id: b.id,
        add_article_id: a.id,
        base_art: pair.baseArt,
        add_art: pair.addArt,
        composite_art_original: `${pair.baseArt}-${pair.addArt}`,
        composite_art_normalized: compositeNormalizedKey(pair.baseArt, pair.addArt),
        base_name: pair.baseName,
        add_name: pair.addName,
        display_name: mergeDisplayName(pair.baseName, pair.addName),
        source_filename: filename,
        source_sheet: pair.sourceSheet,
        source_row_base: pair.sourceRowBase,
        source_row_add: pair.sourceRowAdd,
        import_job_id: jobId,
      });
      pairsProcessed += 1;
    }

    if (acc.length > 0) {
      flushBatch(acc);
    }
    onChunk(inserted, skipped, pairsProcessed);
  }

  return { inserted, skipped };
}

function fileVariantPercent(pairsProcessed: number, pairTotal: number): number {
  if (pairTotal <= 0) return 40;
  const v = 40 + Math.min(57, Math.floor((57 * pairsProcessed) / pairTotal));
  return v;
}

export async function runImportJob(
  db: Database.Database,
  jobId: string,
  files: { diskPath: string; originalname: string }[],
  options: {
    force?: boolean;
    enqueuedAt?: number;
    policyOverride?: { warnPairs: number; lazyPairs: number; rejectPairs: number };
  } = {}
): Promise<ImportJobResult> {
  const tJob0 = performance.now();
  const finalizeJob = db.prepare(
    `UPDATE import_jobs SET finished_at = ?, status = ?, summary_json = ?, diagnostics_json = ? WHERE id = ?`
  );
  const insertError = db.prepare(
    `INSERT INTO import_row_errors (import_job_id, filename, sheet, row_num, message) VALUES (?,?,?,?,?)`
  );
  const upsertCache = db.prepare(
    `INSERT OR REPLACE INTO import_file_cache (fingerprint, original_filename, byte_size, summary_json, source_job_id)
     VALUES (@fingerprint, @original_filename, @byte_size, @summary_json, @source_job_id)`
  );

  db.prepare(`UPDATE import_jobs SET status = ? WHERE id = ?`).run("processing", jobId);

  if (typeof options.enqueuedAt === "number") {
    mergeTopLevelProgress(db, jobId, {
      queueWaitMs: Math.max(0, Date.now() - options.enqueuedAt),
    });
  }
  mergeTopLevelProgress(db, jobId, {
    phase: "processing",
    processingStartedAt: new Date().toISOString(),
  });

  let rowsRead = 0;
  let rowsSkipped = 0;
  let errorsLogged = 0;
  let basesInserted = 0;
  let basesSkipped = 0;
  let addsInserted = 0;
  let addsSkipped = 0;
  let variantsInserted = 0;
  let variantsSkipped = 0;
  let cacheHits = 0;
  const fileSummaries: ImportFileSummary[] = [];
  const timings: Record<string, number> = {};
  let activeFileIndex = 0;

  try {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const f = files[fileIndex]!;
      activeFileIndex = fileIndex;
      const logicalName = f.originalname || path.basename(f.diskPath);
      try {

      patchJobFile(db, jobId, fileIndex, {
        status: "hashing",
        message: "Хеширование файла",
      });

      const { hash: fingerprint, size: byteSize } = await sha256File(
        f.diskPath,
        (read, total) => {
          const hp = total > 0 ? Math.min(7, Math.floor((7 * read) / total)) : 0;
          patchJobFile(db, jobId, fileIndex, {
            status: "hashing",
            percent: hp,
            message: `Хеширование ${read} / ${total} байт`,
          });
        }
      );

      patchJobFile(db, jobId, fileIndex, {
        status: "hashing",
        percent: 7,
        message: "Проверка кеша импорта",
      });

      if (!options.force) {
        const cached = db
          .prepare(
            `SELECT summary_json, source_job_id FROM import_file_cache WHERE fingerprint = ? AND original_filename = ?`
          )
          .get(fingerprint, logicalName) as
          | { summary_json: string; source_job_id: string }
          | undefined;
        if (cached) {
          const s = parseCachedFileSummary(cached.summary_json);
          if (s.version === IMPORT_CACHE_VERSION) {
            cacheHits += 1;
            rowsRead += s.totals?.rowsRead ?? 0;
            rowsSkipped += s.totals?.rowsSkipped ?? 0;
            errorsLogged += s.totals?.errorsLogged ?? 0;
            basesInserted += s.totals?.basesInserted ?? 0;
            basesSkipped += s.totals?.basesSkipped ?? 0;
            addsInserted += s.totals?.addsInserted ?? 0;
            addsSkipped += s.totals?.addsSkipped ?? 0;
            variantsInserted += s.totals?.variantsInserted ?? 0;
            variantsSkipped += s.totals?.variantsSkipped ?? 0;
            fileSummaries.push({
              filename: logicalName,
              fingerprint,
              cacheHit: true,
              duplicateFile: true,
              sheets: s.sheets || [],
            });
            patchJobFile(db, jobId, fileIndex, {
              status: "already_imported",
              percent: 100,
              message:
                "Файл уже импортирован (тот же fingerprint). Повторная обработка не требуется.",
              rowsProcessed: s.totals?.rowsRead ?? 0,
              rowsTotal: s.totals?.rowsRead ?? 0,
              basesFound: s.totals?.basesInserted ?? 0,
              addsFound: s.totals?.addsInserted ?? 0,
              variantsInserted: s.totals?.variantsInserted ?? 0,
              variantsSkipped: s.totals?.variantsSkipped ?? 0,
            });
            continue;
          }
        }
      }

      clearVariantsForSourceFile(db, logicalName);
      clearImportedFileMembership(db, logicalName);

      const combinationCollector = new FileCombinationCollector();
      let parseRows = 0;
      let parseBases = 0;
      let parseAdds = 0;
      let fileBasesInserted = 0;
      let fileBasesSkipped = 0;
      let fileAddsInserted = 0;
      let fileAddsSkipped = 0;
      let lastProgressFlush = 0;

      const flushParseProgress = () => {
        patchJobFile(db, jobId, fileIndex, {
          status: "parsing",
          rowsProcessed: parseRows,
          basesFound: combinationCollector.baseRows().length,
          addsFound: combinationCollector.addRows().length,
          percent: 7,
          message: `Разбор строк: ${parseRows}; баз (уник.): ${combinationCollector.baseRows().length}; добавок (уник.): ${combinationCollector.addRows().length}; комбинаций: ${combinationCollector.estimatedPairs}`,
        });
      };

      const tParse0 = performance.now();
      const sheetSummaries: ImportFileSummary["sheets"] = [];

      const { sheets: sheetAcc, timingMs } = await parseXlsxFileStream(
        f.diskPath,
        logicalName,
        {
          yieldEvery: ROW_PARSE_YIELD_EVERY,
          onRow: async (ev) => {
            if (ev.type === "issue") {
              insertError.run(
                jobId,
                ev.issue.filename,
                ev.issue.sheet,
                ev.issue.row,
                ev.issue.message
              );
              errorsLogged += 1;
              return;
            }
            if (ev.type === "base") {
              combinationCollector.onBase(ev.row);
              parseRows += 1;
              parseBases += 1;
              if (upsertBase(db, ev.row, jobId)) {
                basesInserted += 1;
                fileBasesInserted += 1;
              } else {
                basesSkipped += 1;
                fileBasesSkipped += 1;
              }
            } else if (ev.type === "add") {
              combinationCollector.onAdd(ev.row);
              parseRows += 1;
              parseAdds += 1;
              if (upsertAdd(db, ev.row, jobId)) {
                addsInserted += 1;
                fileAddsInserted += 1;
              } else {
                addsSkipped += 1;
                fileAddsSkipped += 1;
              }
            }
            lastProgressFlush += 1;
            if (lastProgressFlush >= 40) {
              lastProgressFlush = 0;
              flushParseProgress();
            }
          },
        }
      );

      flushParseProgress();
      const rowsTotal = sheetAcc.reduce((a, s) => a + s.rowsRead, 0) || parseRows;
      patchJobFile(db, jobId, fileIndex, {
        status: "parsing",
        percent: 40,
        rowsProcessed: parseRows,
        rowsTotal,
        basesFound: combinationCollector.baseRows().length,
        addsFound: combinationCollector.addRows().length,
        message: "Парсинг завершён",
      });

      timings[`parse_${logicalName}`] = Math.round(performance.now() - tParse0);
      timings.parse_stream_reported = timingMs.parse;

      for (const sh of sheetAcc) {
        rowsRead += sh.rowsRead;
        rowsSkipped += sh.rowsSkipped;
        sheetSummaries.push({
          sheet: sh.sheet,
          rowsRead: sh.rowsRead,
          baseRows: sh.baseRows,
          addRows: sh.addRows,
          rowsSkipped: sh.rowsSkipped,
          issueCount: sh.issueCount,
        });
      }

      const fileBases = combinationCollector.baseRows();
      const fileAdds = combinationCollector.addRows();
      const variantPairTotal = combinationCollector.estimatedPairs;
      const decision = decideMaterializationMode(
        fileBases.length,
        fileAdds.length,
        variantPairTotal,
        options.policyOverride ?? {
          warnPairs: MATERIALIZE_WARN_PAIRS,
          lazyPairs: MATERIALIZE_LAZY_PAIRS,
          rejectPairs: MATERIALIZE_REJECT_PAIRS,
        }
      );

      let vi = 0;
      let vs = 0;
      if (decision.mode === "lazy") {
        patchJobFile(db, jobId, fileIndex, {
          status: "saving",
          percent: 96,
          variantPairsTotal: variantPairTotal,
          variantPairsProcessed: 0,
          variantsInserted: 0,
          variantsSkipped: variantPairTotal,
          message:
            "Lazy mode: полная materialization пропущена, поиск будет synthetic.",
        });
      } else {
        patchJobFile(db, jobId, fileIndex, {
          status: "generating_variants",
          percent: 40,
          variantPairsTotal: variantPairTotal,
          variantPairsProcessed: 0,
          message:
            "Генерация составных артикулов (все базы × все добавочные коды файла)",
        });
        const tVar0 = performance.now();
        const filePairs = combinationCollector.pairs();
        const out = materializeVariantsChunked(
          db,
          jobId,
          logicalName,
          filePairs,
          (ins, sk, proc) => {
            patchJobFile(db, jobId, fileIndex, {
              status: "generating_variants",
              variantsInserted: ins,
              variantsSkipped: sk,
              variantPairsProcessed: proc,
              variantPairsTotal: variantPairTotal,
              percent: fileVariantPercent(proc, variantPairTotal),
              message: `Пары: ${proc} / ${variantPairTotal}; новых вариантов: ${ins}; пропуск (уже в БД): ${sk}`,
            });
          }
        );
        vi = out.inserted;
        vs = out.skipped;
        timings[`variants_${logicalName}`] = Math.round(performance.now() - tVar0);
      }
      variantsInserted += vi;
      variantsSkipped += vs;

      patchJobFile(db, jobId, fileIndex, {
        status: "saving",
        percent: 97,
        variantsInserted: vi,
        variantsSkipped: decision.mode === "lazy" ? variantPairTotal : vs,
        message: "Сохранение метаданных импорта",
      });

      registerImportedFileAndMembership(db, {
        jobId,
        filename: logicalName,
        fingerprint,
        byteSize,
        mode: decision.mode,
        uniqueBases: fileBases.length,
        uniqueAdds: fileAdds.length,
        estimatedPairs: variantPairTotal,
        warnings: decision.warnings,
        bases: fileBases,
        adds: fileAdds,
      });

      const fileSummary: ImportFileSummary = {
        filename: logicalName,
        fingerprint,
        cacheHit: false,
        materializationMode: decision.mode,
        uniqueBases: fileBases.length,
        uniqueAdds: fileAdds.length,
        estimatedPairs: variantPairTotal,
        warnings: decision.warnings,
        sheets: sheetSummaries,
      };
      fileSummaries.push(fileSummary);

      upsertCache.run({
        fingerprint,
        original_filename: logicalName,
        byte_size: byteSize,
        summary_json: JSON.stringify({
          version: IMPORT_CACHE_VERSION,
          sheets: sheetSummaries,
          totals: {
            rowsRead: sheetAcc.reduce((a, s) => a + s.rowsRead, 0),
            rowsSkipped: sheetAcc.reduce((a, s) => a + s.rowsSkipped, 0),
            errorsLogged: sheetAcc.reduce((a, s) => a + s.issueCount, 0),
            basesInserted: fileBasesInserted,
            basesSkipped: fileBasesSkipped,
            addsInserted: fileAddsInserted,
            addsSkipped: fileAddsSkipped,
            variantsInserted: vi,
            variantsSkipped: decision.mode === "lazy" ? variantPairTotal : vs,
          },
        }),
        source_job_id: jobId,
      });

      patchJobFile(db, jobId, fileIndex, {
        status: "completed",
        percent: 100,
        variantsInserted: vi,
        variantsSkipped: decision.mode === "lazy" ? variantPairTotal : vs,
        variantPairsProcessed:
          decision.mode === "lazy" ? 0 : variantPairTotal,
        variantPairsTotal: variantPairTotal,
        message:
          decision.mode === "lazy"
            ? "Готово (lazy mode, без полной materialization)"
            : "Готово",
      });
      } catch (fileErr) {
        const msg = fileErr instanceof Error ? fileErr.message : String(fileErr);
        patchJobFile(db, jobId, fileIndex, {
          status: "failed",
          percent: 100,
          error: msg,
          message: msg,
        });
        fileSummaries.push({
          filename: logicalName,
          cacheHit: false,
          warnings: [msg],
          sheets: [],
        });
      }
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
        cacheHits,
      },
      files: fileSummaries,
      diagnostics: {
        ...timings,
        jobTotalMs: Math.round(performance.now() - tJob0),
      },
    };

    finalizeJob.run(
      new Date().toISOString(),
      "completed",
      JSON.stringify(summary),
      JSON.stringify({ timings, jobTotalMs: summary.diagnostics?.jobTotalMs }),
      jobId
    );

    bumpSearchCacheGeneration();
    return summary;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const curIdx =
      files.length === 0 ? 0 : Math.max(0, Math.min(files.length - 1, activeFileIndex));
    patchJobFile(db, jobId, curIdx, {
      status: "failed",
      percent: 100,
      error: msg,
      message: msg,
    });

    const summary: ImportJobResult = {
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
        variantsInserted,
        variantsSkipped,
        cacheHits,
      },
      files: fileSummaries,
      diagnostics: { jobTotalMs: Math.round(performance.now() - tJob0), error: msg },
    };
    finalizeJob.run(
      new Date().toISOString(),
      "failed",
      JSON.stringify(summary),
      JSON.stringify({ error: msg }),
      jobId
    );
    return summary;
  } finally {
    for (const f of files) {
      try {
        fs.unlinkSync(f.diskPath);
      } catch {
        /* ignore */
      }
    }
    try {
      const dir = path.dirname(files[0]?.diskPath || "");
      if (dir && fs.existsSync(dir)) {
        const left = fs.readdirSync(dir);
        if (left.length === 0) fs.rmdirSync(dir);
      }
    } catch {
      /* ignore */
    }
  }
}
