import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const root = resolve(import.meta.dirname, "..");
export const testTitle = "示例论文 · 研究设计与证据链";
export const testText = "The field needs stronger evidence for the proposed mechanism. Independent animals were randomized to controlled conditions. The study compares intervention and control groups and reports uncertainty. ".repeat(40);
export const mockSummary = `## 1. 研究解决了什么领域问题
这是一份用于插件验证的模拟回答，不是真实论文评价。研究试图区分观察关联与干预证据。[§1]

## 2. 创新设计或巧思是什么
将**实验对照**与独立样本的验证连接起来，避免由单一结果推导全部结论。

## 3. 怎么逐步实施的
1. 明确待检验的问题与样本单位。
2. 建立实验组及对照组。
3. 通过独立验证检查结论。

## 4. 有什么核心结果逐个推进了逻辑链条
| 证据环节 | 支持什么 | 不能说明什么 |
| --- | --- | --- |
| 基线观察 | 存在待解释的现象 | 尚无因果结论 |
| 干预实验 | 提供机制检验线索 | 外推范围仍有限 |

问题 → 对照设计 → 干预结果 → 独立验证 → 有边界的结论。

## 5. 为什么能发表到该期刊（贡献）
**基于论文内容的贡献判断**：期刊名未知，当前材料不足以推断真实录用原因。需要回查完整证据。

<img src="https://evil.invalid/track" onerror="window.XSS=1">
<script>window.XSS=1</script>
[危险链接](javascript:alert(1))
`;

export async function fixturePdfs() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setTitle("Test PDF: independent evidence"); pdf.setAuthor("Test Author");
  for (let i = 1; i <= 2; i++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Scientific fixture, page ${i}`, { x: 50, y: 720, size: 20, font });
    for (let line = 0; line < 15; line++) page.drawText(`Independent units and controlled comparison. Result ${i}.${line + 1}.`, { x: 50, y: 680 - line * 24, size: 11, font });
    page.drawRectangle({ x: 50, y: 160, width: 440, height: 100, color: rgb(0.87, 0.92, 0.88) });
    page.drawText("Figure 1. A test visualization for PDF rendering.", { x: 60, y: 190, size: 13, font });
  }
  const text = await pdf.save();
  const scanPdf = await PDFDocument.create();
  const scan = scanPdf.addPage([612, 792]);
  scan.drawRectangle({ x: 50, y: 300, width: 400, height: 300, color: rgb(0.3, 0.5, 0.4) });
  const scanned = await scanPdf.save();
  await mkdir(join(root, "artifacts", "test-fixtures"), { recursive: true });
  const textPath = join(root, "artifacts", "test-fixtures", "paper.pdf"), scanPath = join(root, "artifacts", "test-fixtures", "scan.pdf");
  await writeFile(textPath, text); await writeFile(scanPath, scanned);
  return { text, scanned, textPath, scanPath };
}

export async function startServer() {
  const pdf = await fixturePdfs(), requests = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") { res.setHeader("Access-Control-Allow-Headers", "authorization, content-type"); res.end(); return; }
    if (path === "/models") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "deepseek-flash" }] })); return; }
    if (path === "/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ body, auth: req.headers.authorization, cookie: req.headers.cookie });
      if (body.model === "test-401") { res.writeHead(401); res.end("invalid test key"); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const text = body.model === "test-slow" ? mockSummary.repeat(20) : mockSummary;
      let index = 0;
      const timer = setInterval(() => {
        if (index < text.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(index, index + 70) }, finish_reason: null }] })}\r\n\r\n`);
          index += 70;
        } else {
          if (body.model !== "test-cutoff") res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 } })}\n\ndata: [DONE]\n\n`);
          clearInterval(timer); res.end();
        }
      }, body.model === "test-slow" ? 120 : 8);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (path === "/fixture/article") {
      res.setHeader("Content-Type", "text/html;charset=utf-8");
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${testTitle}</title><meta name="citation_title" content="${testTitle}"><meta name="citation_journal_title" content="Test Journal"><meta name="citation_pdf_url" content="/fixture/paper.pdf"></head><body><nav>Navigation</nav><article><h1>${testTitle}</h1><h2>Introduction</h2><p>${testText}</p><h2>Methods</h2><p>${testText}</p><h2>Results</h2><p>${testText}</p></article></body></html>`); return;
    }
    if (path === "/fixture/paper.pdf" || path === "/fixture/download") {
      res.setHeader("Content-Type", "application/pdf"); res.end(pdf.text); return;
    }
    if (path === "/fixture/scan.pdf") { res.setHeader("Content-Type", "application/pdf"); res.end(pdf.scanned); return; }
    if (path === "/test-config") { res.end(JSON.stringify({ requests: requests.length })); return; }
    try {
      const target = resolve(root, "dist", `.${decodeURIComponent(path === "/" ? "/sidebar.html" : path)}`);
      if (!target.startsWith(join(root, "dist") + "\\" ) && !target.startsWith(join(root, "dist") + "/")) throw new Error("invalid path");
      const data = await readFile(target);
      const types = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      res.setHeader("Content-Type", `${types[extname(target)] || "application/octet-stream"};charset=utf-8`);
      res.end(data);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, pdf, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
