import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type Database from "better-sqlite3";
import { UPLOAD_MAX_MB } from "../config.js";
import { createImportJobQueue } from "../services/importQueue.js";
import { defaultFileProgress } from "../services/importProgress.js";
import { getItemById, searchItems } from "../services/searchService.js";

type ApiOpts = { repoRoot: string };

function decodeOriginalFilename(name: string): string {
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    if (decoded.includes("\uFFFD")) return name;
    return decoded;
  } catch {
    return name;
  }
}

function ensureImportUploadRoot(repoRoot: string): string {
  const root = path.join(repoRoot, "data", "uploads");
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

function assignImportJob(uploadRoot: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const jobId = randomUUID();
    const jobDir = path.join(uploadRoot, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    req.importJobId = jobId;
    req.importJobDir = jobDir;
    next();
  };
}

export function apiRouter(db: Database.Database, opts: ApiOpts): Router {
  const r = Router();
  const uploadRoot = ensureImportUploadRoot(opts.repoRoot);
  const importQueue = createImportJobQueue(db);

  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = req.importJobDir;
      if (!dir) {
        cb(new Error("importJobDir missing"), "");
        return;
      }
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const decoded = decodeOriginalFilename(file.originalname);
      const safe = decoded.replace(/[^\w.\-() ]+/g, "_") || "file.xlsx";
      cb(null, `${randomUUID()}_${safe}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: UPLOAD_MAX_MB * 1024 * 1024,
      files: 80,
    },
    fileFilter: (_req, file, cb) => {
      const ok =
        file.mimetype ===
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        file.originalname.toLowerCase().endsWith(".xlsx");
      cb(null, ok);
    },
  });

  const insertPendingJob = db.prepare(
    `INSERT INTO import_jobs (id, started_at, status, summary_json, progress_json, diagnostics_json)
     VALUES (?, ?, 'pending', '{}', ?, '{}')`
  );

  r.get("/health", (_req, res) => {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM search_variants`).get() as {
      c: number;
    };
    res.json({
      ok: true,
      search_variants: row.c,
      import_queue: {
        waiting: importQueue.waiting,
        active: importQueue.active,
      },
    });
  });

  r.post(
    "/import",
    assignImportJob(uploadRoot),
    upload.array("files"),
    (req, res) => {
      const jobId = req.importJobId;
      const jobDir = req.importJobDir;
      const files = req.files as Express.Multer.File[] | undefined;
      if (!jobId || !jobDir) {
        res.status(500).json({ error: "Внутренняя ошибка: job не создан" });
        return;
      }
      if (!files?.length) {
        try {
          fs.rmSync(jobDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        res.status(400).json({ error: "Нет файлов (поле files)" });
        return;
      }

      const force =
        req.query.force === "1" ||
        req.query.force === "true" ||
        String(req.body?.force || "") === "1";
      const normalizedFiles = files.map((f) => ({
        ...f,
        originalname: decodeOriginalFilename(f.originalname),
      }));

      const startedAt = new Date().toISOString();
      const progress = {
        phase: "queued" as const,
        jobPercent: 0,
        fileCount: normalizedFiles.length,
        files: normalizedFiles.map((f) => defaultFileProgress(f.originalname)),
      };
      insertPendingJob.run(jobId, startedAt, JSON.stringify(progress));

      const queuedFiles = normalizedFiles.map((f) => ({
        diskPath: path.join(jobDir, f.filename),
        originalname: f.originalname,
      }));

      const enqueuedAt = Date.now();
      void importQueue.enqueue(jobId, queuedFiles, { force, enqueuedAt });

      res.status(202).json({
        jobId,
        status: "queued",
        message: "Импорт поставлен в очередь",
        pollUrl: `/api/jobs/${jobId}`,
      });
    }
  );

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
        result_mode: row.result_mode ?? "materialized",
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

  r.get("/jobs", (req, res) => {
    const limit = Math.min(
      50,
      Math.max(1, parseInt(String(req.query.limit ?? "15"), 10) || 15)
    );
    const rows = db
      .prepare(
        `SELECT id, started_at, finished_at, status, summary_json, progress_json, diagnostics_json
         FROM import_jobs ORDER BY datetime(started_at) DESC LIMIT ?`
      )
      .all(limit) as {
      id: string;
      started_at: string;
      finished_at: string | null;
      status: string;
      summary_json: string;
      progress_json: string;
      diagnostics_json: string;
    }[];
    res.json({
      jobs: rows.map((j) => ({
        ...j,
        summary: JSON.parse(j.summary_json || "{}"),
        progress: JSON.parse(j.progress_json || "{}"),
        diagnostics: JSON.parse(j.diagnostics_json || "{}"),
      })),
    });
  });

  r.get("/jobs/latest", (_req, res) => {
    const job = db
      .prepare(
        `SELECT id, started_at, finished_at, status, summary_json, progress_json, diagnostics_json FROM import_jobs
         ORDER BY datetime(started_at) DESC LIMIT 1`
      )
      .get() as
      | {
          id: string;
          started_at: string;
          finished_at: string | null;
          status: string;
          summary_json: string;
          progress_json: string;
          diagnostics_json: string;
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
        progress: JSON.parse(job.progress_json || "{}"),
        diagnostics: JSON.parse(job.diagnostics_json || "{}"),
        errors,
      },
    });
  });

  r.get("/jobs/:id", (req, res) => {
    const job = db
      .prepare(
        `SELECT id, started_at, finished_at, status, summary_json, progress_json, diagnostics_json FROM import_jobs WHERE id = ?`
      )
      .get(req.params.id) as
      | {
          id: string;
          started_at: string;
          finished_at: string | null;
          status: string;
          summary_json: string;
          progress_json: string;
          diagnostics_json: string;
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
      progress: JSON.parse(job.progress_json || "{}"),
      diagnostics: JSON.parse(job.diagnostics_json || "{}"),
      errors,
    });
  });

  return r;
}
