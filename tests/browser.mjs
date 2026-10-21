import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer, root, testTitle, testText } from "./support.mjs";

const server = await startServer();
let executablePath = process.env.CHROMIUM_BINARY;
if (!executablePath && !existsSync(chromium.executablePath()) && process.env.LOCALAPPDATA) {
  const cache = join(process.env.LOCALAPPDATA, "ms-playwright");
  for (const folder of await readdir(cache).catch(() => [])) {
    const path = join(cache, folder, "chrome-win64", "chrome.exe");
    if (folder.startsWith("chromium-") && existsSync(path)) executablePath = path;
  }
}
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, acceptDownloads: true });
const errors = [], failedRequests = [];
await context.addInitScript(({ origin, title }) => {
  const local = JSON.parse(sessionStorage.getItem("test-local") || "{}"), session = {};
  function storage(data, persist = false) {
    return {
      get: async keys => {
        if (keys === null) return { ...data };
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, data[k]]));
      },
      set: async values => { Object.assign(data, values); if (persist) sessionStorage.setItem("test-local", JSON.stringify(data)); },
      remove: async keys => { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; if (persist) sessionStorage.setItem("test-local", JSON.stringify(data)); },
    };
  }
  globalThis.browser = {
    runtime: { getURL: path => origin + (path.startsWith("/") ? path : `/${path}`) },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: {
      query: async () => [{ id: 1, windowId: 1, title, url: origin + "/fixture/article" }],
      onActivated: { addListener() {} }, onUpdated: { addListener() {} },
    },
    permissions: { request: async () => true, contains: async () => false },
    storage: { local: storage(local, true), session: storage(session) },
  };
}, { origin: server.origin, title: testTitle });
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
page.on("requestfailed", req => { if (!req.failure()?.errorText.includes("ABORTED")) failedRequests.push(req.url()); });
try {
  await page.goto(`${server.origin}/sidebar.html`);
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  assert.match(await page.locator("#template-text").inputValue(), /核心结果逐个推进/);
  await page.locator('[data-settings-section="settings-api"]').click();
  await page.locator("#api-key").fill("test-only-key");
  await page.locator("#endpoint").fill(server.origin);
  await page.locator("#test-api").click();
  await page.locator("#connection-status").filter({ hasText: "连接成功" }).waitFor();
  await page.locator("#save-settings").click();
  const stored = await page.evaluate(() => browser.storage.local.get(null));
  assert.equal(stored.apiKey, undefined, "key should default to session-only");
  await page.getByRole("tab", { name: "API 精读", exact: true }).click();
  await page.locator("#show-paste").click();
  await page.locator("#paste-title").fill(testTitle);
  await page.locator("#paste-text").fill(testText);
  await page.locator("#use-paste").click();
  await page.locator("#source-title").filter({ hasText: testTitle }).waitFor();
  assert.equal(server.requests.length, 0, "extraction should never call the model");
  await page.locator("#summarize").click();
  await page.locator("#result-status").filter({ hasText: "已完成" }).waitFor();
  assert.match(await page.locator("#result").innerText(), /为什么能发表到该期刊/);
  assert.equal(await page.locator("#result img, #result script, #result [onerror]").count(), 0);
  assert.equal(await page.evaluate(() => window.XSS), undefined);
  assert.ok(!server.requests[0].cookie);
  assert.equal(server.requests[0].auth, "Bearer test-only-key");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-result").click();
  const download = await downloadPromise;
  await mkdir(join(root, "artifacts", "qa"), { recursive: true });
  await download.saveAs(join(root, "artifacts", "qa", "export-test.md"));
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.locator(".read-scroll").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: join(root, "artifacts", "qa", "sidebar-reading.png"), fullPage: true });
  await page.setViewportSize({ width: 300, height: 950 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "300px sidebar must not overflow horizontally");
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByRole("tab", { name: "笔记", exact: true }).click();
  await page.locator(".history-item").first().waitFor();
  await page.locator(".history-item").first().click();
  // Real PDF.js, worker, local fonts, selectable range, and image rendering.
  await page.locator("#pdf-file").setInputFiles(server.pdf.textPath);
  await page.locator("#source-kind").filter({ hasText: "PDF · 文字" }).waitFor();
  assert.match(await page.locator("#source-text").textContent(), /\[p\.2\]/);
  await page.locator("#source-preview").evaluate(el => { el.open = true; });
  await page.locator(".pdf-options").evaluate(el => { el.open = true; });
  await page.locator("#pdf-mode").selectOption("visual");
  await page.locator("#page-range").fill("2");
  await page.locator("#pdf-file").setInputFiles(server.pdf.textPath);
  await page.locator("#source-kind").filter({ hasText: "图文" }).waitFor();
  assert.match(await page.locator("#source-scope").textContent(), /已选 1 \/ 共 2/);
  await page.locator("#summarize").click();
  await page.locator("#result-status").filter({ hasText: "已完成" }).waitFor();
  assert.equal(server.requests.at(-1).body.messages[2].content.filter(x => x.type === "image_url").length, 1);
  await page.locator("#source-preview").evaluate(el => { el.open = true; });
  await page.screenshot({ path: join(root, "artifacts", "qa", "sidebar-pdf.png"), fullPage: true });
  await page.locator("#page-range").fill("");
  await page.locator("#pdf-mode").selectOption("text");
  await page.locator("#pdf-file").setInputFiles(server.pdf.scanPath);
  await page.locator("#error").filter({ hasText: "文字过少" }).waitFor();
  assert.ok(await page.locator("#summarize").isDisabled(), "failed extraction must not send the previously loaded paper");
  await page.locator("#pdf-mode").selectOption("visual");
  await page.locator("#pdf-file").setInputFiles(server.pdf.scanPath);
  await page.locator("#source-title").filter({ hasText: "scan.pdf" }).waitFor();
  assert.match(await page.locator("#source-count").textContent(), /1 张图/);
  // A stopped request must remain partial, never "complete".
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.locator("#model").fill("test-slow");
  await page.locator("#save-settings").click();
  await page.getByRole("tab", { name: "API 精读", exact: true }).click();
  await page.locator("#summarize").click();
  await page.locator("#result h2").first().waitFor();
  await page.locator("#stop").click();
  await page.locator("#result-status").filter({ hasText: "部分结果" }).waitFor();
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.locator("#model").fill("test-401");
  await page.locator("#save-settings").click();
  await page.getByRole("tab", { name: "API 精读", exact: true }).click();
  await page.locator("#summarize").click();
  await page.locator("#error").filter({ hasText: "Key 无效" }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
  await writeFile(join(root, "artifacts", "qa", "browser-report.json"), JSON.stringify({
    browser: await browser.version(), checks: ["template", "session key", "no send on extract", "SSE", "XSS removal", "export", "300px layout", "history", "PDF text", "PDF range", "PDF images", "scan fallback", "cancel", "HTTP 401"],
    requests: server.requests.length, errors, note: "Synthetic documents and local mocked model API. No live DeepSeek calls.",
  }, null, 2));
  console.log("PASS: 14 browser flows, real PDF.js parsing/rendering, local mock API; no browser errors.");
} finally { await browser.close(); await server.close(); }
