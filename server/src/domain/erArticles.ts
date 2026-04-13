/**
 * Распознавание базовых (ER…) и добавочных (4 цифры) артикулов, очистка имён, склейка displayName.
 */

const LEADING_COMMA_SPACE = /^[\s,]+/;

/** Базовый артикул: значение 2-го столбца начинается с ER (без учёта регистра). */
export function isBaseErArticle(col2: string): boolean {
  const t = col2.trim();
  if (t.length < 2) return false;
  return t.slice(0, 2).toUpperCase() === "ER";
}

/** Добавочный: ровно 4 символа, все — цифры (после trim). */
export function isAddFourDigitArticle(col2: string): boolean {
  const t = col2.trim();
  return t.length === 4 && /^\d{4}$/.test(t);
}

/**
 * Очистка имени добавки: ведущие запятые, пробелы, вариант `", "`.
 */
export function cleanAddName(raw: string | null | undefined): string {
  if (raw == null) return "";
  let s = String(raw).trim().normalize("NFKC");
  s = s.replace(LEADING_COMMA_SPACE, "");
  s = s.replace(/^["']+\s*,\s*/u, "");
  s = s.replace(/^"\s*,\s*"\s*/u, "");
  s = s.replace(LEADING_COMMA_SPACE, "");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Итоговое имя: base + ", " + add без двойных запятых и лишних пробелов.
 */
export function mergeDisplayName(baseName: string, addName: string): string {
  const base = baseName.trim().replace(/\s+/g, " ");
  const add = cleanAddName(addName);
  if (!add) return base;
  if (!base) return add;
  const baseNoTrailingComma = base.replace(/\s*,\s*$/u, "").trimEnd();
  const part = add.replace(/^,\s*/u, "").trim();
  if (!part) return baseNoTrailingComma;
  let out = `${baseNoTrailingComma}, ${part}`;
  out = out.replace(/,\s*,+/g, ", ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}
