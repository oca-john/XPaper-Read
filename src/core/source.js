import { LIMITS } from "./defaults.js";

export function normalizeText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export function publicSourceUrl(value) {
  const safe = safeHttpUrl(value);
  if (!safe) return "";
  const url = new URL(safe);
  // PDF download URLs can contain temporary access tokens. Never send the query.
  url.search = "";
  url.hash = "";
  return url.href;
}

export function permissionOrigin(value) {
  const url = new URL(value);
  if (!safeHttpUrl(value)) throw new Error("此地址不能直接读取。请导入 PDF 或粘贴正文。");
  // WebExtension match patterns do not include ports.
  return `${url.protocol}//${url.hostname}/*`;
}

export function looksLikePdf(value) {
  try {
    const u = new URL(value);
    return /\.pdf(?:$|\/)/i.test(u.pathname) || /\/pdf(?:\/|$)/i.test(u.pathname) ||
      /(?:^|[?&])(?:format|type)=pdf(?:&|$)/i.test(u.search);
  } catch { return false; }
}

export function sourceText(source) {
  return source.blocks.map(b => `[${b.label}]\n${b.text || (b.image ? "（该页以图片提供）" : "（未提取到文字）")}`).join("\n\n");
}

export function sourceStats(source) {
  return {
    chars: source.blocks.reduce((n, b) => n + (b.text?.length || 0), 0),
    images: source.blocks.filter(b => b.image).length,
    blocks: source.blocks.length,
  };
}

export function validateSource(source) {
  if (!source?.blocks?.length) throw new Error("没有可发送的文献内容，请先读取网页、导入 PDF 或粘贴正文。");
  const stats = sourceStats(source);
  if (stats.chars < 80 && stats.images === 0) throw new Error("提取到的文字过少。请导入全文 PDF；扫描件可选择图文模式。");
  if (stats.chars > LIMITS.sourceChars) throw new Error(`正文超过 ${LIMITS.sourceChars.toLocaleString()} 字符，请缩小 PDF 页码范围或粘贴需要的章节。未截断正文。`);
  if (stats.images > LIMITS.visualPages) throw new Error(`图文模式最多处理 ${LIMITS.visualPages} 页，请缩小页码范围。`);
  if (source.blocks.reduce((n, b) => n + (b.image?.length || 0), 0) > LIMITS.imageBytes) {
    throw new Error("图片体积过大，请减少页码后重试。未发送任何内容。");
  }
  return stats;
}

export function parsePageRange(input, totalPages) {
  if (!input?.trim() || input.trim() === "全部") return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = new Set();
  for (const raw of input.replace(/，/g, ",").split(",")) {
    const match = raw.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!match) throw new Error("页码格式应为 1-8,12；留空表示全部页。");
    const start = Number(match[1]), end = Number(match[2] || match[1]);
    if (start < 1 || end < start || end > totalPages) throw new Error(`页码超出范围：该 PDF 共 ${totalPages} 页。`);
    for (let p = start; p <= end; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

export function splitBlocks(blocks, maxChars = LIMITS.chunkChars, maxImages = LIMITS.imagesPerChunk) {
  const chunks = [];
  let current = [], chars = 0, images = 0;
  const flush = () => { if (current.length) chunks.push(current); current = []; chars = 0; images = 0; };
  for (const block of blocks) {
    // Split very long paragraphs without dropping the tail or duplicating images.
    const text = block.text || "";
    const parts = [];
    for (let i = 0; i < text.length; i += maxChars) parts.push(text.slice(i, i + maxChars));
    if (!parts.length) parts.push("");
    for (let i = 0; i < parts.length; i++) {
      const image = i === 0 ? block.image : undefined;
      const part = { ...block, text: parts[i], image };
      if (chars + part.text.length > maxChars || images + Number(!!image) > maxImages) flush();
      current.push(part); chars += part.text.length; images += Number(!!image);
    }
  }
  flush();
  return chunks;
}

export function planReading(source) {
  const stats = validateSource(source);
  const direct = stats.chars <= LIMITS.directChars && stats.images <= LIMITS.imagesPerChunk;
  const chunks = direct ? [source.blocks] : splitBlocks(source.blocks);
  // Each group of <= 4 map notes is reduced before final synthesis if needed.
  let groups = chunks.length, reductions = 0;
  if (!direct) while (groups > 4) { groups = Math.ceil(groups / 4); reductions += groups; }
  return { direct, chunks, calls: direct ? 1 : chunks.length + reductions + 1, ...stats };
}

export function sourceMeta(source) {
  return {
    title: source.title, url: publicSourceUrl(source.url), kind: source.kind,
    metadata: source.metadata || {}, scope: source.scope || "",
    warnings: source.warnings || [], capturedAt: source.capturedAt,
    stats: sourceStats(source),
  };
}

export function makeManualSource(text, title = "手动粘贴的文献") {
  const blocks = normalizeText(text).split(/\n\s*\n/).filter(Boolean).map((text, i) => ({ label: `§${i + 1}`, text }));
  const source = {
    id: crypto.randomUUID(), title: title.trim() || "手动粘贴的文献", kind: "manual",
    url: "", blocks, capturedAt: new Date().toISOString(), metadata: {},
    scope: "用户粘贴的文字；完整性由用户核对",
    warnings: ["仅含粘贴的文字，不包含原文图片；请核对是否包含全文。"],
  };
  validateSource(source);
  return source;
}
