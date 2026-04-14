import type Database from "better-sqlite3";
import { collapseSpaces, normalizeCompositeSearchInput } from "../normalize.js";
import type { SearchHit } from "../types/searchHit.js";
import {
  currentSearchCacheGeneration,
  searchCacheGet,
  searchCacheSet,
} from "./searchCache.js";
import {
  LAZY_SEARCH_CANDIDATE_LIMIT,
  LAZY_SEARCH_SCOPE_LIMIT,
} from "../config.js";

export type { SearchHit };

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Убрать все пробельные символы, верхний регистр — для сравнения «как напечатали» с дефисом. */
function compactUpperNoSpace(s: string): string {
  return collapseSpaces(s).toUpperCase().replace(/\s/g, "");
}

/** Разбор плоского ключа ER… + 4 цифры для FTS. */
function splitCompositeFlat(flat: string): { er: string; add: string } | null {
  if (flat.length < 6 || !flat.startsWith("ER")) return null;
  const add = flat.slice(-4);
  if (!/^\d{4}$/.test(add)) return null;
  const er = flat.slice(0, -4);
  if (er.length < 3 || !er.startsWith("ER")) return null;
  return { er, add };
}

function ftsQueryFromUserInput(raw: string): string | null {
  const flat = normalizeCompositeSearchInput(raw);
  if (flat.length < 8) return null;
  const sp = splitCompositeFlat(flat);
  if (sp) {
    return `"${sp.er}"* AND "${sp.add}"*`;
  }
  if (flat.startsWith("ER") && flat.length >= 4) {
    return `"${flat.slice(0, Math.min(20, flat.length))}"*`;
  }
  return null;
}

function searchCacheKey(query: string, limit: number): string {
  const nq = normalizeCompositeSearchInput(query.trim());
  return `${nq}\0${limit}`;
}

export function searchItems(
  db: Database.Database,
  query: string,
  limit = 50
): SearchHit[] {
  const gen = currentSearchCacheGeneration();
  const key = searchCacheKey(query, limit);
  const cached = searchCacheGet(gen, key);
  if (cached) return cached.items;
  const materialized = searchItemsUncached(db, query, limit);
  const lazy = searchLazySynthetic(db, query, limit);
  const items = mergeHits(materialized, lazy, limit);
  searchCacheSet(gen, key, items, items.length);
  return items;
}

function mergeHits(a: SearchHit[], b: SearchHit[], limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const h of [...a, ...b]) {
    const k = h.composite_art_normalized;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

export function searchItemsUncached(
  db: Database.Database,
  query: string,
  limit = 50
): SearchHit[] {
  const qraw = query.trim();
  if (!qraw) return [];

  const nq = normalizeCompositeSearchInput(qraw);
  const qCompactOrig = compactUpperNoSpace(qraw);
  const qprefix = nq ? `${nq}%` : "";
  const qlike = `%${escapeLike(collapseSpaces(qraw))}%`;
  const fts = ftsQueryFromUserInput(qraw);

  const ftsClause = fts
    ? ` OR sv.id IN (SELECT rowid FROM search_variants_fts WHERE search_variants_fts MATCH @fts)`
    : "";

  const ftsRankWhen = fts
    ? `WHEN sv.id IN (SELECT rowid FROM search_variants_fts WHERE search_variants_fts MATCH @fts) THEN 5`
    : "";

  const sql = `
    SELECT sv.*,
      CASE
        WHEN @nq != '' AND sv.composite_art_normalized = @nq THEN 1
        WHEN sv.composite_art_original IS NOT NULL AND
             REPLACE(UPPER(TRIM(sv.composite_art_original)), ' ', '') = @qcompact THEN 2
        WHEN @nq != '' AND sv.composite_art_normalized LIKE @qprefix THEN 3
        WHEN sv.display_name LIKE @qlike ESCAPE '\\'
          OR sv.base_name LIKE @qlike ESCAPE '\\'
          OR sv.add_name LIKE @qlike ESCAPE '\\'
          OR sv.composite_art_original LIKE @qlike ESCAPE '\\' THEN 4
        ${ftsRankWhen}
        ELSE 6
      END AS rank
    FROM search_variants sv
    WHERE (@nq != '' AND sv.composite_art_normalized = @nq)
       OR (REPLACE(UPPER(TRIM(sv.composite_art_original)), ' ', '') = @qcompact)
       OR (@nq != '' AND sv.composite_art_normalized LIKE @qprefix)
       OR sv.display_name LIKE @qlike ESCAPE '\\'
       OR sv.base_name LIKE @qlike ESCAPE '\\'
       OR sv.add_name LIKE @qlike ESCAPE '\\'
       OR sv.composite_art_original LIKE @qlike ESCAPE '\\'
       ${ftsClause}
    ORDER BY rank ASC, length(sv.composite_art_normalized) ASC, sv.id ASC
    LIMIT @limit
  `;

  const stmt = db.prepare(sql);
  const params: Record<string, string | number> = {
    nq,
    qcompact: qCompactOrig,
    qprefix: qprefix || "",
    qlike,
    limit,
  };
  if (fts) params.fts = fts;

  type SvRow = Omit<SearchHit, "composite_art" | "rank"> & {
    rank: number;
    composite_art_original: string;
  };
  const rows = stmt.all(params) as SvRow[];
  return rows.map((r) => ({
    id: r.id,
    rank: r.rank,
    result_mode: "materialized",
    composite_art: r.composite_art_original,
    composite_art_normalized: r.composite_art_normalized,
    base_art: r.base_art,
    add_art: r.add_art,
    display_name: r.display_name,
    base_name: r.base_name,
    add_name: r.add_name,
    source_filename: r.source_filename,
    source_sheet: r.source_sheet,
    source_row_base: r.source_row_base,
    source_row_add: r.source_row_add,
    import_job_id: r.import_job_id,
    created_at: r.created_at,
  }));
}

function buildLazyHit(
  b: {
    id: number;
    base_art: string;
    base_art_normalized: string;
    base_name: string;
    source_filename: string;
    source_sheet: string;
    source_row: number;
  },
  a: {
    id: number;
    add_art: string;
    add_art_normalized: string;
    add_name: string;
    source_filename: string;
    source_sheet: string;
    source_row: number;
  },
  source: { originalFilename: string; importedFileId: number; importJobId: string }
): SearchHit {
  return {
    id: -(b.id * 1_000_000 + a.id),
    rank: 5,
    result_mode: "lazy",
    composite_art: `${b.base_art}-${a.add_art}`,
    composite_art_normalized: `${b.base_art_normalized}${a.add_art_normalized}`,
    base_art: b.base_art,
    add_art: a.add_art,
    display_name: `${b.base_name}, ${a.add_name}`,
    base_name: b.base_name,
    add_name: a.add_name,
    source_filename: source.originalFilename,
    source_sheet: `lazy/imported_files/${source.importedFileId}`,
    source_row_base: b.source_row,
    source_row_add: a.source_row,
    import_job_id: source.importJobId || "lazy",
    created_at: "",
  };
}

function searchLazyExact(db: Database.Database, nq: string): SearchHit[] {
  const sp = splitCompositeFlat(nq);
  if (!sp) return [];
  const row = db
    .prepare(
      `SELECT
         b.id as b_id, b.base_art, b.base_art_normalized, b.base_name, b.source_filename as b_file, b.source_sheet as b_sheet, b.source_row as b_row,
         a.id as a_id, a.add_art, a.add_art_normalized, a.add_name, a.source_filename as a_file, a.source_sheet as a_sheet, a.source_row as a_row,
         f.id as imported_file_id, f.original_filename, f.import_job_id
       FROM imported_files f
       INNER JOIN import_file_bases fb ON fb.imported_file_id = f.id
       INNER JOIN base_articles b ON b.id = fb.base_article_id
       INNER JOIN import_file_adds fa ON fa.imported_file_id = f.id
       INNER JOIN add_articles a ON a.id = fa.add_article_id
       WHERE f.materialization_mode = 'lazy'
         AND b.base_art_normalized = ?
         AND a.add_art_normalized = ?
       ORDER BY f.id DESC
       LIMIT 1`
    )
    .get(sp.er, sp.add) as
    | {
        b_id: number;
        base_art: string;
        base_art_normalized: string;
        base_name: string;
        b_file: string;
        b_sheet: string;
        b_row: number;
        a_id: number;
        add_art: string;
        add_art_normalized: string;
        add_name: string;
        a_file: string;
        a_sheet: string;
        a_row: number;
        imported_file_id: number;
        original_filename: string;
        import_job_id: string;
      }
    | undefined;
  if (!row) return [];
  return [
    {
      ...buildLazyHit(
        {
          id: row.b_id,
          base_art: row.base_art,
          base_art_normalized: row.base_art_normalized,
          base_name: row.base_name,
          source_filename: row.b_file,
          source_sheet: row.b_sheet,
          source_row: row.b_row,
        },
        {
          id: row.a_id,
          add_art: row.add_art,
          add_art_normalized: row.add_art_normalized,
          add_name: row.add_name,
          source_filename: row.a_file,
          source_sheet: row.a_sheet,
          source_row: row.a_row,
        },
        {
          originalFilename: row.original_filename,
          importedFileId: row.imported_file_id,
          importJobId: row.import_job_id,
        }
      ),
      rank: 1,
    },
  ];
}

function splitLazyPrefixes(nq: string): { erPrefix: string; addPrefix: string } {
  if (!nq) return { erPrefix: "", addPrefix: "" };
  if (!nq.startsWith("ER")) return { erPrefix: nq, addPrefix: "" };
  const m = nq.match(/^(ER[A-Z0-9]*?)(\d{1,4})?$/);
  if (!m) return { erPrefix: nq, addPrefix: "" };
  return { erPrefix: m[1] || nq, addPrefix: m[2] || "" };
}

function searchLazyPrefix(
  db: Database.Database,
  nq: string,
  limit: number
): SearchHit[] {
  if (!nq || nq.length < 3) return [];
  const { erPrefix, addPrefix } = splitLazyPrefixes(nq);
  const rows = db
    .prepare(
      `SELECT b.id as b_id, b.base_art, b.base_art_normalized, b.base_name, b.source_filename as b_file, b.source_sheet as b_sheet, b.source_row as b_row,
              a.id as a_id, a.add_art, a.add_art_normalized, a.add_name, a.source_filename as a_file, a.source_sheet as a_sheet, a.source_row as a_row,
              f.id as imported_file_id, f.original_filename, f.import_job_id
       FROM imported_files f
       INNER JOIN import_file_bases fb ON fb.imported_file_id = f.id
       INNER JOIN base_articles b ON b.id = fb.base_article_id
       INNER JOIN import_file_adds fa ON fa.imported_file_id = f.id
       INNER JOIN add_articles a ON a.id = fa.add_article_id
       WHERE f.materialization_mode = 'lazy'
         AND b.base_art_normalized LIKE @bp
         AND a.add_art_normalized LIKE @ap
       ORDER BY f.id DESC
       LIMIT @candidate`
    )
    .all({
      bp: `${erPrefix}%`,
      ap: `${addPrefix}%`,
      candidate: Math.max(limit * LAZY_SEARCH_SCOPE_LIMIT, LAZY_SEARCH_CANDIDATE_LIMIT),
    }) as {
    b_id: number;
    base_art: string;
    base_art_normalized: string;
    base_name: string;
    b_file: string;
    b_sheet: string;
    b_row: number;
    a_id: number;
    add_art: string;
    add_art_normalized: string;
    add_name: string;
    a_file: string;
    a_sheet: string;
    a_row: number;
    imported_file_id: number;
    original_filename: string;
    import_job_id: string;
  }[];
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const compositeNorm = `${r.base_art_normalized}${r.add_art_normalized}`;
    if (!compositeNorm.startsWith(nq)) continue;
    if (seen.has(compositeNorm)) continue;
    seen.add(compositeNorm);
    out.push(
      buildLazyHit(
        {
          id: r.b_id,
          base_art: r.base_art,
          base_art_normalized: r.base_art_normalized,
          base_name: r.base_name,
          source_filename: r.b_file,
          source_sheet: r.b_sheet,
          source_row: r.b_row,
        },
        {
          id: r.a_id,
          add_art: r.add_art,
          add_art_normalized: r.add_art_normalized,
          add_name: r.add_name,
          source_filename: r.a_file,
          source_sheet: r.a_sheet,
          source_row: r.a_row,
        },
        {
          originalFilename: r.original_filename,
          importedFileId: r.imported_file_id,
          importJobId: r.import_job_id,
        }
      )
    );
    if (out.length >= limit) break;
  }
  return out;
}

function searchLazySynthetic(
  db: Database.Database,
  query: string,
  limit: number
): SearchHit[] {
  const nq = normalizeCompositeSearchInput(query.trim());
  if (!nq) return [];
  const exact = searchLazyExact(db, nq);
  if (exact.length > 0) return exact.slice(0, limit);
  return searchLazyPrefix(db, nq, limit);
}

export function getItemById(db: Database.Database, id: number): SearchHit | undefined {
  const row = db.prepare(`SELECT * FROM search_variants WHERE id = ?`).get(id) as
    | {
        id: number;
        composite_art_original: string;
        composite_art_normalized: string;
        base_art: string;
        add_art: string;
        display_name: string;
        base_name: string;
        add_name: string;
        source_filename: string;
        source_sheet: string;
        source_row_base: number;
        source_row_add: number;
        import_job_id: string;
        created_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    rank: 0,
    result_mode: "materialized",
    composite_art: row.composite_art_original,
    composite_art_normalized: row.composite_art_normalized,
    base_art: row.base_art,
    add_art: row.add_art,
    display_name: row.display_name,
    base_name: row.base_name,
    add_name: row.add_name,
    source_filename: row.source_filename,
    source_sheet: row.source_sheet,
    source_row_base: row.source_row_base,
    source_row_add: row.source_row_add,
    import_job_id: row.import_job_id,
    created_at: row.created_at,
  };
}
