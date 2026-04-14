import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "dist", "win64");
const clientDist = path.join(root, "client", "dist");
const outClientDist = path.join(outDir, "client-dist");

if (!fs.existsSync(clientDist)) {
  throw new Error(`Missing client build: ${clientDist}`);
}

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(outClientDist, { recursive: true, force: true });
fs.cpSync(clientDist, outClientDist, { recursive: true });

console.log(`Prepared Windows package assets: ${outClientDist}`);
