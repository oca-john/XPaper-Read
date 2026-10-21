import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { PALETTES, bookIcon } from "../src/core/appearance.js";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist");
await mkdir(out, { recursive: true });
await cp(join(root, "extension"), out, { recursive: true });
for (const accent of Object.keys(PALETTES)) {
  await writeFile(join(out, "icons", `book-${accent}.svg`), bookIcon(accent));
}
await writeFile(join(out, "icons", "book.svg"), bookIcon("blue"));
const common = { bundle: true, target: "firefox142", legalComments: "eof", charset: "utf8", logLevel: "info" };
await build({ ...common, entryPoints: [join(root, "src/sidebar.js")], outfile: join(out, "sidebar.js"), format: "esm" });
await build({ ...common, entryPoints: [join(root, "src/extract.js")], outfile: join(out, "extract.js"), format: "iife", globalName: "XPaperCapture" });
await build({ ...common, entryPoints: [join(root, "src/background.js")], outfile: join(out, "background.js"), format: "iife" });
await build({ ...common, entryPoints: [join(root, "src/deepseek.js")], outfile: join(out, "deepseek.js"), format: "iife" });
const pdf = join(root, "node_modules/pdfjs-dist");
await mkdir(join(out, "vendor"), { recursive: true });
await cp(join(pdf, "build/pdf.worker.mjs"), join(out, "vendor/pdf.worker.mjs"));
await cp(join(pdf, "cmaps"), join(out, "vendor/cmaps"), { recursive: true });
await cp(join(pdf, "standard_fonts"), join(out, "vendor/standard_fonts"), { recursive: true });
await mkdir(join(out, "vendor/wasm"), { recursive: true });
for (const file of ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js", "LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_PDFJS_JBIG2", "LICENSE_PDFJS_OPENJPEG"]) {
  await cp(join(pdf, "wasm", file), join(out, "vendor/wasm", file));
}
const licenses = [
  ["PDF.js", "pdfjs-dist/LICENSE"],
  ["Mozilla Readability", "@mozilla/readability/LICENSE.md"],
  ["DOMPurify", "dompurify/LICENSE"],
  ["Marked", "marked/LICENSE"],
];
let notices = "XPaper-Read - Third-party notices\n\n";
for (const [name, path] of licenses) notices += `\n===== ${name} =====\n\n${await readFile(join(root, "node_modules", path), "utf8")}\n`;
await writeFile(join(out, "THIRD_PARTY_LICENSES.txt"), notices);
console.log(`Firefox extension built: ${out}`);
