export type MaterializationMode = "full" | "lazy" | "rejected";

export type MaterializationDecision = {
  mode: MaterializationMode;
  warnings: string[];
  reason: string;
};

export function decideMaterializationMode(
  uniqueBases: number,
  uniqueAdds: number,
  estimatedPairs: number,
  cfg: {
    warnPairs: number;
    lazyPairs: number;
    rejectPairs: number;
  }
): MaterializationDecision {
  if (estimatedPairs >= cfg.rejectPairs) {
    return {
      mode: "lazy",
      warnings: [
        `Оценка ${estimatedPairs} пар превышает hard-limit ${cfg.rejectPairs}; включён lazy-mode.`,
      ],
      reason: "hard_limit_forced_lazy",
    };
  }
  if (estimatedPairs >= cfg.lazyPairs) {
    return {
      mode: "lazy",
      warnings: [
        `Оценка ${estimatedPairs} пар превышает порог lazy-mode ${cfg.lazyPairs}.`,
      ],
      reason: "lazy_threshold_exceeded",
    };
  }
  if (estimatedPairs >= cfg.warnPairs) {
    return {
      mode: "full",
      warnings: [
        `Оценка ${estimatedPairs} пар выше порога предупреждения ${cfg.warnPairs}.`,
      ],
      reason: "warn_threshold_exceeded",
    };
  }
  void uniqueBases;
  void uniqueAdds;
  return { mode: "full", warnings: [], reason: "within_limits" };
}
