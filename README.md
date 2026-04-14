# ERI DB Search — локальная накопительная база составных артикулов

Web-приложение для импорта `.xlsx`, разделения строк на **базовые артикулы** (`ER…`) и **добавочные коды** (`0000`…`9999`), материализации **составных** комбинаций `ER…-0001` и быстрого поиска. Данные хранятся в **локальном файле SQLite** и **накапливаются** между сессиями.

## Стек

- **Frontend:** React 18, TypeScript, Vite  
- **Backend:** Node.js, Express, TypeScript  
- **БД:** SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3)), режим WAL  
- **Excel:** [ExcelJS](https://github.com/exceljs/exceljs) (потоковое чтение)

## Локальная база данных (persistent)

- **Dev mode (`node`)**: по умолчанию `data/app.db` в корне репозитория.  
- **Packaged mode (`.exe`)**:
  - Windows: `%LOCALAPPDATA%/ERI DB Search/data/app.db`
  - fallback: `./data/app.db` рядом с бинарником
- Переопределения:
  - `APP_DATA_DIR` — writable data root
  - `DATABASE_PATH` — абсолютный путь или путь относительно `APP_DATA_DIR`
- Upload temp-файлы: `<dataDir>/uploads`.

### Сброс / пересоздание базы

1. Остановите сервер.  
2. Удалите файл базы, например: `rm data/app.db` (и при необходимости `data/app.db-wal`, `data/app.db-shm`).  
3. Запустите приложение снова — схема создастся заново.

Если раньше использовался `data/articles.sqlite`, данные не переносятся автоматически: либо переименуйте файл в `app.db`, либо укажите `DATABASE_PATH=./data/articles.sqlite`.

## Накопительный импорт и защита от дублей

| Уровень | Правило уникальности | Поведение при повторе |
|--------|----------------------|------------------------|
| **База** | `base_art_normalized` (глобально по БД) | `INSERT … ON CONFLICT DO NOTHING` — в БД одна строка на нормализованный ER |
| **Добавка** | `add_art_normalized` | то же для кода из 4 цифр |
| **Составной вариант** | `composite_art_normalized` | `ON CONFLICT DO NOTHING` + уникальный индекс — один составной ключ в БД и в поиске |

Импорт **нескольких файлов подряд** добавляет только новые нормализованные ключи; уже существующие базы/добавки/составные не дублируются.

### Повторная загрузка того же файла

- По **SHA-256 (fingerprint)** и имени файла проверяется таблица `import_file_cache`.  
- Если файл не менялся и не передан `force=1`, задача **пропускает полный разбор** и помечает файл как **«Уже импортирован»** (без дублей в БД).  
- Принудительно пересобрать: `POST /api/import?force=1`.

### Hybrid materialization modes

Для каждого файла после разбора считаются `uniqueBases`, `uniqueAdds`, `estimatedPairs = uniqueBases * uniqueAdds` и policy выбирает режим:

- **full**: полная materialization в `search_variants`;
- **lazy**: materialization пропускается, файл регистрируется в `imported_files` + membership-таблицах, поиск идёт synthetic path;
- **rejected**: файл отклонён hard-limit policy.

Пороговые значения: `MATERIALIZE_WARN_PAIRS`, `MATERIALIZE_LAZY_PAIRS`, `MATERIALIZE_REJECT_PAIRS`.

### Декартово произведение в рамках одного файла

После разбора файла берётся множество **уникальных** `base_art_normalized` и **уникальных** `add_art_normalized`, встреченных **в этом файле**, и материализуются пары с использованием **канонических** `id` из глобальной БД (в т.ч. если ER или код добавки уже были внесены предыдущим импортом).

## Прогресс импорта

- `POST /api/import` отвечает **202** и `jobId`.  
- Клиент показывает **реальный прогресс загрузки** (XHR `upload.onprogress`).  
- Далее опрос `GET /api/jobs/:id`: в `progress_json` массив **`files[]`** — по одному объекту на файл: статус (`hashing`, `parsing`, `generating_variants`, `saving`, `completed`, `already_imported`, `failed` и т.д.), **процент**, счётчики строк, уникальных баз/добавок, созданных/пропущенных составных, пары для фазы вариантов.  
- **Хеширование:** процент от прочитанных байт к размеру файла.  
- **Парсинг:** без знаменателя заранее — отображается число обработанных строк; после парсинга процент переходит к плато перед фазой вариантов.  
- **Варианты:** `variantPairsProcessed / variantPairsTotal` (произведение числа уникальных баз и добавок **файла**).  
- Список последних задач: `GET /api/jobs?limit=15`.

Тяжёлые импорты **сериализуются** на одном соединении SQLite (безопасные temp-таблицы и транзакции); очередь `p-queue` ограничивает параллелизм.

## Модель данных (основное)

| Таблица | Назначение |
|--------|------------|
| `import_jobs` | История импортов, `progress_json`, `summary_json` |
| `import_file_cache` | Fingerprint файла → метаданные последнего успешного импорта |
| `base_articles` | Базовые ER, уникальность по `base_art_normalized` |
| `add_articles` | Коды добавок, уникальность по `add_art_normalized` |
| `search_variants` | Составные записи, уникальность по `composite_art_normalized` |
| `search_variants_fts` | FTS5 для подстрочного / префиксного поиска |

## Поиск

- Запрос нормализуется так же, как раньше (дефис/пробелы/регистр).  
- Дубликатов в выдаче нет: в таблице не может быть двух строк с одним `composite_art_normalized`.

## Быстрый старт

```bash
npm install
npm run dev
```

Браузер: **http://127.0.0.1:5173** (прокси `/api` → **8787**).

### Пример файла

```bash
npm run sample:xlsx
```

Файл: `data/sample-import.xlsx` — загрузите через UI.

## Скрипты

| Команда | Описание |
|--------|----------|
| `npm run dev` | API + фронт |
| `npm run build` | Сборка server + client |
| `npm start` | API + статика из `client/dist` |
| `npm run sample:xlsx` | Пример Excel |
| `npm run test -w server` | Тесты (в т.ч. интеграция SQLite / уникальные ключи) |
| `npm run perf:smoke -w server` | Смоук производительности материализации пар |
| `npm run package:prepare` | Build + подготовка `dist/win64/client-dist` |
| `npm run package:win64` | Сборка Windows x64 `.exe` |

## Упаковка в Windows x64 `.exe`

```bash
npm install
npm run package:win64
```

Результат:
- `dist/win64/eri-db-search.exe`
- `dist/win64/client-dist/*`

Запуск:
- открыть `dist/win64/eri-db-search.exe`
- приложение поднимет локальный сервер и откроет default browser на `http://127.0.0.1:8787` после успешного старта.
- если сервер не стартует, ошибка записывается в `startup.log` рядом с writable data dir.

### Runtime path logic (important)

- В packaged-режиме приложение **не пишет** в bundled snapshot.
- SQLite и uploads всегда в writable external directory.
- Frontend assets ищутся:
  1) рядом с `.exe` в `client-dist`
  2) fallback на snapshot assets, если sidecar-папки нет.

### Troubleshooting Windows startup

Если окно консоли мгновенно закрывается:

1. Запустите `.exe` из `cmd` (чтобы увидеть stdout/stderr).
2. Проверьте `startup.log`:
   - `%LOCALAPPDATA%/ERI DB Search/data/startup.log` (default packaged path)
   - или `<APP_DATA_DIR>/startup.log`, если задан `APP_DATA_DIR`.
3. Частая причина — native module `better-sqlite3` на целевой Windows-хосте.

## Переменные окружения

См. `.env.example`: `PORT`, `APP_DATA_DIR`, `DATABASE_PATH`, `CLIENT_DIST`, `AUTO_OPEN_BROWSER`, и пороги батчей/очереди в `server/src/config.ts`.

## Миграции схемы

При первом запуске новой версии выполняется миграция **v2**: дедупликация существующих строк и создание уникальных индексов по нормализованным ключам. Удаление устаревших таблиц `items` / `items_fts` — как раньше (см. `server/src/db.ts`).
