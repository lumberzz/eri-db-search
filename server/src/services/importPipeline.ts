import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { mergeDisplayName } from "../domain/erArticles.js";
import { parseXlsxFileStream } from "../ingest/parseWorkbookStream.js";
import type { ParsedAddRow, ParsedBaseRow } from "../ingest/parseWorkbook.js";
import { compositeNormalizedKey, normalizeArticle } from "../normalize.js";
import {
  VARIANT_INSERT_BATCH,
  ROW_PARSE_YIELD_EVERY,
  BASE_ARTICLE_PAGE,
  ADD_ARTICLE_PAGE,
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

function parseCachedFileSummary(
  raw: string
): { sheets: ImportFileSummary["sheets"]; totals: Partial<ImportJobResult["totals"]> } {
  try {
    const parsed = JSON.parse(raw) as
      | {
          sheets?: ImportFileSummary["sheets"];
          totals?: Partial<ImportJobResult["totals"]>;
        }
      | null;
    return {
      sheets: Array.isArray(parsed?.sheets) ? parsed.sheets : [],
      totals: parsed?.totals ?? {},
    };
  } catch {
    return { sheets: [], totals: {} };
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

type UniqAdd = {
  id: number;
  add_art: string;
  add_name: string;
  add_art_normalized: string;
  source_sheet: string;
  source_row: number;
};

type BaseRow = {
  id: number;
  base_art: string;
  base_name: string;
  source_sheet: string;
  source_row: number;
};

function fillTempNorms(
  db: Database.Database,
  bases: Set<string>,
  adds: Set<string>
): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS _imp_file_bases (norm TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS _imp_file_adds (norm TEXT PRIMARY KEY);
  `);
  db.exec(`DELETE FROM _imp_file_bases; DELETE FROM _imp_file_adds;`);
  const ib = db.prepare(`INSERT OR IGNORE INTO _imp_file_bases (norm) VALUES (?)`);
  const ia = db.prepare(`INSERT OR IGNORE INTO _imp_file_adds (norm) VALUES (?)`);
  for (const n of bases) ib.run(n);
  for (const n of adds) ia.run(n);
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
    baseNorms: Set<string>;
    addNorms: Set<string>;
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

  fillTempNorms(db, args.baseNorms, args.addNorms);
  db.prepare(
    `INSERT OR IGNORE INTO import_file_bases (imported_file_id, base_article_id)
     SELECT ?, b.id FROM base_articles b
     INNER JOIN _imp_file_bases t ON b.base_art_normalized = t.norm`
  ).run(importedFileId);
  db.prepare(
    `INSERT OR IGNORE INTO import_file_adds (imported_file_id, add_article_id)
     SELECT ?, a.id FROM add_articles a
     INNER JOIN _imp_file_adds t ON a.add_art_normalized = t.norm`
  ).run(importedFileId);
}

export function materializeVariantsChunked(
  db: Database.Database,
  jobId: string,
  filename: string,
  baseNorms: Set<string>,
  addNorms: Set<string>,
  onChunk: (written: number, skipped: number, totalPairsProcessed: number) => void
): { inserted: number; skipped: number } {
  if (baseNorms.size === 0 || addNorms.size === 0) {
    return { inserted: 0, skipped: 0 };
  }

  fillTempNorms(db, baseNorms, addNorms);

  const insertVar = db.prepare(
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
    )
    ON CONFLICT(composite_art_normalized) DO NOTHING`
  );

  const insertFts = db.prepare(
    `INSERT INTO search_variants_fts (rowid, composite_art_normalized, display_name, base_name, add_name)
     VALUES (?,?,?,?,?)`
  );

  const stmtBasesPage = db.prepare(
    `SELECT b.id, b.base_art, b.base_name, b.source_sheet, b.source_row
     FROM base_articles b
     INNER JOIN _imp_file_bases t ON b.base_art_normalized = t.norm
     WHERE b.id > ?
     ORDER BY b.id
     LIMIT ?`
  );

  const stmtAddsPage = db.prepare(
    `SELECT a.id, a.add_art, a.add_name, a.add_art_normalized, a.source_sheet, a.source_row
     FROM add_articles a
     INNER JOIN _imp_file_adds t ON a.add_art_normalized = t.norm
     WHERE a.id > ?
     ORDER BY a.id
     LIMIT ?`
  );

  let inserted = 0;
  let skipped = 0;
  let pairsProcessed = 0;
  let lastBaseId = 0;

  while (true) {
    const bases = stmtBasesPage.all(lastBaseId, BASE_ARTICLE_PAGE) as BaseRow[];
    if (bases.length === 0) break;

    const flushBatch = db.transaction(
      (
        batch: {
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
        }[]
      ) => {
        for (const p of batch) {
          const info = insertVar.run(p);
          if (info.changes > 0) {
            insertFts.run(
              Number(info.lastInsertRowid),
              p.composite_art_normalized,
              p.display_name,
              p.base_name,
              p.add_name
            );
            inserted += 1;
          } else {
            skipped += 1;
          }
        }
      }
    );

    let lastAddId = 0;
    for (;;) {
      const adds = stmtAddsPage.all(lastAddId, ADD_ARTICLE_PAGE) as UniqAdd[];
      if (adds.length === 0) break;

      let acc: Parameters<typeof flushBatch>[0] = [];

      for (const b of bases) {
        for (const a of adds) {
          const compositeOriginal = `${b.base_art}-${a.add_art}`;
          const compositeNorm = compositeNormalizedKey(b.base_art, a.add_art);
          const displayName = mergeDisplayName(b.base_name, a.add_name);
          acc.push({
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
          pairsProcessed += 1;

          if (acc.length >= VARIANT_INSERT_BATCH) {
            flushBatch(acc);
            acc = [];
            onChunk(inserted, skipped, pairsProcessed);
          }
        }
      }

      if (acc.length > 0) {
        flushBatch(acc);
        onChunk(inserted, skipped, pairsProcessed);
      }

      lastAddId = adds[adds.length - 1]!.id;
    }

    lastBaseId = bases[bases.length - 1]!.id;
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

      const baseNormsThisFile = new Set<string>();
      const addNormsThisFile = new Set<string>();
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
          basesFound: baseNormsThisFile.size,
          addsFound: addNormsThisFile.size,
          percent: 7,
          message: `Разбор строк: ${parseRows}; баз (уник.): ${baseNormsThisFile.size}; добавок (уник.): ${addNormsThisFile.size}`,
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
              const norm = normalizeArticle(ev.row.baseArt);
              baseNormsThisFile.add(norm);
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
              const norm = normalizeArticle(ev.row.addArt);
              addNormsThisFile.add(norm);
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
        basesFound: baseNormsThisFile.size,
        addsFound: addNormsThisFile.size,
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

      const variantPairTotal = baseNormsThisFile.size * addNormsThisFile.size;
      const decision = decideMaterializationMode(
        baseNormsThisFile.size,
        addNormsThisFile.size,
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
            "Генерация составных артикулов (декартово произведение уникальных баз × добавок файла)",
        });
        const tVar0 = performance.now();
        const out = materializeVariantsChunked(
          db,
          jobId,
          logicalName,
          baseNormsThisFile,
          addNormsThisFile,
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
        uniqueBases: baseNormsThisFile.size,
        uniqueAdds: addNormsThisFile.size,
        estimatedPairs: variantPairTotal,
        warnings: decision.warnings,
        baseNorms: baseNormsThisFile,
        addNorms: addNormsThisFile,
      });

      const fileSummary: ImportFileSummary = {
        filename: logicalName,
        fingerprint,
        cacheHit: false,
        materializationMode: decision.mode,
        uniqueBases: baseNormsThisFile.size,
        uniqueAdds: addNormsThisFile.size,
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
