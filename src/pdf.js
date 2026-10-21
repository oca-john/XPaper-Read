import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import { LIMITS } from "./core/defaults.js";
import { normalizeText, parsePageRange, safeHttpUrl, validateSource } from "./core/source.js";

export function configurePdf(baseUrl) {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.mjs", baseUrl).href;
}

export async function fetchPdf(url, { signal, fetchFn = fetch } = {}) {
  if (!safeHttpUrl(url)) throw new Error("无法直接读取此 PDF 地址。请下载后导入 PDF 文件。");
  const timeout = AbortSignal.timeout(60000);
  const response = await fetchFn(url, {
    credentials: "include", redirect: "follow", referrerPolicy: "no-referrer",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`PDF 下载失败（HTTP ${response.status}）。请在浏览器下载后导入。`);
  const length = Number(response.headers.get("content-length")) || 0;
  if (length > LIMITS.pdfBytes) throw new Error("PDF 超过 40 MB，请使用较小的文件。");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("无法读取 PDF 响应，请下载后导入。");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.pdfBytes) throw new Error("PDF 超过 40 MB，请使用较小的文件。");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  if (!new TextDecoder().decode(data.slice(0, 1024)).includes("%PDF-")) {
    throw new Error("下载地址没有返回 PDF，可能需要登录或已触发网站验证。请下载 PDF 后使用“导入 PDF”。");
  }
  return data;
}

export function textFromPdfItems(items) {
  let result = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    result += item.str + (item.hasEOL ? "\n" : " ");
  }
  return normalizeText(result.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2"));
}

export async function extractPdf(data, {
  title = "PDF 文献", url = "", pageRange = "", visual = false,
  baseUrl = new URL("../", import.meta.url).href, signal, onProgress = () => {},
} = {}) {
  if (data.byteLength > LIMITS.pdfBytes) throw new Error("PDF 超过 40 MB，请使用较小的文件。");
  signal?.throwIfAborted();
  const loading = pdfjs.getDocument({
    data, isEvalSupported: false, useWasm: false, enableXfa: false, disableWorkerRendering: true,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    cMapUrl: new URL("vendor/cmaps/", baseUrl).href, cMapPacked: true,
    standardFontDataUrl: new URL("vendor/standard_fonts/", baseUrl).href,
    wasmUrl: new URL("vendor/wasm/", baseUrl).href,
  });
  const cancel = () => { loading.destroy().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const pdf = await loading.promise;
    const pages = parsePageRange(pageRange, pdf.numPages);
    if (pages.length > LIMITS.pdfPages) throw new Error(`一次最多提取 ${LIMITS.pdfPages} 页，请填写页码范围。`);
    if (visual && pages.length > LIMITS.visualPages) throw new Error(`图文模式一次最多 ${LIMITS.visualPages} 页，请填写页码范围。`);
    const blocks = [], weakPages = [];
    let chars = 0, imageBytes = 0;
    const metadata = await pdf.getMetadata().catch(() => ({ info: {} }));
    for (let i = 0; i < pages.length; i++) {
      signal?.throwIfAborted();
      onProgress(`正在读取 PDF 第 ${pages[i]} 页（${i + 1}/${pages.length}）…`);
      const page = await pdf.getPage(pages[i]);
      const content = await page.getTextContent();
      const text = textFromPdfItems(content.items);
      if (text.length < 80) weakPages.push(pages[i]);
      chars += text.length;
      if (chars > LIMITS.sourceChars) throw new Error("PDF 文字超过 400,000 字符，请减少页码范围。没有截断或发送正文。");
      const block = { label: `p.${pages[i]}`, text };
      if (visual) {
        const size = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(size.width, size.height)) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const task = page.render({ canvasContext: canvas.getContext("2d"), viewport, background: "rgb(255,255,255)" });
        const stopRender = () => task.cancel();
        signal?.addEventListener("abort", stopRender, { once: true });
        try { await task.promise; } finally { signal?.removeEventListener("abort", stopRender); }
        block.image = canvas.toDataURL("image/jpeg", 0.86);
        imageBytes += block.image.length;
        canvas.width = 0; canvas.height = 0;
        if (imageBytes > LIMITS.imageBytes) throw new Error("PDF 页面图片超过 24 MB，请减少页码范围。没有发送任何内容。");
      }
      blocks.push(block);
      page.cleanup();
    }
    const warnings = [];
    if (visual) warnings.push("图文模式会发送所选页的图片。细小文字、复杂表格与公式仍需核对原文。");
    else warnings.push("文字模式不读取图像，图表、公式和双栏阅读顺序可能存在遗漏；需要时改用图文模式。");
    if (weakPages.length) warnings.push(`第 ${weakPages.join("、")} 页文字稀少${visual ? "，已附页面图片" : "，可能为扫描页；建议使用图文模式"}。`);
    if (pages.length < pdf.numPages) warnings.push(`仅选择 ${pages.length}/${pdf.numPages} 页，不能据此声称覆盖全文。`);
    const source = {
      id: crypto.randomUUID(), kind: "pdf", title: metadata.info?.Title?.trim() || title, url,
      metadata: { authors: metadata.info?.Author ? [metadata.info.Author] : [], journal: "", doi: "" },
      capturedAt: new Date().toISOString(), blocks, warnings, pageCount: pdf.numPages,
      scope: `PDF 物理页码 ${pages.join(",")}（已选 ${pages.length} / 共 ${pdf.numPages} 页）；${visual ? "文字及页面图片" : "仅文字层"}`,
    };
    validateSource(source);
    return source;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("已停止读取。", "AbortError");
    if (error.name === "PasswordException") throw new Error("PDF 有密码保护，请解锁后再导入。");
    if (error.name === "InvalidPDFException") throw new Error("PDF 文件无效或损坏，请重新下载。");
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await loading.destroy().catch(() => {});
  }
}
