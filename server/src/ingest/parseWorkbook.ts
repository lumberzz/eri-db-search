import ExcelJS from "exceljs";
import { cellToString } from "./cellValue.js";
import {
  cleanAddName,
  isAddFourDigitArticle,
  isBaseErArticle,
} from "../domain/erArticles.js";

/** 1-based Excel: столбец 2 → индекс 1, столбец 4 → индекс 3 */
const COL_ART = 1;
const COL_NAME = 3;

export type ParsedBaseRow = {
  baseArt: string;
  baseName: string;
  sourceFilename: string;
  sourceSheet: string;
  sourceRow: number;
};

export type ParsedAddRow = {
  addArt: string;
  addName: string;
  sourceFilename: string;
  sourceSheet: string;
  sourceRow: number;
};

export type RowParseIssue = {
  filename: string;
  sheet: string;
  row: number;
  message: string;
};

export type SheetParseResult = {
  sheet: string;
  rowsRead: number;
  bases: ParsedBaseRow[];
  adds: ParsedAddRow[];
  rowsSkipped: number;
  issues: RowParseIssue[];
};

export type FileParseResult = {
  filename: string;
  sheets: SheetParseResult[];
};

function rowValues(row: ExcelJS.Row, maxCol: number): string[] {
  const out: string[] = [];
  for (let c = 1; c <= maxCol; c++) {
    const cell = row.getCell(c);
    out.push(cellToString(cell.value));
  }
  return out;
}

export async function parseXlsxBuffer(
  buffer: Buffer,
  filename: string
): Promise<FileParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer, {
    ignoreNodes: ["dataValidations", "conditionalFormatting", "hyperlinks"],
  });

  const sheets: SheetParseResult[] = [];

  workbook.eachSheet((worksheet) => {
    if (worksheet.state === "hidden") return;

    const issues: RowParseIssue[] = [];
    const bases: ParsedBaseRow[] = [];
    const adds: ParsedAddRow[] = [];
    let rowsRead = 0;
    let rowsSkipped = 0;

    let headers: string[] = [];
    let maxCol = 0;
    let headerRowIndex = 1;
    let bestScore = 0;

    for (let r = 1; r <= 15; r++) {
      const row = worksheet.getRow(r);
      if (!row.actualCellCount) continue;
      const values = rowValues(row, Math.max(row.actualCellCount, 8));
      const score = values.filter((v) => v.trim().length > 0).length;
      if (score > bestScore) {
        bestScore = score;
        headers = values;
        maxCol = Math.max(values.length, 8);
        headerRowIndex = r;
      }
    }

    if (headers.length === 0) {
      issues.push({
        filename,
        sheet: worksheet.name,
        row: 0,
        message: "Лист без строки заголовков",
      });
      sheets.push({
        sheet: worksheet.name,
        rowsRead: 0,
        bases: [],
        adds: [],
        rowsSkipped: 0,
        issues,
      });
      return;
    }

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRowIndex) return;
      rowsRead += 1;

      const values = rowValues(row, Math.max(maxCol, row.actualCellCount, 8));
      const artCell =
        values.length > COL_ART ? values[COL_ART]?.trim() ?? "" : "";
      const nameCell =
        values.length > COL_NAME ? values[COL_NAME] ?? "" : "";

      if (!artCell) {
        rowsSkipped += 1;
        issues.push({
          filename,
          sheet: worksheet.name,
          row: rowNumber,
          message: "Пустой 2-й столбец (артикул)",
        });
        return;
      }

      if (isBaseErArticle(artCell)) {
        bases.push({
          baseArt: artCell.trim(),
          baseName: nameCell.trim(),
          sourceFilename: filename,
          sourceSheet: worksheet.name,
          sourceRow: rowNumber,
        });
        return;
      }

      if (isAddFourDigitArticle(artCell)) {
        adds.push({
          addArt: artCell.trim(),
          addName: cleanAddName(nameCell),
          sourceFilename: filename,
          sourceSheet: worksheet.name,
          sourceRow: rowNumber,
        });
        return;
      }

      rowsSkipped += 1;
      issues.push({
        filename,
        sheet: worksheet.name,
        row: rowNumber,
        message: `Не распознан артикул «${artCell}» (ожидается ER… или 4 цифры)`,
      });
    });

    sheets.push({
      sheet: worksheet.name,
      rowsRead,
      bases,
      adds,
      rowsSkipped,
      issues,
    });
  });

  return { filename, sheets };
}
