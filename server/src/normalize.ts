/**
 * Нормализация сегментов артикула: NFKC, верхний регистр, только A–Z и 0–9.
 */
export function normalizeArticle(input: string): string {
  if (input == null || typeof input !== "string") return "";
  const trimmed = input.trim().normalize("NFKC");
  return trimmed
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Схлопывание пробелов для отображения / сравнения «как ввёл пользователь».
 */
export function collapseSpaces(input: string): string {
  return input.trim().normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * Нормализованный ключ составного артикула для индекса и точного поиска:
 * ER-часть + add-часть без дефиса и пробелов, только A–Z0–9.
 * Пример: ER010000000001-0001 → ER0100000000010001
 */
export function compositeNormalizedKey(baseArt: string, addArt: string): string {
  return normalizeArticle(baseArt) + normalizeArticle(addArt);
}

/**
 * Нормализация пользовательского запроса по составному артикулу:
 * trim, верхний регистр, схлопнуть пробелы, убрать всё кроме букв/цифр.
 * Поддерживает ввод с дефисом, без дефиса, с пробелами вокруг дефиса.
 */
export function normalizeCompositeSearchInput(raw: string): string {
  if (raw == null || typeof raw !== "string") return "";
  const collapsed = collapseSpaces(raw).toUpperCase();
  return collapsed.replace(/[^A-Z0-9]/g, "");
}

