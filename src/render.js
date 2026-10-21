import { marked } from "marked";
import DOMPurify from "dompurify";
import { safeHttpUrl } from "./core/source.js";

export function renderMarkdown(container, markdown) {
  const html = marked.parse(markdown, { breaks: true, gfm: true });
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "blockquote", "ul", "ol", "li", "hr", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "a", "sup", "sub"],
    ALLOWED_ATTR: ["href", "title", "start"],
  });
  for (const a of fragment.querySelectorAll("a")) {
    const href = safeHttpUrl(a.getAttribute("href"));
    if (href) { a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.referrerPolicy = "no-referrer"; }
    else a.removeAttribute("href");
  }
  container.replaceChildren(fragment);
}

export function exportMarkdown(record) {
  return `# ${record.source.title}

- 来源：${record.source.url || "本地文件 / 手动粘贴"}
- 材料范围：${record.source.scope}
- 模型：${record.model}
- 生成时间：${record.createdAt}
- 状态：${record.status === "imported" ? "网页版回答，已手动导入" : record.status === "complete" ? "已完成" : "未完成 / 部分结果"}
- 阅读方式：${record.method || "处理中"}
${record.source.warnings.map(w => `- 提取提示：${w}`).join("\n")}

---

${record.content}

---

> AI 辅助阅读笔记，数值、图表定位及推断需要回查原文。
`;
}
