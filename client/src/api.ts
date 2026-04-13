const base = "";

export type SearchItem = {
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

export type ImportResult = {
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
  files: {
    filename: string;
    sheets: {
      sheet: string;
      rowsRead: number;
      baseRows: number;
      addRows: number;
      rowsSkipped: number;
      issueCount: number;
    }[];
  }[];
};

export async function importFiles(files: File[]): Promise<ImportResult> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const res = await fetch(`${base}/api/import`, { method: "POST", body: fd });
  const data = (await res.json()) as ImportResult & { error?: string };
  if (!res.ok) throw new Error(data.message || data.error || res.statusText);
  return data;
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
