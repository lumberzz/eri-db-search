import {
  collapseSpaces,
  normalizeArticle,
  normalizeCompositeSearchInput,
} from "../normalize.js";

export type ParsedSearchQuery = {
  raw: string;
  /** Alphanumeric-only form used by article search. Empty for name+code. */
  articleFlat: string;
  /** Base-name fragment with the four-digit code removed. */
  namePart: string | null;
  /** Unicode-normalized words that must all occur in the base name. */
  nameTokens: string[];
  /** Exact four-digit addition code, including 0000 and 0001. */
  addCode: string | null;
  /** ER prefix for explicit wildcard input such as ER*-0000. */
  basePrefix: string | null;
};

const ER_ADD_RE = /^(ER[A-Z0-9]*)(\*)?\s*[\s\-–—]\s*(\d{4})$/iu;
const FOUR_DIGIT_TOKEN_RE = /(^|[^\d])(\d{4})(?=$|[^\d])/gu;

export function normalizeSearchText(input: string): string {
  return collapseSpaces(input)
    .toLocaleUpperCase("ru-RU")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchTextTokens(input: string): string[] {
  const normalized = normalizeSearchText(input);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}

/**
 * Supports:
 * - ER article, with or without a separator;
 * - ER*-0000 wildcard;
 * - 0000 / 0001 by themselves;
 * - base-name words and a four-digit code in any order.
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const trimmed = collapseSpaces(raw);
  if (!trimmed) {
    return {
      raw: "",
      articleFlat: "",
      namePart: null,
      nameTokens: [],
      addCode: null,
      basePrefix: null,
    };
  }

  const erAdd = trimmed.match(ER_ADD_RE);
  if (erAdd) {
    const base = normalizeArticle(erAdd[1]!);
    const wildcard = erAdd[2] === "*";
    const add = erAdd[3]!;
    return {
      raw: trimmed,
      articleFlat: wildcard ? "" : base + normalizeArticle(add),
      namePart: null,
      nameTokens: [],
      addCode: add,
      basePrefix: wildcard ? base : null,
    };
  }

  const codeMatches = [...trimmed.matchAll(FOUR_DIGIT_TOKEN_RE)];
  if (codeMatches.length === 1 && !normalizeArticle(trimmed).startsWith("ER")) {
    const match = codeMatches[0]!;
    const code = match[2]!;
    const codeOffset = match.index! + match[1]!.length;
    const remainder = `${trimmed.slice(0, codeOffset)} ${trimmed.slice(
      codeOffset + code.length
    )}`.replace(/[\s,;.\-–—]+/gu, " ").trim();
    const tokens = searchTextTokens(remainder);
    return {
      raw: trimmed,
      articleFlat: tokens.length ? "" : code,
      namePart: tokens.length ? remainder : null,
      nameTokens: tokens,
      addCode: code,
      basePrefix: null,
    };
  }

  return {
    raw: trimmed,
    articleFlat: normalizeCompositeSearchInput(trimmed),
    namePart: null,
    nameTokens: [],
    addCode: null,
    basePrefix: null,
  };
}

/** Split ER…dddd only when the user typed an explicit separator in the query. */
export function splitCompositeFromQuery(
  raw: string,
  _flat: string
): { er: string; add: string } | null {
  const trimmed = collapseSpaces(raw);
  const erAdd = trimmed.match(ER_ADD_RE);
  if (erAdd) {
    return {
      er: normalizeArticle(erAdd[1]!),
      add: erAdd[3]!,
    };
  }
  return null;
}
