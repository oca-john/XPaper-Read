import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { zipSync } from "fflate";

const root = resolve(import.meta.dirname, ".."), dist = join(root, "dist");
const files = {};
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files[relative(dist, path).replaceAll("\\", "/")] = new Uint8Array(await readFile(path));
  }
}
await walk(dist);
const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
await mkdir(join(root, "artifacts"), { recursive: true });
const path = join(root, "artifacts", `XPaper-Read-${manifest.version}.xpi`);
const packageBytes = zipSync(files, { level: 6 });
await writeFile(path, packageBytes);
console.log(`Unsigned package: ${path}`);
const sourceFiles = {};
async function sourceWalk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await sourceWalk(path);
    else sourceFiles[relative(root, path).replaceAll("\\", "/")] = new Uint8Array(await readFile(path));
  }
}
for (const folder of ["extension", "src", "scripts", "tests", "docs", "assets"]) await sourceWalk(join(root, folder));
for (const name of ["package.json", "package-lock.json", "README.md", ".gitignore"]) {
  sourceFiles[name] = new Uint8Array(await readFile(join(root, name)));
}
const sourcePath = join(root, "artifacts", `XPaper-Read-${manifest.version}-source.zip`);
await writeFile(sourcePath, zipSync(sourceFiles, { level: 6 }));
console.log(`Reproducible source: ${sourcePath}`);
