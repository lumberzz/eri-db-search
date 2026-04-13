import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const out = path.join(repoRoot, "data", "sample-import.xlsx");

async function main() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");
  ws.addRow(["A", "Артикул", "C", "Наименование"]);
  ws.addRow([
    "",
    "ER010000000001",
    "",
    "Коробка коммутационная взрывозащищенная из алюминиевого сплава ККВ-07е-Ex-А-Р1-У-БК1%-ГП%%ВУ%",
  ]);
  ws.addRow(["", "0000", "", ", без каб вводов"]);
  ws.addRow(["", "0001", "", ", КВБ12, КВБ12"]);
  ws.addRow(["", "ER010000000002", "", "Второй базовый артикул"]);
  ws.addRow(["", "0002", "", "  , запасной вариант  "]);
  ws.addRow(["", "", "", "Пустой артикул — пропуск"]);
  ws.addRow(["", "junk", "", "Мусор"]);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  await wb.xlsx.writeFile(out);
  console.log("Wrote", out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
