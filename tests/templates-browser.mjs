import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer, root } from "./support.mjs";

const server = await startServer();
let executablePath = process.env.CHROMIUM_BINARY;
if (!executablePath && !existsSync(chromium.executablePath()) && process.env.LOCALAPPDATA) {
  for (const folder of await readdir(join(process.env.LOCALAPPDATA, "ms-playwright")).catch(() => [])) {
    const path = join(process.env.LOCALAPPDATA, "ms-playwright", folder, "chrome-win64", "chrome.exe");
    if (folder.startsWith("chromium-") && existsSync(path)) executablePath = path;
  }
}
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({ viewport: { width: 410, height: 1000 } });
const errors = [], checks = [];
const check = message => { checks.push(message); console.log(`PASS: ${message}`); };
const bridge = await readFile(join(root, "dist/deepseek.js"), "utf8");
await context.addInitScript(({ origin }) => {
  const local = JSON.parse(sessionStorage.getItem("template-test-local") || '{"settings":{"template":"LEGACY_ARTICLE_CUSTOM"}}');
  const session = JSON.parse(sessionStorage.getItem("template-test-session") || "{}");
  const storage = (data, key) => ({
    get: async keys => keys == null ? structuredClone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])])),
    set: async values => { Object.assign(data, values); sessionStorage.setItem(key, JSON.stringify(data)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; sessionStorage.setItem(key, JSON.stringify(data)); },
  });
  const tab = { id: 1, windowId: 1, title: "Hearing: a systematic review", url: "https://papers.example/review42" }, updates = [];
  globalThis.browser = {
    runtime: { getURL: path => origin + (path.startsWith("/") ? path : `/${path}`) },
    permissions: { contains: async () => true, request: async () => true },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: { query: async () => [tab], onActivated: { addListener() {} }, onUpdated: { addListener: fn => updates.push(fn) } },
    storage: { local: storage(local, "template-test-local"), session: storage(session, "template-test-session") },
    changePaper: (title, url = tab.url) => { tab.title = title; tab.url = url; updates.forEach(fn => fn(1, { title, url })); },
  };
}, { origin: server.origin });
await context.route("https://chat.deepseek.com/**", route => {
  if (new URL(route.request().url()).pathname === "/_fixture_bridge.js") return route.fulfill({ contentType: "application/javascript", body: bridge });
  return route.fulfill({ contentType: "text/html", body: '<!doctype html><script defer src="/_fixture_bridge.js"></script><textarea id="chat-input" placeholder="Message DeepSeek"></textarea><button id="send" onclick="document.getElementById(\'sent\').textContent=\'1\'">Send</button><span id="sent">0</span>' });
});
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
const stored = () => page.evaluate(() => browser.storage.local.get(null));
const editor = page.locator("#template-text");
async function saveTemplate() {
  await page.locator("#save-template").click();
  await page.waitForFunction(() => document.getElementById("toast").textContent.includes("模板已保存"));
}
async function paste(title, text) {
  await page.locator("#show-paste").click();
  await page.locator("#paste-title").fill(title);
  await page.locator("#paste-text").fill(text.repeat(20));
  await page.locator("#use-paste").click();
  await page.locator("#source-title").filter({ hasText: title }).waitFor();
}
try {
  await page.goto(`${server.origin}/sidebar.html`);
  await page.waitForFunction(() => !document.getElementById("web-fill").disabled);
  assert.match(await page.locator("#web-type-status").textContent(), /自动初判：Review/);
  assert.doesNotMatch(await page.locator("#web-prompt").inputValue(), /LEGACY_ARTICLE_CUSTOM/);
  await page.locator("#web-edit-template").click();
  assert.equal(await page.locator("#template-choice-review").getAttribute("aria-checked"), "true");
  assert.match(await editor.inputValue(), /综述知识结构与证据关系图/);
  await page.locator("#template-choice-article").click();
  assert.deepEqual(errors, []);
  assert.equal(await page.locator("#template-choice-article").getAttribute("aria-checked"), "true");
  assert.equal(await editor.inputValue(), "LEGACY_ARTICLE_CUSTOM");
  check("Legacy Article custom template survives upgrade; detected Review opens its own default editor");

  await editor.click(); await editor.fill("ARTICLE_SAVED_CUSTOM");
  await page.locator("#template-choice-review").click();
  await editor.click(); await editor.fill("REVIEW_SAVED_CUSTOM"); await saveTemplate();
  assert.equal((await stored()).settings.template, "LEGACY_ARTICLE_CUSTOM");
  assert.equal((await stored()).settings.reviewTemplate, "REVIEW_SAVED_CUSTOM");
  assert.equal((await stored()).apiKey, undefined);
  await page.locator("#template-choice-article").click();
  assert.equal(await editor.inputValue(), "ARTICLE_SAVED_CUSTOM");
  await saveTemplate();
  await page.locator("#template-choice-review").click();
  await page.locator("#reset-template").click();
  assert.match(await editor.inputValue(), /综述知识结构/);
  assert.equal((await stored()).settings.reviewTemplate, "REVIEW_SAVED_CUSTOM");
  await page.locator("#template-choice-review").press("ArrowLeft");
  assert.equal(await editor.inputValue(), "ARTICLE_SAVED_CUSTOM");
  await page.locator("#template-choice-article").press("ArrowRight");
  assert.match(await editor.inputValue(), /综述知识结构/);
  check("Templates keep independent drafts, save separately without a key, and reset only the active draft");

  await page.locator("#tab-web").click();
  const frame = page.frameLocator("#web-frame");
  const chat = await (await page.locator("#web-frame").elementHandle()).contentFrame();
  await page.locator("#web-fill").click();
  await chat.waitForFunction(() => document.getElementById("chat-input").value.includes("REVIEW_SAVED_CUSTOM"));
  assert.match(await frame.locator("#chat-input").inputValue(), /REVIEW_SAVED_CUSTOM/);
  assert.doesNotMatch(await frame.locator("#chat-input").inputValue(), /ARTICLE_SAVED_CUSTOM/);
  await page.locator("#web-prompt-options").evaluate(el => { el.open = true; });
  await page.locator("#web-paper-type").selectOption("article");
  assert.match(await page.locator("#web-type-status").textContent(), /手动：Article/);
  await frame.locator("#chat-input").fill("");
  await page.locator("#web-fill").click();
  await chat.waitForFunction(() => document.getElementById("chat-input").value.includes("ARTICLE_SAVED_CUSTOM"));
  assert.match(await frame.locator("#chat-input").inputValue(), /ARTICLE_SAVED_CUSTOM/);
  assert.doesNotMatch(await frame.locator("#chat-input").inputValue(), /REVIEW_SAVED_CUSTOM/);
  assert.equal(await frame.locator("#sent").textContent(), "0");
  assert.equal(server.requests.length, 0);
  check("Web fill uses the saved matching template, honors manual override and never sends or calls a paid API");

  await page.evaluate(() => browser.changePaper("Unclear paper", "https://papers.example/unknown"));
  await page.waitForFunction(() => document.getElementById("web-paper-type").value === "auto");
  assert.match(await page.locator("#web-prompt").inputValue(), /ARTICLE_SAVED_CUSTOM/);
  assert.match(await page.locator("#web-prompt").inputValue(), /REVIEW_SAVED_CUSTOM/);
  assert.match(await page.locator("#web-type-status").textContent(), /类型待确认/);
  await page.evaluate(() => browser.changePaper("New title: a scoping review"));
  await page.waitForFunction(() => document.getElementById("web-type-status").textContent.includes("自动初判：Review"));
  check("Unknown sources defer to material-based model classification; title updates re-detect and new papers reset overrides");

  await page.locator("#tab-settings").click(); await page.locator("#settings-tab-api").click();
  await page.locator("#api-key").fill("test-only-key"); await page.locator("#endpoint").fill(server.origin);
  await page.locator("#save-settings").click();
  await page.waitForFunction(() => document.getElementById("toast").textContent === "设置已保存。");
  await page.locator("#tab-read").click();
  await paste("Plasticity: a review", "In this review, we synthesize evidence on plasticity. ");
  assert.match(await page.locator("#read-type-status").textContent(), /自动初判：Review/);
  assert.match(await page.locator("#reading-framework").textContent(), /主题证据/);
  assert.equal(server.requests.length, 0);
  await page.locator("#edit-template").click();
  assert.equal(await page.locator("#template-choice-review").getAttribute("aria-checked"), "true");
  await page.locator("#tab-read").click(); await page.locator("#summarize").click();
  await page.locator("#result-status").filter({ hasText: "已完成" }).waitFor();
  assert.equal(server.requests.length, 1);
  assert.match(server.requests[0].body.messages[1].content, /REVIEW_SAVED_CUSTOM/);
  assert.doesNotMatch(server.requests[0].body.messages[1].content, /ARTICLE_SAVED_CUSTOM/);
  await page.waitForFunction(async () => Object.keys(await browser.storage.local.get(null)).some(key => key.startsWith("reading:")));
  const record = Object.entries(await stored()).find(([key]) => key.startsWith("reading:"))[1];
  assert.equal(record.readingPlan.type, "review");
  assert.match(record.template, /REVIEW_SAVED_CUSTOM/);
  check("API Review reading uses its saved template in a single request and persists the selected plan with the note");

  await page.locator("#read-paper-type").selectOption("review");
  await paste("A randomized controlled trial", "We randomized participants to two treatment groups. ");
  assert.equal(await page.locator("#read-paper-type").inputValue(), "auto");
  assert.match(await page.locator("#read-type-status").textContent(), /自动初判：Article/);
  await page.locator("#summarize").click();
  await page.locator("#result-status").filter({ hasText: "已完成" }).waitFor();
  assert.equal(server.requests.length, 2);
  assert.match(server.requests[1].body.messages[1].content, /ARTICLE_SAVED_CUSTOM/);
  assert.doesNotMatch(server.requests[1].body.messages[1].content, /REVIEW_SAVED_CUSTOM/);
  check("Loading the next API paper resets type overrides and selects the Article template");

  await page.reload();
  await page.locator("#tab-settings").click(); await page.locator("#settings-tab-template").click();
  assert.equal(await editor.inputValue(), "ARTICLE_SAVED_CUSTOM");
  await page.locator("#template-choice-review").click();
  assert.equal(await editor.inputValue(), "REVIEW_SAVED_CUSTOM");
  await page.locator("#reset-template").click();
  await mkdir(join(root, "artifacts/qa"), { recursive: true });
  await page.screenshot({ path: join(root, "artifacts/qa/review-template.png") });
  await page.locator("#settings-tab-appearance").click(); await page.locator('[data-language-choice="en"]').click();
  await page.setViewportSize({ width: 280, height: 800 }); await page.locator("#settings-tab-template").click();
  assert.equal(await page.locator("#template-editor-label").textContent(), "Review reading template");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.locator(".template-choices button").evaluateAll(buttons => buttons.every(b => b.scrollWidth <= b.clientWidth)));
  assert.ok(Math.abs((await page.locator("#settings-template").boundingBox()).width - 252) < 1);
  check("Both saved templates survive reload; English Review controls fit a 280px sidebar within the 90% setting width");
  assert.deepEqual(errors, []);
  await writeFile(join(root, "artifacts/qa/templates-report.json"), JSON.stringify({ version: "1.0.5", checks, errors, requests: server.requests.length, note: "Synthetic material and local API/chat fixtures only. Model judgment and diagram rendering quality are not evaluated." }, null, 2));
} catch (error) {
  console.error(await page.evaluate(() => ({ status: document.getElementById("web-status").textContent, toast: document.getElementById("toast").textContent, errors: document.getElementById("error").textContent, editor: document.getElementById("template-editor-label").textContent })));
  await page.screenshot({ path: join(root, "artifacts/qa/templates-failure.png") });
  throw error;
} finally { await browser.close(); await server.close(); }
