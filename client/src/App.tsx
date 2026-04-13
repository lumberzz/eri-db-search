import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getItem,
  importFiles,
  search,
  type ImportResult,
  type SearchItem,
} from "./api";

type LoadState = "idle" | "loading" | "error";

export default function App() {
  const [importState, setImportState] = useState<LoadState>("idle");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<ImportResult | null>(null);

  const [q, setQ] = useState("");
  const [searchState, setSearchState] = useState<LoadState>("idle");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [selected, setSelected] = useState<SearchItem | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("idle");

  const onFiles = useCallback(async (list: FileList | null) => {
    if (!list?.length) return;
    setImportState("loading");
    setImportMsg(null);
    try {
      const r = await importFiles(Array.from(list));
      setLastImport(r);
      setImportMsg(
        r.status === "failed"
          ? r.message || "Ошибка импорта"
          : `Импорт: баз ${r.totals.basesInserted}, добавок ${r.totals.addsInserted}, составных вариантов ${r.totals.variantsInserted}; пропусков строк ${r.totals.rowsSkipped}; ошибок в логе ${r.totals.errorsLogged}`
      );
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setImportState("idle");
    }
  }, []);

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
    setDetailState("loading");
    getItem(selected.id)
      .then((d) => {
        setDetail(d);
        setDetailState("idle");
      })
      .catch(() => setDetailState("error"));
  }, [selected]);

  return (
    <div className="layout">
      <header className="header">
        <h1>Локальная база артикулов</h1>
        <p className="muted">
          Импорт .xlsx: 2-й столбец — артикул (ER… или 4 цифры), 4-й — наименование.
          Поиск по составному артикулу вида ER…-0001.
        </p>
      </header>

      <section className="card">
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
              ? "Импорт…"
              : "Выберите один или несколько .xlsx"}
          </span>
        </label>
        {importMsg && <p className="notice">{importMsg}</p>}
        {lastImport && lastImport.status === "completed" && (
          <div className="stats">
            <div>
              <strong>{lastImport.totals.basesInserted}</strong> новых баз
            </div>
            <div>
              <strong>{lastImport.totals.addsInserted}</strong> новых добавок
            </div>
            <div>
              <strong>{lastImport.totals.variantsInserted}</strong> новых
              составных записей
            </div>
            <div>
              <strong>{lastImport.totals.variantsSkipped}</strong> уже существующих
              пар (повтор)
            </div>
          </div>
        )}
      </section>

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
    </div>
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
