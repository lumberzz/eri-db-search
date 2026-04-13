import { Router } from "express";
import multer from "multer";
import type Database from "better-sqlite3";
import { runImport } from "../services/importService.js";
import { getItemById, searchItems } from "../services/searchService.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 20 },
});

export function apiRouter(db: Database.Database): Router {
  const r = Router();

  r.get("/health", (_req, res) => {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM search_variants`).get() as { c: number };
    res.json({ ok: true, search_variants: row.c });
  });

  r.post("/import", upload.array("files"), async (req, res) => {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files?.length) {
      res.status(400).json({ error: "Нет файлов (поле files)" });
      return;
    }
    const buffers = files.map((f) => ({
      buffer: f.buffer,
      originalname: f.originalname,
    }));
    try {
      const result = await runImport(db, buffers);
      const status = result.status === "failed" ? 500 : 200;
      res.status(status).json(result);
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  r.get("/search", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limit = Math.min(
      200,
      Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50)
    );
    try {
      const items = searchItems(db, q, limit).map((row) => ({
        id: row.id,
        rank: row.rank,
        composite_art: row.composite_art,
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
      }));
      res.json({ query: q, count: items.length, items });
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  r.get("/items/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Некорректный id" });
      return;
    }
    const row = getItemById(db, id);
    if (!row) {
      res.status(404).json({ error: "Запись не найдена" });
      return;
    }
    res.json({
      id: row.id,
      composite_art: row.composite_art,
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
    });
  });

  r.get("/jobs/latest", (_req, res) => {
    const job = db
      .prepare(
        `SELECT id, started_at, finished_at, status, summary_json FROM import_jobs
         ORDER BY datetime(started_at) DESC LIMIT 1`
      )
      .get() as
      | {
          id: string;
          started_at: string;
          finished_at: string | null;
          status: string;
          summary_json: string;
        }
      | undefined;
    if (!job) {
      res.json({ job: null });
      return;
    }
    const errors = db
      .prepare(
        `SELECT filename, sheet, row_num, message FROM import_row_errors
         WHERE import_job_id = ? ORDER BY id ASC LIMIT 500`
      )
      .all(job.id);
    res.json({
      job: {
        ...job,
        summary: JSON.parse(job.summary_json || "{}"),
        errors,
      },
    });
  });

  r.get("/jobs/:id", (req, res) => {
    const job = db
      .prepare(
        `SELECT id, started_at, finished_at, status, summary_json FROM import_jobs WHERE id = ?`
      )
      .get(req.params.id) as
      | {
          id: string;
          started_at: string;
          finished_at: string | null;
          status: string;
          summary_json: string;
        }
      | undefined;
    if (!job) {
      res.status(404).json({ error: "Job не найден" });
      return;
    }
    const errors = db
      .prepare(
        `SELECT filename, sheet, row_num, message FROM import_row_errors
         WHERE import_job_id = ? ORDER BY id ASC LIMIT 500`
      )
      .all(job.id);
    res.json({
      ...job,
      summary: JSON.parse(job.summary_json || "{}"),
      errors,
    });
  });

  return r;
}
