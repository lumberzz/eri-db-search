import type Database from "better-sqlite3";
import { collapseSpaces, normalizeCompositeSearchInput } from "../normalize.js";
import { mergeDisplayName } from "../domain/erArticles.js";
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
import {
  normalizeSearchText,
  parseSearchQuery,
  splitCompositeFromQuery,
  type ParsedSearchQuery,
} from "./searchQueryParse.js";

export type { SearchHit };

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function compactUpperNoSpace(s: string): string {
  return collapseSpaces(s).toUpperCase().replace(/\s/g, "");
}

function ftsQueryFromUserInput(raw: string, flat: string): string | null {
  if (flat.length < 8) return null;
  const sp = splitCompositeFromQuery(raw, flat);
  if (sp) {
    return `"${sp.er}"* AND "${sp.add}"*`;
  }
  if (flat.startsWith("ER") && flat.length >= 4) {
    return `"${flat.slice(0, Math.min(20, flat.length))}"*`;
  }
  return null;
}

function searchCacheKey(query: string, limit: number): string {
  return `${normalizeSearchText(query)}\0${limit}`;
}

function mapSvRow(r: {
  id: number;
  rank: number;
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
}): SearchHit {
  return {
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
  };
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

  const parsed = parseSearchQuery(query);
  const parts: SearchHit[][] = [];

  if (parsed.nameTokens.length > 0 && parsed.addCode) {
    parts.push(searchMaterializedByNameAdd(db, parsed, limit));
    parts.push(searchLazyByNameAdd(db, parsed, limit));
  } else if (parsed.addCode && (parsed.basePrefix || !parsed.articleFlat)) {
    parts.push(searchMaterializedByAddCode(db, parsed, limit));
    parts.push(searchLazyByAddCode(db, parsed, limit));
  } else if (parsed.addCode && /^\d{4}$/.test(parsed.articleFlat)) {
    parts.push(searchMaterializedByAddCode(db, parsed, limit));
    parts.push(searchLazyByAddCode(db, parsed, limit));
  } else if (parsed.articleFlat) {
    parts.push(searchItemsUncached(db, query, parsed, limit));
    parts.push(searchLazySynthetic(db, query, parsed, limit));
  } else if (!parsed.namePart) {
    parts.push(searchItemsUncached(db, query, parsed, limit));
  }

  const items = mergeHits(parts.flat(), limit);
  searchCacheSet(gen, key, items, items.length);
  return items;
}

function mergeHits(hits: SearchHit[], limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const sorted = [...hits].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const al = a.composite_art_normalized.length;
    const bl = b.composite_art_normalized.length;
    if (al !== bl) return al - bl;
    return a.id - b.id;
  });
  for (const h of sorted) {
    const k = h.composite_art_normalized;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

function searchMaterializedByNameAdd(
  db: Database.Database,
  parsed: ParsedSearchQuery,
  limit: number
): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT sv.*, 3 AS rank
       FROM search_variants sv
       WHERE sv.add_art = @addCode
       ORDER BY sv.id ASC`
    )
    .all({ addCode: parsed.addCode }) as (Omit<
    SearchHit,
    "composite_art" | "rank" | "result_mode"
  > & {
    rank: number;
    composite_art_original: string;
  })[];

  const normalizedPhrase = normalizeSearchText(parsed.namePart!);
  return rows
    .map((row) => {
      const normalizedName = normalizeSearchText(row.base_name);
      const allTokensMatch = parsed.nameTokens.every((token) =>
        normalizedName.includes(token)
      );
      if (!allTokensMatch) return null;
      const rank =
        normalizedName === normalizedPhrase
          ? 1
          : normalizedName.startsWith(normalizedPhrase)
            ? 2
            : 3;
      return mapSvRow({ ...row, rank });
    })
    .filter((row): row is SearchHit => row !== null)
    .sort((a, b) => a.rank - b.rank || a.base_name.length - b.base_name.length)
    .slice(0, limit);
}

function searchMaterializedByAddCode(
  db: Database.Database,
  parsed: ParsedSearchQuery,
  limit: number
): SearchHit[] {
  const basePrefix = parsed.basePrefix ? `${parsed.basePrefix}%` : "%";
  const rows = db
    .prepare(
      `SELECT sv.*, 1 AS rank
       FROM search_variants sv
       WHERE sv.add_art = @addCode
         AND sv.composite_art_normalized LIKE @basePrefix
       ORDER BY length(sv.base_art) ASC, sv.base_art ASC, sv.id ASC
       LIMIT @limit`
    )
    .all({
      addCode: parsed.addCode,
      basePrefix,
      limit,
    }) as (Omit<SearchHit, "composite_art" | "rank" | "result_mode"> & {
    rank: number;
    composite_art_original: string;
  })[];
  return rows.map((row) => mapSvRow(row));
}

export function searchItemsUncached(
  db: Database.Database,
  query: string,
  parsed: ParsedSearchQuery,
  limit = 50
): SearchHit[] {
  const qraw = parsed.raw;
  if (!qraw) return [];

  const nq = parsed.articleFlat;
  const qCompactOrig = compactUpperNoSpace(qraw);
  const qprefix = nq ? `${nq}%` : "";
  const qlike = `%${escapeLike(collapseSpaces(qraw))}%`;
  const fts = ftsQueryFromUserInput(qraw, nq);

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

  const params: Record<string, string | number> = {
    nq,
    qcompact: qCompactOrig,
    qprefix: qprefix || "",
    qlike,
    limit,
  };
  if (fts) params.fts = fts;

  const rows = db.prepare(sql).all(params) as (Omit<SearchHit, "composite_art" | "rank" | "result_mode"> & {
    rank: number;
    composite_art_original: string;
  })[];
  return rows.map((r) => mapSvRow(r));
}

type LazyPairRow = {
  b_id: number;
  base_art: string;
  base_art_normalized: string;
  base_name: string;
  base_sheet: string;
  base_row: number;
  a_id: number;
  add_art: string;
  add_art_normalized: string;
  add_name: string;
  add_sheet: string;
  add_row: number;
  imported_file_id: number;
  original_filename: string;
  import_job_id: string;
};

function buildLazyHit(row: LazyPairRow, rank = 5): SearchHit {
  return {
    id: -(row.b_id * 1_000_000 + row.a_id),
    rank,
    result_mode: "lazy",
    composite_art: `${row.base_art}-${row.add_art}`,
    composite_art_normalized: `${row.base_art_normalized}${row.add_art_normalized}`,
    base_art: row.base_art,
    add_art: row.add_art,
    display_name: mergeDisplayName(row.base_name, row.add_name),
    base_name: row.base_name,
    add_name: row.add_name,
    source_filename: row.original_filename,
    source_sheet:
      row.base_sheet === row.add_sheet
        ? row.base_sheet
        : `${row.base_sheet} + ${row.add_sheet}`,
    source_row_base: row.base_row,
    source_row_add: row.add_row,
    import_job_id: row.import_job_id || "lazy",
    created_at: "",
  };
}

function searchLazyByNameAdd(
  db: Database.Database,
  parsed: ParsedSearchQuery,
  limit: number
): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT b.id as b_id, b.base_art, b.base_art_normalized,
              fb.file_base_name as base_name,
              fb.source_sheet as base_sheet, fb.source_row as base_row,
              a.id as a_id, a.add_art, a.add_art_normalized,
              fa.file_add_name as add_name,
              fa.source_sheet as add_sheet, fa.source_row as add_row,
              f.id as imported_file_id, f.original_filename, f.import_job_id
       FROM imported_files f
       INNER JOIN import_file_bases fb ON fb.imported_file_id = f.id
       INNER JOIN base_articles b ON b.id = fb.base_article_id
       INNER JOIN import_file_adds fa ON fa.imported_file_id = f.id
       INNER JOIN add_articles a ON a.id = fa.add_article_id
       WHERE f.materialization_mode = 'lazy'
         AND a.add_art = @addCode
       ORDER BY f.id DESC`
    )
    .all({ addCode: parsed.addCode }) as LazyPairRow[];

  const phrase = normalizeSearchText(parsed.namePart!);
  return rows
    .map((row) => {
      const normalizedName = normalizeSearchText(row.base_name);
      if (!parsed.nameTokens.every((token) => normalizedName.includes(token))) {
        return null;
      }
      const rank =
        normalizedName === phrase
          ? 1
          : normalizedName.startsWith(phrase)
            ? 2
            : 3;
      return buildLazyHit(row, rank);
    })
    .filter((row): row is SearchHit => row !== null)
    .sort((a, b) => a.rank - b.rank || a.base_name.length - b.base_name.length)
    .slice(0, limit);
}

function searchLazyByAddCode(
  db: Database.Database,
  parsed: ParsedSearchQuery,
  limit: number
): SearchHit[] {
  const basePrefix = parsed.basePrefix ? `${parsed.basePrefix}%` : "%";
  const rows = db
    .prepare(
      `SELECT b.id as b_id, b.base_art, b.base_art_normalized,
              fb.file_base_name as base_name,
              fb.source_sheet as base_sheet, fb.source_row as base_row,
              a.id as a_id, a.add_art, a.add_art_normalized,
              fa.file_add_name as add_name,
              fa.source_sheet as add_sheet, fa.source_row as add_row,
              f.id as imported_file_id, f.original_filename, f.import_job_id
       FROM imported_files f
       INNER JOIN import_file_bases fb ON fb.imported_file_id = f.id
       INNER JOIN base_articles b ON b.id = fb.base_article_id
       INNER JOIN import_file_adds fa ON fa.imported_file_id = f.id
       INNER JOIN add_articles a ON a.id = fa.add_article_id
       WHERE f.materialization_mode = 'lazy'
         AND a.add_art = @addCode
         AND b.base_art_normalized LIKE @basePrefix
       ORDER BY b.base_art_normalized ASC, f.id DESC
       LIMIT @limit`
    )
    .all({
      addCode: parsed.addCode,
      basePrefix,
      limit,
    }) as LazyPairRow[];
  return rows.map((row) => buildLazyHit(row, 1));
}

function searchLazyExact(
  db: Database.Database,
  raw: string,
  flat: string
): SearchHit[] {
  let er: string | null = null;
  let add: string | null = null;
  const sp = splitCompositeFromQuery(raw, flat);
  if (sp) {
    er = sp.er;
    add = sp.add;
  } else if (flat) {
    const validated = db
      .prepare(
        `SELECT b.base_art_normalized as er_norm,
                a.add_art_normalized as add_norm
         FROM imported_files f
         INNER JOIN import_file_bases fb ON fb.imported_file_id = f.id
         INNER JOIN base_articles b ON b.id = fb.base_article_id
         INNER JOIN import_file_adds fa ON fa.imported_file_id = f.id
         INNER JOIN add_articles a ON a.id = fa.add_article_id
         WHERE f.materialization_mode = 'lazy'
           AND (b.base_art_normalized || a.add_art_normalized) = ?
         LIMIT 1`
      )
      .get(flat) as { er_norm: string; add_norm: string } | undefined;
    if (validated) {
      er = validated.er_norm;
      add = validated.add_norm;
    }
  }
  if (!er || !add) return [];

  const row = db
    .prepare(
      `SELECT b.id as b_id, b.base_art, b.base_art_normalized,
              fb.file_base_name as base_name,
              fb.source_sheet as base_sheet, fb.source_row as base_row,
              a.id as a_id, a.add_art, a.add_art_normalized,
              fa.file_add_name as add_name,
              fa.source_sheet as add_sheet, fa.source_row as add_row,
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
    .get(er, add) as LazyPairRow | undefined;
  if (!row) return [];
  return [{ ...buildLazyHit(row, 1), rank: 1 }];
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
      `SELECT b.id as b_id, b.base_art, b.base_art_normalized,
              fb.file_base_name as base_name,
              fb.source_sheet as base_sheet, fb.source_row as base_row,
              a.id as a_id, a.add_art, a.add_art_normalized,
              fa.file_add_name as add_name,
              fa.source_sheet as add_sheet, fa.source_row as add_row,
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
    }) as LazyPairRow[];

  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const compositeNorm = `${r.base_art_normalized}${r.add_art_normalized}`;
    if (!compositeNorm.startsWith(nq)) continue;
    if (seen.has(compositeNorm)) continue;
    seen.add(compositeNorm);
    out.push(buildLazyHit(r));
    if (out.length >= limit) break;
  }
  return out;
}

function searchLazySynthetic(
  db: Database.Database,
  query: string,
  parsed: ParsedSearchQuery,
  limit: number
): SearchHit[] {
  const nq = parsed.articleFlat;
  if (!nq) return [];
  const exact = searchLazyExact(db, query, nq);
  if (exact.length > 0) return exact.slice(0, limit);
  return searchLazyPrefix(db, nq, limit);
}

export function getItemById(db: Database.Database, id: number): SearchHit | undefined {
  if (id < 0) {
    const bId = Math.floor(-id / 1_000_000);
    const aId = -id % 1_000_000;
    const row = db
      .prepare(
        `SELECT b.id as b_id, b.base_art, b.base_art_normalized,
                fb.file_base_name as base_name,
                fb.source_sheet as base_sheet, fb.source_row as base_row,
                a.id as a_id, a.add_art, a.add_art_normalized,
                fa.file_add_name as add_name,
                fa.source_sheet as add_sheet, fa.source_row as add_row,
                f.id as imported_file_id, f.original_filename, f.import_job_id
         FROM imported_files f
         INNER JOIN import_file_bases fb ON fb.imported_file_id = f.id
         INNER JOIN base_articles b ON b.id = fb.base_article_id
         INNER JOIN import_file_adds fa ON fa.imported_file_id = f.id
         INNER JOIN add_articles a ON a.id = fa.add_article_id
         WHERE b.id = ? AND a.id = ?
         ORDER BY f.id DESC
         LIMIT 1`
      )
      .get(bId, aId) as LazyPairRow | undefined;
    if (!row) return undefined;
    return buildLazyHit(row, 0);
  }

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
  return mapSvRow({ ...row, rank: 0 });
}
