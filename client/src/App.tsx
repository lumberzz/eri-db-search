import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getItem,
  importFiles,
  listRecentJobs,
  search,
  type ImportFileProgressRow,
  type ImportResult,
  type JobProgressPayload,
  type JobPollState,
  type SearchItem,
} from "./api";

type LoadState = "idle" | "loading" | "error";

const STATUS_RU: Record<string, string> = {
  pending: "В очереди",
  uploading: "Загрузка на сервер",
  hashing: "Хеширование",
  parsing: "Разбор Excel",
  processing: "Обработка",
  generating_variants: "Генерация составных артикулов",
  saving: "Сохранение",
  completed: "Готово",
  failed: "Ошибка",
  already_imported: "Уже импортирован",
};

function statusLabel(s: string): string {
  return STATUS_RU[s] || s;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const [importState, setImportState] = useState<LoadState>("idle");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<ImportResult | null>(null);
  const [uploadBytes, setUploadBytes] = useState<{ loaded: number; total: number } | null>(
    null
  );
  const [liveProgress, setLiveProgress] = useState<JobProgressPayload | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobPollState[]>([]);

  const [q, setQ] = useState("");
  const [searchState, setSearchState] = useState<LoadState>("idle");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [selected, setSelected] = useState<SearchItem | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("idle");

  const refreshRecent = useCallback(() => {
    listRecentJobs(8).then(setRecentJobs).catch(() => {});
  }, []);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  const onFiles = useCallback(
    async (list: FileList | null) => {
      if (!list?.length) return;
      setImportState("loading");
      setImportMsg(null);
      setLiveProgress(null);
      setUploadBytes(null);
      try {
        const r = await importFiles(Array.from(list), {
          onUploadProgress: (loaded, total) => {
            setUploadBytes({ loaded, total });
          },
          onProgress: ({ progress }) => {
            setLiveProgress({ ...progress });
          },
        });
        setUploadBytes(null);
        setLastImport(r);
        setLiveProgress(r.progress ?? null);
        const cacheNote =
          (r.totals.cacheHits ?? 0) > 0
            ? ` Файлов без повторной обработки (кеш): ${r.totals.cacheHits}.`
            : "";
        const dupNote = r.files.some((f) => f.duplicateFile || f.cacheHit)
          ? " Повторно загруженные копии пропущены по fingerprint."
          : "";
        setImportMsg(
          r.status === "failed"
            ? r.message || "Ошибка импорта"
            : `Импорт завершён. Новых баз: ${r.totals.basesInserted}, пропуск баз (уже в БД): ${r.totals.basesSkipped}; новых добавок: ${r.totals.addsInserted}, пропуск: ${r.totals.addsSkipped}; новых составных записей: ${r.totals.variantsInserted}, пропуск (уже есть): ${r.totals.variantsSkipped}. Строк пропущено: ${r.totals.rowsSkipped}; ошибок в логе: ${r.totals.errorsLogged}.${cacheNote}${dupNote}`
        );
        refreshRecent();
      } catch (e) {
        setImportMsg(e instanceof Error ? e.message : String(e));
        setUploadBytes(null);
      } finally {
        setImportState("idle");
      }
    },
    [refreshRecent]
  );

  const runSearch = useMemo(() => {
    let t: ReturnType<typeof setTimeout>;
    return (value: string) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const v = value.trim();
        if (!v) {
          setResults([]);
          setSearchState("idle");
          return;
        }
        setSearchState("loading");
        try {
          const { items } = await search(v);
          setResults(items);
          setSearchState("idle");
        } catch {
          setSearchState("error");
        }
      }, 220);
    };
  }, []);

  useEffect(() => {
    runSearch(q);
  }, [q, runSearch]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    if (selected.result_mode === "lazy") {
      setDetail({
        id: selected.id,
        composite_art: selected.composite_art,
        base_art: selected.base_art,
        add_art: selected.add_art,
        display_name: selected.display_name,
        base_name: selected.base_name,
        add_name: selected.add_name,
        source_filename: selected.source_filename,
        source_sheet: selected.source_sheet,
        source_row_base: selected.source_row_base,
        source_row_add: selected.source_row_add,
        import_job_id: selected.import_job_id,
      });
      setDetailState("idle");
      return;
    }
    setDetailState("loading");
    getItem(selected.id)
      .then((d) => {
        setDetail(d);
        setDetailState("idle");
      })
      .catch(() => setDetailState("error"));
  }, [selected]);

  const showPanel = importState === "loading" || (liveProgress?.files?.length ?? 0) > 0;

  return (
    <div className="layout">
      <header className="header">
        <h1>Локальная база артикулов</h1>
        <p className="muted">
          Импорт .xlsx: 2-й столбец — артикул (ER… или 4 цифры), 4-й — наименование.
          Данные накапливаются в локальном файле SQLite; дубликаты артикулов и составных
          ключей блокируются на уровне базы.
        </p>
      </header>

      <section className="card">
        <h2>Поиск</h2>
        <input
          className="search-input"
          placeholder="Составной артикул (ER…-0001 или без дефиса)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {searchState === "error" && (
          <p className="error">Ошибка поиска. Проверьте, что API запущен.</p>
        )}
        {!q.trim() && <p className="muted">Введите запрос</p>}
        {q.trim() && searchState === "loading" && (
          <p className="muted">Поиск…</p>
        )}
        {q.trim() && searchState === "idle" && results.length === 0 && (
          <p className="muted">Нет результатов</p>
        )}
        {results.length > 0 && (
          <div className="split">
            <div className="table-wrap">
              <table className="results">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Ранг</th>
                    <th>Режим</th>
                    <th>Источник</th>
                    <th>Составной</th>
                    <th>Итоговое имя</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((row) => (
                    <tr
                      key={row.id}
                      className={selected?.id === row.id ? "active" : ""}
                      onClick={() => setSelected(row)}
                    >
                      <td>{row.id}</td>
                      <td>{row.rank}</td>
                      <td>{row.result_mode === "lazy" ? "lazy" : "mat"}</td>
                      <td className="mono">{row.source_filename}</td>
                      <td className="mono">{row.composite_art}</td>
                      <td>{row.display_name || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="detail card-inner">
              {!selected && <p className="muted">Выберите строку</p>}
              {selected && detailState === "loading" && (
                <p className="muted">Загрузка карточки…</p>
              )}
              {selected && detailState === "error" && (
                <p className="error">Не удалось загрузить запись</p>
              )}
              {selected && detail && detailState === "idle" && (
                <ItemDetail data={detail} />
              )}
            </div>
          </div>
        )}
      </section>

      <section className="card card--import">
        <h2>Импорт Excel</h2>
        <label className="upload">
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            multiple
            disabled={importState === "loading"}
            onChange={(e) => onFiles(e.target.files)}
          />
          <span>
            {importState === "loading"
              ? "Идёт загрузка / импорт…"
              : "Выберите один или несколько .xlsx"}
          </span>
        </label>

        {uploadBytes && uploadBytes.total > 0 && (
          <div className="import-panel import-panel--upload">
            <div className="import-panel__head">
              <strong>Загрузка на сервер</strong>
              <span className="muted">
                {formatBytes(uploadBytes.loaded)} / {formatBytes(uploadBytes.total)}
              </span>
            </div>
            <ProgressBar
              percent={Math.min(100, Math.round((100 * uploadBytes.loaded) / uploadBytes.total))}
            />
          </div>
        )}

        {showPanel && (
          <ImportProgressPanel
            progress={liveProgress}
            jobStatus={importState === "loading" ? "processing" : undefined}
          />
        )}

        {importMsg && <p className="notice">{importMsg}</p>}
        {lastImport && lastImport.status === "completed" && (
          <div className="stats">
            <div>
              <strong>{lastImport.totals.basesInserted}</strong> новых баз
            </div>
            <div>
              <strong>{lastImport.totals.basesSkipped}</strong> баз уже были в БД
            </div>
            <div>
              <strong>{lastImport.totals.addsInserted}</strong> новых добавок
            </div>
            <div>
              <strong>{lastImport.totals.addsSkipped}</strong> добавок уже были
            </div>
            <div>
              <strong>{lastImport.totals.variantsInserted}</strong> новых составных
            </div>
            <div>
              <strong>{lastImport.totals.variantsSkipped}</strong> составных уже были
            </div>
            {(lastImport.totals.cacheHits ?? 0) > 0 && (
              <div>
                <strong>{lastImport.totals.cacheHits}</strong> файлов из кеша импорта
              </div>
            )}
          </div>
        )}
        {lastImport?.files?.length ? (
          <div className="recent-jobs">
            <h3 className="recent-jobs__title">Режимы обработки файлов</h3>
            <ul className="recent-jobs__list">
              {lastImport.files.map((f) => (
                <li key={`${f.filename}-${f.fingerprint || ""}`}>
                  <span className="mono">{f.filename}</span>:{" "}
                  {f.materializationMode || (f.cacheHit ? "already_imported" : "full")}
                  {typeof f.estimatedPairs === "number"
                    ? `; pairs≈${f.estimatedPairs}`
                    : ""}
                  {f.warnings?.length ? `; ${f.warnings.join(" ")}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {recentJobs.length > 0 && (
          <div className="recent-jobs">
            <h3 className="recent-jobs__title">Недавние задачи импорта</h3>
            <ul className="recent-jobs__list">
              {recentJobs.map((j) => (
                <li key={j.id}>
                  <span className="mono">{j.id.slice(0, 8)}…</span> — {j.status}{" "}
                  <span className="muted">
                    {j.started_at}
                    {j.finished_at ? ` → ${j.finished_at}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

    </div>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${p}%` }} />
    </div>
  );
}

function ImportProgressPanel({
  progress,
  jobStatus,
}: {
  progress: JobProgressPayload | null;
  jobStatus?: string;
}) {
  const files = progress?.files ?? [];
  const jobPct =
    typeof progress?.jobPercent === "number" ? progress.jobPercent : 0;
  if (!files.length) return null;

  return (
    <div className="import-panel">
      <div className="import-panel__head">
        <strong>Задача импорта</strong>
        {jobStatus && <span className="badge">{statusLabel(jobStatus)}</span>}
        {typeof progress?.queueWaitMs === "number" && progress.queueWaitMs > 0 && (
          <span className="muted">Ожидание в очереди: {progress.queueWaitMs} мс</span>
        )}
      </div>
      <div className="import-panel__jobbar">
        <span className="muted">Общий прогресс</span>
        <ProgressBar percent={jobPct} />
      </div>
      <ul className="import-files">
        {files.map((f, i) => (
          <FileProgressRow key={`${f.name}-${i}`} row={f} />
        ))}
      </ul>
    </div>
  );
}

function FileProgressRow({ row }: { row: ImportFileProgressRow }) {
  const err = row.error || (row.status === "failed" ? row.message : undefined);
  return (
    <li className="import-file">
      <div className="import-file__title">
        <span className="import-file__name">{row.name}</span>
        <span className="import-file__status">{statusLabel(row.status)}</span>
      </div>
      <ProgressBar percent={row.percent} />
      <dl className="import-file__stats">
        <dt>Строк обработано</dt>
        <dd>{row.rowsProcessed}{row.rowsTotal != null ? ` / ${row.rowsTotal}` : ""}</dd>
        <dt>Уник. баз (файл)</dt>
        <dd>{row.basesFound}</dd>
        <dt>Уник. добавок (файл)</dt>
        <dd>{row.addsFound}</dd>
        <dt>Составных создано</dt>
        <dd>{row.variantsInserted}</dd>
        <dt>Составных пропущено</dt>
        <dd>{row.variantsSkipped}</dd>
        {row.variantPairsTotal != null && row.variantPairsTotal > 0 && (
          <>
            <dt>Пары (прогресс)</dt>
            <dd>
              {row.variantPairsProcessed ?? 0} / {row.variantPairsTotal}
            </dd>
          </>
        )}
      </dl>
      {row.message && !err && <p className="import-file__msg muted">{row.message}</p>}
      {err && <p className="import-file__err error">{err}</p>}
    </li>
  );
}

function ItemDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="detail-body">
      <h3>Составной вариант #{String(data.id)}</h3>
      <dl>
        <dt>Составной артикул</dt>
        <dd className="mono">{String(data.composite_art ?? "")}</dd>
        <dt>Базовый ER</dt>
        <dd className="mono">{String(data.base_art ?? "")}</dd>
        <dt>Добавочный код</dt>
        <dd className="mono">{String(data.add_art ?? "")}</dd>
        <dt>Итоговое наименование</dt>
        <dd>{String(data.display_name ?? "—")}</dd>
        <dt>Имя базы</dt>
        <dd>{String(data.base_name ?? "—")}</dd>
        <dt>Имя добавки</dt>
        <dd>{String(data.add_name ?? "—")}</dd>
        <dt>Файл / строки (база + добавка)</dt>
        <dd>
          {String(data.source_filename)} / {String(data.source_row_base)} +{" "}
          {String(data.source_row_add)}
        </dd>
        <dt>Импорт (job)</dt>
        <dd className="mono">{String(data.import_job_id)}</dd>
      </dl>
    </div>
  );
}
