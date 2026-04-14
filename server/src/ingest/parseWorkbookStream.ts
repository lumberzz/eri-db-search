import ExcelJS from "exceljs";
import type { Row } from "exceljs";
import { cellToString } from "./cellValue.js";
import {
  cleanAddName,
  isAddFourDigitArticle,
  isBaseErArticle,
} from "../domain/erArticles.js";
import type { ParsedAddRow, ParsedBaseRow, RowParseIssue } from "./parseWorkbook.js";
import { ROW_PARSE_YIELD_EVERY } from "../config.js";

const COL_ART = 1;
const COL_NAME = 3;

export type SheetAccumulator = {
  sheet: string;
  rowsRead: number;
  baseRows: number;
  addRows: number;
  rowsSkipped: number;
  issueCount: number;
};

export type StreamRowEvent =
  | { type: "issue"; issue: RowParseIssue }
  | { type: "base"; row: ParsedBaseRow }
  | { type: "add"; row: ParsedAddRow };

function rowValues(row: Row, maxCol: number): string[] {
  const out: string[] = [];
  for (let c = 1; c <= maxCol; c++) {
    out.push(cellToString(row.getCell(c).value));
  }
  return out;
}

function scoreHeaderRow(values: string[]): number {
  return values.filter((v) => v.trim().length > 0).length;
}

export type StreamHandlers = {
  onRow: (ev: StreamRowEvent) => Promise<void>;
  yieldEvery: number;
};

/**
 * Потоковое чтение .xlsx с диска (WorkbookReader).
 */
export async function parseXlsxFileStream(
  filePath: string,
  logicalFilename: string,
  handlers: StreamHandlers
): Promise<{ sheets: SheetAccumulator[]; timingMs: { parse: number } }> {
  const t0 = performance.now();
  const sheets: SheetAccumulator[] = [];
  let rowYieldCounter = 0;

  const yieldLoop = async () => {
    rowYieldCounter += 1;
    if (rowYieldCounter >= handlers.yieldEvery) {
      rowYieldCounter = 0;
      await new Promise<void>((r) => setImmediate(r));
    }
  };

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: "ignore",
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    worksheets: "emit",
  });

  for await (const worksheet of reader) {
    const ws = worksheet as unknown as { state?: string; name?: string };
    if (ws.state === "hidden") continue;

    const sheetName = ws.name ?? "Sheet";
    const acc: SheetAccumulator = {
      sheet: sheetName,
      rowsRead: 0,
      baseRows: 0,
      addRows: 0,
      rowsSkipped: 0,
      issueCount: 0,
    };

    const buffered = new Map<number, Row>();
    let headerRowIndex = 1;
    let maxCol = 8;
    let headerResolved = false;

    const emitIssue = async (issue: RowParseIssue) => {
      acc.issueCount += 1;
      await handlers.onRow({ type: "issue", issue });
      await yieldLoop();
    };

    const resolveHeaderFromBuffer = async (): Promise<boolean> => {
      if (buffered.size === 0) {
        await emitIssue({
          filename: logicalFilename,
          sheet: acc.sheet,
          row: 0,
          message: "Лист без строки заголовков",
        });
        return false;
      }
      let best = 0;
      let bestRow = 1;
      for (let r = 1; r <= 15; r++) {
        const row = buffered.get(r);
        if (!row) continue;
        const values = rowValues(row, Math.max(row.actualCellCount, 8));
        const sc = scoreHeaderRow(values);
        if (sc > best) {
          best = sc;
          bestRow = r;
          maxCol = Math.max(values.length, 8);
        }
      }
      if (best === 0) {
        await emitIssue({
          filename: logicalFilename,
          sheet: acc.sheet,
          row: 0,
          message: "Лист без строки заголовков",
        });
        return false;
      }
      headerRowIndex = bestRow;
      return true;
    };

    const processDataRow = async (rowNumber: number, values: string[]) => {
      if (rowNumber <= headerRowIndex) return;
      acc.rowsRead += 1;
      const artCell =
        values.length > COL_ART ? values[COL_ART]?.trim() ?? "" : "";
      const nameCell =
        values.length > COL_NAME ? values[COL_NAME] ?? "" : "";

      if (!artCell) {
        acc.rowsSkipped += 1;
        await emitIssue({
          filename: logicalFilename,
          sheet: acc.sheet,
          row: rowNumber,
          message: "Пустой 2-й столбец (артикул)",
        });
        return;
      }

      if (isBaseErArticle(artCell)) {
        acc.baseRows += 1;
        await handlers.onRow({
          type: "base",
          row: {
            baseArt: artCell.trim(),
            baseName: nameCell.trim(),
            sourceFilename: logicalFilename,
            sourceSheet: acc.sheet,
            sourceRow: rowNumber,
          },
        });
        await yieldLoop();
        return;
      }

      if (isAddFourDigitArticle(artCell)) {
        acc.addRows += 1;
        await handlers.onRow({
          type: "add",
          row: {
            addArt: artCell.trim(),
            addName: cleanAddName(nameCell),
            sourceFilename: logicalFilename,
            sourceSheet: acc.sheet,
            sourceRow: rowNumber,
          },
        });
        await yieldLoop();
        return;
      }

      acc.rowsSkipped += 1;
      await emitIssue({
        filename: logicalFilename,
        sheet: acc.sheet,
        row: rowNumber,
        message: `Не распознан артикул «${artCell}» (ожидается ER… или 4 цифры)`,
      });
    };

    const flushBufferedDataRows = async () => {
      const sorted = [...buffered.keys()].sort((a, b) => a - b);
      for (const r of sorted) {
        const br = buffered.get(r)!;
        const vals = rowValues(br, Math.max(maxCol, br.actualCellCount, 8));
        await processDataRow(r, vals);
      }
      buffered.clear();
    };

    for await (const row of worksheet) {
      const rn = row.number;

      if (!headerResolved && rn <= 15) {
        buffered.set(rn, row);
        continue;
      }

      if (!headerResolved) {
        if (!(await resolveHeaderFromBuffer())) {
          headerResolved = true;
          break;
        }
        await flushBufferedDataRows();
        headerResolved = true;
        if (rn <= headerRowIndex) continue;
        const vals = rowValues(row, Math.max(maxCol, row.actualCellCount, 8));
        await processDataRow(rn, vals);
        continue;
      }

      if (rn <= headerRowIndex) continue;
      const vals = rowValues(row, Math.max(maxCol, row.actualCellCount, 8));
      await processDataRow(rn, vals);
    }

    if (!headerResolved) {
      if (await resolveHeaderFromBuffer()) {
        await flushBufferedDataRows();
      }
      headerResolved = true;
    }

    sheets.push(acc);
  }

  const parse = Math.round(performance.now() - t0);
  return { sheets, timingMs: { parse } };
}

export const defaultYieldEvery = ROW_PARSE_YIELD_EVERY;
