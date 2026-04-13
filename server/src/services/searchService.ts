import type Database from "better-sqlite3";
import { collapseSpaces, normalizeCompositeSearchInput } from "../normalize.js";

export type SearchHit = {
  id: number;
  rank: number;
  composite_art: string;
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
};

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

export function searchItems(
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
