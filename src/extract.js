import { Readability } from "@mozilla/readability";
import { normalizeText, safeHttpUrl } from "./core/source.js";

const DROP = "script,style,noscript,nav,footer,header[role=banner],aside,form,dialog,button,input,textarea,select,[hidden],[aria-hidden=true],.cookie-banner,.cookie-consent";

function meta(doc, names) {
  for (const name of names) {
    const value = doc.querySelector(`meta[name="${name}"],meta[property="${name}"]`)?.getAttribute("content");
    if (value?.trim()) return value.trim();
  }
  return "";
}

function textOf(node) {
  return normalizeText(node.textContent);
}

export function readableBlocks(root) {
  const blocks = [];
  function walk(node) {
    if (node.nodeType === 3) {
      const text = normalizeText(node.textContent);
      if (text) blocks.push(text);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.tagName === "TABLE") {
      const rows = [...node.querySelectorAll("tr")].map(row =>
        [...row.querySelectorAll("th,td")].map(textOf).join(" | ")
      ).filter(Boolean);
      if (rows.length) blocks.push(rows.join("\n"));
      return;
    }
    if (/^(H[1-6]|P|PRE|FIGCAPTION|BLOCKQUOTE)$/.test(node.tagName) ||
        (node.tagName === "LI" && !node.querySelector("li,p,table"))) {
      const text = textOf(node);
      if (text) blocks.push(text);
      return;
    }
    for (const child of node.childNodes) walk(child);
  }
  walk(root);
  return blocks.map((text, i) => ({ label: `§${i + 1}`, text }));
}

export function extractDocument(doc, { selectionOnly = false } = {}) {
  const url = doc.location?.href || doc.URL;
  const title = meta(doc, ["citation_title", "dc.title", "og:title"]) || doc.title || "未命名文献";
  const metadata = {
    articleType: meta(doc, ["citation_article_type", "citation_type", "dc.type", "DC.Type", "prism.genre"]),
    journal: meta(doc, ["citation_journal_title", "prism.publicationName"]),
    doi: meta(doc, ["citation_doi", "dc.identifier", "DC.Identifier"]),
    date: meta(doc, ["citation_publication_date", "citation_date", "dc.date"]),
    authors: [...doc.querySelectorAll('meta[name="citation_author"]')].map(e => e.content).slice(0, 100),
  };
  const pdfCandidates = new Set();
  const addPdf = value => {
    try { const candidate = safeHttpUrl(new URL(value, url).href); if (candidate) pdfCandidates.add(candidate); } catch {}
  };
  const citationPdf = meta(doc, ["citation_pdf_url"]);
  if (citationPdf) addPdf(citationPdf);
  for (const el of doc.querySelectorAll('a[href],embed[type="application/pdf"],object[type="application/pdf"],iframe[src]')) {
    const ref = el.getAttribute("href") || el.getAttribute("src") || el.getAttribute("data");
    if (ref && (/\.pdf(?:$|[?#])/i.test(ref) || /\/pdf\//i.test(ref) || el.type === "application/pdf")) addPdf(ref);
  }
  const base = {
    title, url, metadata, kind: "web", capturedAt: new Date().toISOString(),
    pdfCandidates: [...pdfCandidates].slice(0, 8), warnings: [],
  };
  if (selectionOnly) {
    const selection = normalizeText(doc.defaultView.getSelection()?.toString());
    if (!selection) throw new Error("请先在网页中选中文字，再点击“读取选中内容”。");
    return {
      ...base, blocks: selection.split(/\n\s*\n/).map((text, i) => ({ label: `§${i + 1}`, text })),
      scope: "仅选中文字，不代表全文", warnings: ["当前材料仅为选中的文字；没有读取全文或图像。"],
    };
  }
  const clone = doc.cloneNode(true);
  clone.querySelectorAll(DROP).forEach(n => n.remove());
  clone.querySelectorAll('[style*="display: none"],[style*="display:none"]').forEach(n => n.remove());
  let article;
  try { article = new Readability(clone.cloneNode(true), { charThreshold: 120, keepClasses: false, serializer: element => element }).parse(); } catch {}
  let root, fallback = false;
  if (article?.content && article.textContent?.trim().length > 150) {
    root = article.content; // Readability returns a detached element; no HTML insertion.
  } else {
    root = clone.querySelector("article") || clone.querySelector("main") || clone.body;
    fallback = true;
  }
  const blocks = root ? readableBlocks(root) : [];
  const chars = blocks.reduce((n, b) => n + b.text.length, 0);
  const warnings = ["网页仅提取可访问的正文与图注，未读取图片；请检查预览是否包含全文。"];
  if (fallback) warnings.push("使用通用正文提取，可能包含导航或遗漏内容，请核对预览。");
  if (chars < 3500) warnings.push("内容较短，可能只是摘要或付费墙前的片段。可选择“读取全文 PDF”或导入文件。");
  return { ...base, blocks, scope: "当前网页可访问的文字；是否为全文尚未核实", warnings };
}

export function capture(options) {
  return extractDocument(document, options);
}
