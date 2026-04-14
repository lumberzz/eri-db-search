import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";

const root = process.cwd();
const outDir = path.join(root, "build", "pkg");
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "server", "src", "index.pkg.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: path.join(outDir, "index.js"),
  sourcemap: false,
  legalComments: "none",
  external: ["better-sqlite3"],
});

console.log(`Built pkg backend bundle: ${path.join(outDir, "index.js")}`);
