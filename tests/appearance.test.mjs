import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { normalizeAppearance, bookIcon, PALETTES, iconPath } from "../src/core/appearance.js";
import { registerStaticUI, setLanguage, translate, uiText } from "../src/i18n.js";
import { EN } from "../src/locales/en.js";

test("invalid or legacy appearance settings normalize to safe defaults", () => {
  for (const input of [undefined, null, {}, { theme: "broken", accent: "../../secret", language: "xx" }]) {
    assert.deepEqual(normalizeAppearance(input), { language: "zh-CN", theme: "browser", accent: "blue" });
  }
  for (const theme of ["browser", "light", "dark"]) assert.equal(normalizeAppearance({ theme }).theme, theme);
  assert.equal(iconPath("../../../"), "icons/book-blue.svg");
  for (const [color, palette] of Object.entries(PALETTES)) {
    assert.ok(bookIcon(color).includes(`fill="${palette.background}"`));
    assert.ok(bookIcon(color).includes(`stroke="${palette.ink}"`));
  }
});

test("every initial Chinese interface message has an English translation", async () => {
  const document = new JSDOM(await readFile(new URL("../extension/sidebar.html", import.meta.url), "utf8")).window.document;
  const walker = document.createTreeWalker(document, 4);
  const missing = [];
  while (walker.nextNode()) {
    const node = walker.currentNode, source = node.data.trim();
    if (!node.parentElement?.closest("script,style,textarea") && /\p{Script=Han}/u.test(source) && !Object.hasOwn(EN, source)) missing.push(source);
  }
  for (const el of document.querySelectorAll("*")) for (const attr of ["title", "placeholder", "aria-label"]) {
    const value = el.getAttribute(attr);
    if (value && /\p{Script=Han}/u.test(value) && !Object.hasOwn(EN, value)) missing.push(value);
  }
  assert.deepEqual(missing, []);
});

test("language changes translate interface and dynamic errors without touching user text", () => {
  const document = new JSDOM('<title>XPaper-Read</title><button>设置</button><textarea>设置</textarea><div id="status"></div><div id="user">论文原文</div>').window.document;
  setLanguage("zh-CN", document); registerStaticUI(document);
  const status = document.getElementById("status");
  uiText(status, "API Key 无效或已失效，请在设置中更新。");
  setLanguage("en", document);
  assert.equal(document.querySelector("button").textContent, "Settings");
  assert.match(status.textContent, /Invalid or expired/);
  assert.equal(document.querySelector("textarea").value, "设置");
  assert.equal(document.getElementById("user").textContent, "论文原文");
  assert.equal(translate("正文超过 400,000 字符，请缩小 PDF 页码范围或粘贴需要的章节。未截断正文。"), "Text exceeds 400,000 characters. Select fewer pages or paste the relevant sections. Nothing was truncated.");
  assert.match(translate("发送至 host · 模型名 · 1,234 字符 + 2 页图片。分段阅读，预计 3 次请求，按 API 用量计费。"), /Send to host · 模型名 · 1,234 characters \+ 2 page images\. Chunked reading, estimated 3 requests/);
  setLanguage("zh-CN", document);
  assert.equal(status.textContent, "API Key 无效或已失效，请在设置中更新。");
});
