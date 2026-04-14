const base = "";

export type SearchItem = {
  id: number;
  rank: number;
  result_mode?: "materialized" | "lazy";
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

export type ImportFileSheetSummary = {
  sheet: string;
  rowsRead: number;
  baseRows: number;
  addRows: number;
  rowsSkipped: number;
  issueCount: number;
};

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

export type ImportFileProgressRow = {
  name: string;
  status: ImportFileProgressStatus;
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

export type JobProgressPayload = {
  phase?: string;
  jobPercent?: number;
  fileCount?: number;
  files?: ImportFileProgressRow[];
  queueWaitMs?: number;
  currentFileIndex?: number;
};

export type ImportResult = {
  jobId: string;
  status: "completed" | "failed" | "pending" | "processing" | "queued";
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
    cacheHits?: number;
  };
  files: {
    filename: string;
    fingerprint?: string;
    cacheHit?: boolean;
    duplicateFile?: boolean;
    materializationMode?: "full" | "lazy" | "rejected";
    uniqueBases?: number;
    uniqueAdds?: number;
    estimatedPairs?: number;
    warnings?: string[];
    sheets: ImportFileSheetSummary[];
  }[];
  diagnostics?: Record<string, number | string>;
  progress?: JobProgressPayload;
};

export type JobPollState = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  summary: ImportResult | Record<string, unknown>;
  progress: JobProgressPayload;
  diagnostics: Record<string, unknown>;
  errors: { filename: string; sheet: string; row_num: number; message: string }[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getJob(jobId: string): Promise<JobPollState> {
  const res = await fetch(`${base}/api/jobs/${jobId}`);
  const data = (await res.json()) as JobPollState & { error?: string };
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function postImportWithUploadProgress(
  files: File[],
  force: boolean,
  onUploadProgress?: (loaded: number, total: number) => void
): Promise<{ jobId: string }> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const q = force ? "?force=1" : "";
  const url = `${base}/api/import${q}`;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onUploadProgress?.(ev.loaded, ev.total);
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText || "{}") as {
          jobId?: string;
          error?: string;
          message?: string;
        };
        if (xhr.status === 202 && body.jobId) {
          resolve({ jobId: body.jobId });
          return;
        }
        reject(new Error(body.message || body.error || xhr.statusText || "Импорт"));
      } catch {
        reject(new Error(xhr.statusText || "Некорректный ответ сервера"));
      }
    };
    xhr.onerror = () => reject(new Error("Сеть: не удалось отправить файлы"));
    xhr.send(fd);
  });
}

export async function importFiles(
  files: File[],
  opts?: {
    force?: boolean;
    onUploadProgress?: (loaded: number, total: number) => void;
    onProgress?: (p: {
      status: string;
      progress: JobProgressPayload;
    }) => void;
  }
): Promise<ImportResult & { jobId: string; progress?: JobProgressPayload }> {
  const head = await postImportWithUploadProgress(
    files,
    !!opts?.force,
    opts?.onUploadProgress
  );

  let delay = 300;
  const maxDelay = 1800;
  for (;;) {
    const st = await getJob(head.jobId);
    opts?.onProgress?.({ status: st.status, progress: st.progress });
    if (st.status === "completed" || st.status === "failed") {
      const summary = st.summary as ImportResult;
      return {
        ...summary,
        jobId: head.jobId,
        progress: st.progress,
        diagnostics: st.diagnostics as ImportResult["diagnostics"],
      };
    }
    await sleep(delay);
    delay = Math.min(maxDelay, Math.round(delay * 1.2));
  }
}

export async function listRecentJobs(limit = 10): Promise<JobPollState[]> {
  const res = await fetch(`${base}/api/jobs?limit=${limit}`);
  const data = (await res.json()) as { jobs?: JobPollState[] };
  return (data.jobs ?? []).map((j) => ({
    ...j,
    errors: j.errors ?? [],
  }));
}

export async function search(q: string, limit = 80): Promise<{
  items: SearchItem[];
  count: number;
}> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const res = await fetch(`${base}/api/search?${params}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getItem(id: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/items/${id}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
