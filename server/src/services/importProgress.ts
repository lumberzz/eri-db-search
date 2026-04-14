import type Database from "better-sqlite3";

export type ImportFileProgressStatus =
  | "pending"
  | "uploading"
  | "hashing"
  | "parsing"
  | "processing"
  | "generating_variants"
  | "saving"
  | "completed"
  | "failed"
  | "already_imported";

export type FileProgressRow = {
  name: string;
  status: ImportFileProgressStatus;
  /** 0–100; во время парсинга без известного знаменателя может «держаться» на плато, см. `rowsProcessed`. */
  percent: number;
  rowsProcessed: number;
  basesFound: number;
  addsFound: number;
  variantsInserted: number;
  variantsSkipped: number;
  variantPairsProcessed?: number;
  variantPairsTotal?: number;
  rowsTotal?: number;
  message?: string;
  error?: string;
};

export type JobProgressDoc = {
  phase: string;
  jobPercent: number;
  fileCount: number;
  files: FileProgressRow[];
  queueWaitMs?: number;
  currentFileIndex?: number;
  processingStartedAt?: string;
};

export function defaultFileProgress(name: string): FileProgressRow {
  return {
    name,
    status: "pending",
    percent: 0,
    rowsProcessed: 0,
    basesFound: 0,
    addsFound: 0,
    variantsInserted: 0,
    variantsSkipped: 0,
  };
}

function load(db: Database.Database, jobId: string): JobProgressDoc {
  const row = db
    .prepare(`SELECT progress_json FROM import_jobs WHERE id = ?`)
    .get(jobId) as { progress_json: string } | undefined;
  const raw = JSON.parse(row?.progress_json || "{}");
  return {
    phase: typeof raw.phase === "string" ? raw.phase : "queued",
    jobPercent: typeof raw.jobPercent === "number" ? raw.jobPercent : 0,
    fileCount: typeof raw.fileCount === "number" ? raw.fileCount : 0,
    files: Array.isArray(raw.files) ? raw.files : [],
    queueWaitMs: typeof raw.queueWaitMs === "number" ? raw.queueWaitMs : undefined,
    currentFileIndex:
      typeof raw.currentFileIndex === "number" ? raw.currentFileIndex : undefined,
    processingStartedAt:
      typeof raw.processingStartedAt === "string"
        ? raw.processingStartedAt
        : undefined,
  };
}

function save(db: Database.Database, jobId: string, doc: JobProgressDoc): void {
  doc.jobPercent = recomputeJobPercent(doc.files);
  db.prepare(`UPDATE import_jobs SET progress_json = ? WHERE id = ?`).run(
    JSON.stringify(doc),
    jobId
  );
}

export function recomputeJobPercent(files: FileProgressRow[]): number {
  if (!files.length) return 0;
  const sum = files.reduce((a, f) => a + Math.min(100, Math.max(0, f.percent)), 0);
  return Math.round(sum / files.length);
}

export function patchJobProgress(
  db: Database.Database,
  jobId: string,
  mutator: (doc: JobProgressDoc) => void
): void {
  const doc = load(db, jobId);
  mutator(doc);
  save(db, jobId, doc);
}

export function patchJobFile(
  db: Database.Database,
  jobId: string,
  fileIndex: number,
  patch: Partial<FileProgressRow>
): void {
  patchJobProgress(db, jobId, (doc) => {
    while (doc.files.length <= fileIndex) {
      doc.files.push(defaultFileProgress(`file-${doc.files.length}`));
    }
    const cur = doc.files[fileIndex]!;
    doc.files[fileIndex] = { ...cur, ...patch, name: cur.name };
    doc.currentFileIndex = fileIndex;
  });
}

export function mergeTopLevelProgress(
  db: Database.Database,
  jobId: string,
  patch: Record<string, unknown>
): void {
  patchJobProgress(db, jobId, (doc) => {
    Object.assign(doc, patch);
  });
}
