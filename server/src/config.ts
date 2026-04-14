/**
 * Пороги производительности и очереди (переопределение через env).
 */
export const VARIANT_INSERT_BATCH = Math.max(
  100,
  parseInt(process.env.VARIANT_INSERT_BATCH || "1500", 10) || 1500
);

/** Пагинация уникальных add при декартовом умножении (не держим все adds в RAM). */
export const ADD_ARTICLE_PAGE = Math.max(
  100,
  parseInt(process.env.ADD_ARTICLE_PAGE || "400", 10) || 400
);

export const BASE_ARTICLE_PAGE = Math.max(
  100,
  parseInt(process.env.BASE_ARTICLE_PAGE || "400", 10) || 400
);

export const ROW_PARSE_YIELD_EVERY = Math.max(
  50,
  parseInt(process.env.ROW_PARSE_YIELD_EVERY || "200", 10) || 200
);

export const IMPORT_QUEUE_CONCURRENCY = Math.min(
  8,
  Math.max(1, parseInt(process.env.IMPORT_QUEUE_CONCURRENCY || "2", 10) || 2)
);

export const SEARCH_CACHE_MAX = Math.max(
  50,
  parseInt(process.env.SEARCH_CACHE_MAX || "400", 10) || 400
);

export const UPLOAD_MAX_MB = Math.max(
  10,
  parseInt(process.env.UPLOAD_MAX_MB || "200", 10) || 200
);

export const MATERIALIZE_WARN_PAIRS = Math.max(
  10_000,
  parseInt(process.env.MATERIALIZE_WARN_PAIRS || "250000", 10) || 250000
);

export const MATERIALIZE_LAZY_PAIRS = Math.max(
  20_000,
  parseInt(process.env.MATERIALIZE_LAZY_PAIRS || "1000000", 10) || 1000000
);

export const MATERIALIZE_REJECT_PAIRS = Math.max(
  50_000,
  parseInt(process.env.MATERIALIZE_REJECT_PAIRS || "5000000", 10) || 5000000
);

export const LAZY_SEARCH_CANDIDATE_LIMIT = Math.max(
  50,
  parseInt(process.env.LAZY_SEARCH_CANDIDATE_LIMIT || "3000", 10) || 3000
);

export const LAZY_SEARCH_SCOPE_LIMIT = Math.max(
  10,
  parseInt(process.env.LAZY_SEARCH_SCOPE_LIMIT || "150", 10) || 150
);
