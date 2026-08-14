import type { ParsedAddRow, ParsedBaseRow } from "../ingest/parseWorkbook.js";
import { normalizeArticle } from "../normalize.js";

/** One base+add combination generated from a catalog workbook. */
export type FileArticlePair = {
  baseNorm: string;
  addNorm: string;
  baseArt: string;
  addArt: string;
  baseName: string;
  addName: string;
  sourceSheet: string;
  sourceRowBase: number;
  sourceRowAdd: number;
};

export type FileBaseArticle = ParsedBaseRow & { baseNorm: string };
export type FileAddArticle = ParsedAddRow & { addNorm: string };

/**
 * A catalog file defines two sets: base devices and additional configurations.
 * Every unique base can be combined with every unique additional code in that
 * same file. Source names and row numbers stay file-local instead of being
 * taken from globally deduplicated article tables.
 */
export class FileCombinationCollector {
  private readonly bases = new Map<string, FileBaseArticle>();
  private readonly adds = new Map<string, FileAddArticle>();

  onBase(row: ParsedBaseRow): void {
    const baseNorm = normalizeArticle(row.baseArt);
    if (!this.bases.has(baseNorm)) {
      this.bases.set(baseNorm, { ...row, baseNorm });
    }
  }

  onAdd(row: ParsedAddRow): void {
    const addNorm = normalizeArticle(row.addArt);
    if (!this.adds.has(addNorm)) {
      this.adds.set(addNorm, { ...row, addNorm });
    }
  }

  baseRows(): FileBaseArticle[] {
    return [...this.bases.values()];
  }

  addRows(): FileAddArticle[] {
    return [...this.adds.values()];
  }

  baseNorms(): Set<string> {
    return new Set(this.bases.keys());
  }

  addNorms(): Set<string> {
    return new Set(this.adds.keys());
  }

  get estimatedPairs(): number {
    return this.bases.size * this.adds.size;
  }

  pairs(): FileArticlePair[] {
    const pairs: FileArticlePair[] = [];
    for (const base of this.bases.values()) {
      for (const add of this.adds.values()) {
        pairs.push({
          baseNorm: base.baseNorm,
          addNorm: add.addNorm,
          baseArt: base.baseArt.trim(),
          addArt: add.addArt.trim(),
          baseName: base.baseName.trim(),
          addName: add.addName,
          sourceSheet:
            base.sourceSheet === add.sourceSheet
              ? base.sourceSheet
              : `${base.sourceSheet} + ${add.sourceSheet}`,
          sourceRowBase: base.sourceRow,
          sourceRowAdd: add.sourceRow,
        });
      }
    }
    return pairs;
  }
}
