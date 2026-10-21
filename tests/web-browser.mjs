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
const context = await browser.newContext({ viewport: { width: 410, height: 1100 } });
const errors = [], checks = [], layouts = [], chromeLayouts = [];
let blankFixture = false;
const check = label => { checks.push(label); console.log(`PASS: ${label}`); };
const bridge = await readFile(join(root, "dist", "deepseek.js"), "utf8");
await context.addInitScript(({ origin }) => {
  const local = {}, session = {};
  const storage = data => ({
    get: async keys => keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, data[k]])),
    set: async values => Object.assign(data, values),
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const tab = { id: 1, windowId: 1, title: "示例论文 · 设计如何形成证据", url: "https://papers.example/article?id=42&token=private&utm_source=reader" };
  const updates = [];
  globalThis.browser = {
    runtime: { getURL: path => origin + (path.startsWith("/") ? path : `/${path}`) },
    permissions: { contains: async () => true, request: async () => true },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: {
      query: async () => [tab], create: async options => { globalThis.openedTabs.push(options); return { id: 2, ...options }; },
      onActivated: { addListener() {} }, onUpdated: { addListener: fn => updates.push(fn) },
    },
    storage: { local: storage(local), session: storage(session) },
    changePaper: () => { tab.url = "https://papers.example/second"; tab.title = "另一篇论文"; updates.forEach(fn => fn(1, { url: tab.url })); },
  };
  globalThis.openedTabs = [];
}, { origin: server.origin });
await context.route("https://chat.deepseek.com/**", async route => {
  if (new URL(route.request().url()).pathname === "/_fixture_bridge.js") {
    return route.fulfill({ contentType: "application/javascript", body: bridge });
  }
  if (blankFixture) {
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><script defer src="/_fixture_bridge.js"></script></head><body></body></html>' });
  }
  await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
    body{font-family:system-ui,sans-serif;margin:0;background:#fff;color:#30333b;padding:18px}
    h1{font-size:16px;margin:0 0 18px}small{color:#777}textarea{box-sizing:border-box;width:100%;height:150px;border:1px solid #dce0e8;border-radius:15px;padding:12px;resize:none}
    button{background:#4d6bfe;border:0;border-radius:8px;padding:8px 18px;color:white}
    #answer{line-height:1.9;font-size:13px;padding:12px 0}footer{margin-top:20px;font-size:11px;color:#777}
    </style><script defer src="/_fixture_bridge.js"></script></head><body>
    <h1>DeepSeek <small>内嵌对话测试页</small></h1>
    <div id="answer" hidden><h2>研究问题与结果逻辑链</h2><p>这是合成回答，仅用于验证侧栏交互。</p><p>问题 → 对照设计 → 实验结果 → 有边界的贡献判断。</p><p>实际阅读范围应由模型如实说明，不能把网址当作已读全文。</p></div>
    <textarea id="chat-input" placeholder="给 DeepSeek 发送消息"></textarea>
    <button id="send">发送</button><span id="sent-count">0</span>
    <footer>本页为本地测试替身，不连接真实聊天服务。</footer>
    <script>let sent=0;document.getElementById("send").onclick=()=>{document.getElementById("sent-count").textContent=++sent;document.getElementById("chat-input").value="";document.getElementById("answer").hidden=false;};</script>
    </body></html>` });
});
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`${server.origin}/sidebar.html`);
  await page.locator("#web-status").filter({ hasText: "网页版已就绪" }).waitFor();
  assert.equal(await page.locator("#tab-web").getAttribute("aria-selected"), "true");
  const frame = page.frameLocator("#web-frame");
  assert.match(await page.locator("#web-prompt").inputValue(), /https:\/\/papers.example\/article\?id=42/);
  assert.doesNotMatch(await page.locator("#web-prompt").inputValue(), /private|utm_source/);
  assert.equal((await page.evaluate(() => browser.storage.local.get(null))).apiKey, undefined);
  check("DeepSeek iframe is the default panel, uses no API key and keeps article identifiers");
  assert.equal(await page.locator(".version > span").last().textContent(), "1.0.5");
  assert.equal(await page.locator(".web-site-bar").count(), 0);
  assert.ok(await page.locator("#web-status").evaluate(el => getComputedStyle(el).clipPath === "inset(50%)"));
  assert.equal(await page.evaluate(() => openedTabs.length), 0);
  await page.locator(".web-mode-note #web-login").click();
  assert.deepEqual(await page.evaluate(() => openedTabs), [{ url: "https://chat.deepseek.com/" }]);
  check("Top login action opens the official site only on click; permanent site/status rows are removed");

  // Cross both old breakpoints and resize back to catch collapsed flex heights.
  for (const width of [520, 300, 410, 519, 780, 1200, 320, 410]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { width: innerWidth, height: innerHeight, main: rect("main"), panel: rect("#panel-web"), frame: rect("#web-frame"), notes: rect(".web-notes"), scrollWidth: document.documentElement.scrollWidth };
    });
    layouts.push(layout);
    assert.ok(Math.abs(layout.panel.y - layout.main.y) < 1, `${width}px: chat panel starts at the top of the available space`);
    assert.ok(Math.abs(layout.panel.height - layout.main.height) < 1, `${width}px: chat panel fills the available height`);
    assert.ok(layout.frame.x < 1 && Math.abs(layout.frame.width - width) < 1, `${width}px: chat fills the sidebar width`);
    assert.ok(layout.frame.height > 450, `${width}px: chat keeps a usable height`);
    assert.ok(Math.abs(layout.frame.bottom - layout.notes.top) < 1, `${width}px: notes sit directly below the chat`);
    assert.ok(layout.notes.bottom <= layout.height + 1 && layout.scrollWidth <= width, `${width}px: controls stay on screen without horizontal scrolling`);
  }
  check("Chat fills width and remaining height across 300–1200 px, including the former 520 px breakpoint");

  // Shared chrome must keep the same geometry when changing modes or scrolling.
  for (const width of [280, 300, 520, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    let baseline;
    for (const name of ["web", "read", "history", "settings"]) {
      await page.locator(`#tab-${name}`).click();
      const measure = () => page.evaluate(name => {
        const panel = document.querySelector(`#panel-${name}`);
        const rect = el => el.getBoundingClientRect().toJSON();
        const footer = panel.querySelector(".panel-footer");
        const badge = document.querySelector(".version");
        return { name, width: innerWidth, height: innerHeight, header: rect(document.querySelector(".app-header")),
          tabs: rect(document.querySelector(".tabs")), brand: rect(document.querySelector(".brand")),
          badge: rect(badge), versionLines: [...badge.children].map(rect), footer: rect(footer),
          buttons: [...footer.querySelectorAll("button")].filter(el => el.getClientRects().length).map(rect),
          toggle: name === "web" ? rect(document.querySelector("#web-focus-toggle")) : null,
          overflow: document.documentElement.scrollWidth > innerWidth || footer.scrollWidth > footer.clientWidth };
      }, name);
      const before = await measure();
      chromeLayouts.push(before);
      baseline ??= before;
      assert.deepEqual(before.header, baseline.header);
      assert.deepEqual(before.tabs, baseline.tabs);
      assert.equal(before.header.height, 40);
      assert.equal(before.tabs.bottom, 72);
      assert.ok(before.versionLines[0].right < before.versionLines[1].left && before.versionLines[0].top === before.versionLines[1].top);
      assert.ok(before.versionLines.every(line => line.left >= before.badge.left && line.right <= before.badge.right), "full version text fits its badge");
      assert.equal(before.badge.height, 20);
      assert.equal(before.footer.height, 25);
      assert.equal(before.footer.bottom, 900);
      assert.equal(before.footer.width, width);
      assert.ok(before.buttons.every(rect => rect.height === 18));
      assert.equal(before.overflow, false);
      if (before.toggle) {
        assert.ok(before.toggle.left > before.brand.right);
        assert.ok(before.toggle.right < before.badge.left);
        assert.ok(before.toggle.right <= width - 88);
        const top = await page.locator(".web-mode-note").evaluate(el => {
          const rect = selector => el.querySelector(selector).getBoundingClientRect().toJSON();
          return { hint: rect(".web-login-hint"), actions: rect(".web-login-actions"), banner: el.getBoundingClientRect().toJSON(),
            frameTop: document.querySelector("#web-frame").getBoundingClientRect().top,
            toolbarBottom: document.querySelector(".web-toolbar").getBoundingClientRect().bottom };
        });
        assert.ok(top.hint.right < top.actions.left && top.actions.right <= width - 10);
        assert.ok(top.actions.top >= top.banner.top && top.actions.bottom <= top.banner.bottom);
        assert.ok(Math.abs(top.frameTop - top.toolbarBottom) < 1, "removed rows leave no gap above the chat");
      }
      await page.locator(`#panel-${name} .panel-scroll`).evaluate(el => { el.scrollTop = el.scrollHeight; });
      const after = await measure();
      assert.deepEqual(after.header, before.header);
      assert.deepEqual(after.footer, before.footer);
      await page.locator(`#panel-${name} .panel-scroll`).evaluate(el => { el.scrollTop = 0; });
    }
    for (const name of ["appearance", "template", "api", "about"]) {
      await page.locator(`#settings-tab-${name}`).click();
      assert.equal(await page.locator('[data-settings-footer]:not([hidden])').count(), 1);
      assert.ok(await page.locator(`[data-settings-footer="settings-${name}"]`).isVisible());
      const tabs = await page.locator(".settings-tab").evaluateAll(els => els.map(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        const text = range.getBoundingClientRect(), button = el.getBoundingClientRect();
        return { centerDelta: Math.abs(text.left + text.width / 2 - button.left - button.width / 2),
          shadow: getComputedStyle(el).boxShadow, active: el.classList.contains("active") };
      }));
      assert.ok(tabs.every(tab => tab.centerDelta < 1));
      assert.ok(tabs.filter(tab => !tab.active).every(tab => tab.shadow.includes("inset")));
      assert.notEqual(tabs.find(tab => tab.active).shadow, tabs.find(tab => !tab.active).shadow);
      await page.locator(".settings-scroll").evaluate(el => { el.scrollTop = el.scrollHeight; });
      const footer = await page.locator("#panel-settings .panel-footer").boundingBox();
      assert.equal(footer.y + footer.height, 900);
      assert.equal(footer.height, 25);
    }
    await page.locator("#settings-tab-template").click();
  }
  await page.locator("#tab-web").click();
  const webNotice = await page.locator(".web-mode-note").evaluate(el => {
    const css = getComputedStyle(el);
    return [css.fontSize, css.lineHeight, css.padding, css.backgroundColor, css.borderRadius];
  });
  await page.locator("#tab-read").click();
  assert.deepEqual(await page.locator("#panel-read .mode-note").evaluate(el => {
    const css = getComputedStyle(el);
    return [css.fontSize, css.lineHeight, css.padding, css.backgroundColor, css.borderRadius];
  }), webNotice);
  await page.locator("#tab-web").click();
  check("Four modes share a 72px header, horizontal Version 1.0.5 badge, 25px fixed footer and compact buttons at 280–1200px");
  check("Settings subtabs center their labels, distinguish inset/raised states and expose the matching fixed footer");

  assert.match(await page.locator(".web-mode-note").textContent(), /登录.*免费/);
  assert.match(await page.locator(".web-notes .footer-hint").textContent(), /^（.*）$/);
  assert.ok(await page.locator("#web-selection").evaluate(el => getComputedStyle(el).borderStyle !== "none"));
  await frame.locator("#chat-input").fill("折叠时保留这份草稿");
  for (const width of [300, 520, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator("#web-focus-toggle").click();
    assert.equal(await page.locator("#web-focus-toggle").getAttribute("aria-expanded"), "false");
    for (const selector of ["#app-header", "#main-tabs", "#web-top"]) assert.ok(await page.locator(selector).isHidden());
    const rect = await page.locator("#web-frame").boundingBox();
    assert.equal(rect.y, 0);
    assert.equal(rect.width, width);
    assert.ok(rect.height > 800);
    const toggle = await page.locator("#web-focus-toggle").boundingBox();
    assert.ok(toggle.x + toggle.width <= width - 88, "focused toggle leaves the official top-right action area clear");
    assert.ok(await page.locator("#web-paste-note").isVisible());
    await page.locator("#web-focus-toggle").click();
    assert.ok(await page.locator("#main-tabs").isVisible());
    assert.equal(await frame.locator("#chat-input").inputValue(), "折叠时保留这份草稿");
  }
  await frame.locator("#chat-input").fill("");
  await page.setViewportSize({ width: 410, height: 900 });
  check("Focus mode hides all extension top controls, expands the chat and preserves drafts at every width");

  await page.locator("#web-fill").click();
  await page.locator("#web-status").filter({ hasText: "已填入网址和模板" }).waitFor();
  assert.match(await frame.locator("#chat-input").inputValue(), /研究解决了什么领域问题/);
  assert.match(await frame.locator("#chat-input").inputValue(), /停止精读/);
  assert.equal(await frame.locator("#sent-count").textContent(), "0");
  assert.equal(server.requests.length, 0);
  check("Cross-origin bridge fills the five-part prompt without sending or calling the API");

  await frame.locator("#chat-input").fill("我的未发送草稿");
  await page.locator("#web-fill").click();
  await page.locator("#web-status").filter({ hasText: "已有草稿" }).waitFor();
  assert.ok(await page.locator("#toast").filter({ hasText: "已有草稿" }).isVisible(), "action errors remain visible after removing the status row");
  assert.equal(await frame.locator("#chat-input").inputValue(), "我的未发送草稿");
  await frame.locator("#chat-input").fill("");
  assert.equal(await page.getByRole("tab", { name: "模板", exact: true }).count(), 0);
  await page.locator("#web-edit-template").click();
  assert.equal(await page.locator("#tab-settings").getAttribute("aria-selected"), "true");
  assert.ok(await page.locator("#panel-settings #template-text").isVisible());
  const editor = page.locator("#template-text");
  const compactHeight = (await editor.boundingBox()).height;
  assert.ok(compactHeight > 205 && compactHeight < 225);
  assert.ok(await editor.evaluate(el => el.readOnly && getComputedStyle(el).overflowY === "hidden" && el.scrollTop === 0));
  await editor.click();
  assert.ok(Math.abs((await editor.boundingBox()).height - compactHeight * 2) < 1);
  assert.ok(await editor.isEditable());
  await editor.press("Control+End");
  assert.ok(await editor.evaluate(el => el.scrollTop > 0));
  await page.locator("#template-text").fill("## 新模板\n逐图解释主要结果，并核对作者的因果主张。");
  await page.locator("#template-heading").click();
  assert.ok(await editor.evaluate(el => el.readOnly && el.scrollTop === 0));
  assert.match(await editor.inputValue(), /逐图解释/);
  assert.match(await page.locator("#template-edit-status").textContent(), /未保存/);
  await editor.click();
  await page.locator("#save-template").click();
  await page.locator("#toast").filter({ hasText: "模板已保存" }).waitFor();
  assert.ok(await editor.evaluate(el => el.readOnly && el.scrollTop === 0));
  assert.ok(Math.abs((await editor.boundingBox()).height - compactHeight) < 1);
  const settings = await page.evaluate(() => browser.storage.local.get("settings"));
  assert.match(settings.settings.template, /逐图解释/);
  assert.equal(await page.locator("#api-key").inputValue(), "");
  check("Template preview is one-third height; click expands to two-thirds and outside/Save collapses without losing drafts");

  await page.locator("#settings-tab-api").click();
  assert.ok(await page.locator("#settings-template").isHidden());
  assert.ok(await page.locator("#settings-form").isVisible());
  await page.locator("#api-key").fill("unsaved-test-key");
  await page.locator("#settings-tab-about").click();
  assert.ok(await page.locator("#settings-api").isHidden());
  assert.ok(await page.locator("#settings-about").isVisible());
  assert.equal(await page.locator("#settings-about .pill").textContent(), "1.0.5");
  assert.equal(await page.locator(".author-name").textContent(), "Xi Zhang");
  assert.equal(await page.locator(".author-card a").getAttribute("href"), "mailto:oca-john@hotmail.com");
  await page.locator("#settings-tab-about").press("ArrowLeft");
  assert.equal(await page.locator("#api-key").inputValue(), "unsaved-test-key");
  await page.locator("#settings-tab-api").press("Home");
  assert.equal(await page.locator("#settings-tab-appearance").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator(".settings-section:not([hidden])").count(), 1);
  assert.equal((await page.evaluate(() => browser.storage.local.get(null))).apiKey, undefined);
  check("Four Settings subtabs are exclusive, start with Appearance and preserve unsubmitted API fields");
  await page.locator("#tab-read").click();
  assert.match(await page.locator("#panel-read .mode-note").textContent(), /自己的 API Key.*充值/);
  const picker = await page.locator(".source-picker").boundingBox();
  assert.ok(picker.height < 185, `current-tab card should be compact: ${picker.height}`);
  await mkdir(join(root, "artifacts", "qa"), { recursive: true });
  await page.screenshot({ path: join(root, "artifacts", "qa", "sidebar-read-compact.png") });
  await page.locator("#edit-template").click();
  assert.equal(await page.locator("#tab-settings").getAttribute("aria-selected"), "true");
  assert.match(await page.locator("#template-text").inputValue(), /逐图解释/);
  check("Both edit shortcuts open Settings; templates save without an API key and persist for both modes");
  await page.locator("#tab-web").click();
  await page.locator("#web-fill").click();
  await page.locator("#web-status").filter({ hasText: "已填入网址和模板" }).waitFor();
  assert.match(await frame.locator("#chat-input").inputValue(), /逐图解释/);
  await frame.locator("#send").click();
  assert.equal(await frame.locator("#sent-count").textContent(), "1");
  check("Existing drafts are protected; saved templates update prompts; tab switching preserves the chat");

  await page.locator("#tab-settings").click();
  await frame.locator("#chat-input").evaluate(el => {
    el.hidden = true;
    el.after(document.createElement("i"));
  });
  await page.waitForFunction(() => document.getElementById("web-status").textContent.includes("尚未出现聊天输入框"));
  // Visibility may change without a new DOM child or document navigation.
  await frame.locator("#chat-input").evaluate(el => { el.hidden = false; });
  await page.locator("#tab-web").click();
  await page.waitForFunction(() => !document.getElementById("web-fill").disabled, null, { timeout: 5000 });
  assert.equal(await frame.locator("#sent-count").textContent(), "1");
  check("Returning to DeepSeek rechecks composer readiness without reloading the conversation");

  await page.evaluate(() => browser.changePaper());
  await page.locator("#web-paper-title").filter({ hasText: "另一篇论文" }).waitFor();
  await frame.locator("#answer").evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  await page.locator("#web-selection").click();
  await page.locator("#web-note-editor").waitFor();
  assert.match(await page.locator("#web-note-source").textContent(), /id=42/);
  assert.doesNotMatch(await page.locator("#web-note-source").textContent(), /\/second/);
  await page.locator("#web-save-note").click();
  await page.locator("#result-status").filter({ hasText: "已导入" }).waitFor();
  assert.match(await page.locator("#result").textContent(), /对照设计/);
  const saved = Object.entries(await page.evaluate(() => browser.storage.local.get(null))).filter(([key]) => key.startsWith("reading:"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0][1].source.url, "https://papers.example/article?id=42");
  check("Selected answers import to local notes with the original prompt's paper source");

  await page.locator("#tab-web").click();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await mkdir(join(root, "artifacts", "qa"), { recursive: true });
  await page.screenshot({ path: join(root, "artifacts", "qa", "sidebar-web.png"), fullPage: true });

  for (const width of [300, 520, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, selectors] of [
      ["read", [".source-picker", "#result-card"]],
      ["history", [".history-item"]],
      ["settings", ["#template-text", ".settings-tabs"]],
    ]) {
      await page.locator(`#tab-${name}`).click();
      await page.locator(selectors[0]).waitFor();
      const layout = await page.evaluate(({ name, selectors }) => {
        const panel = document.querySelector(`#panel-${name}`).getBoundingClientRect();
        const scroll = document.querySelector(`#panel-${name} .panel-scroll`);
        return { panel: panel.toJSON(), width: document.documentElement.clientWidth, contentWidth: scroll.clientWidth, scrollWidth: document.documentElement.scrollWidth,
          content: selectors.map(selector => document.querySelector(selector).getBoundingClientRect().toJSON()) };
      }, { name, selectors });
      assert.ok(layout.panel.x < 1 && Math.abs(layout.panel.width - layout.width) < 1, `${name} at ${width}px: panel fills width`);
      assert.ok(layout.scrollWidth <= width, `${name} at ${width}px: no horizontal overflow`);
      for (const content of layout.content) {
        if (name === "settings") {
          assert.ok(Math.abs(content.width - layout.contentWidth * .90) < 1, `${width}px: settings content uses 90% of the available sidebar width`);
          assert.ok(Math.abs(content.x - (layout.contentWidth - content.right)) < 1, `${width}px: settings content is centered`);
        } else assert.ok(content.x <= 18 && layout.contentWidth - content.right <= 18, `${name} at ${width}px: content has only small internal gutters`);
      }
    }
    for (const name of ["appearance", "api", "about", "template"]) {
      await page.locator(`#settings-tab-${name}`).click();
      const rect = await page.locator(`#settings-${name}`).boundingBox();
      const contentWidth = await page.locator(".settings-scroll").evaluate(el => el.clientWidth);
      assert.ok(Math.abs(rect.width - contentWidth * .90) < 1, `${name}: settings subtab uses 90% of the available sidebar width`);
      assert.ok(Math.abs(rect.x - (contentWidth - rect.x - rect.width)) < 1, `${name}: settings subtab is centered`);
    }
  }
  await page.locator(".settings-scroll").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: join(root, "artifacts", "qa", "sidebar-settings-wide.png"), fullPage: true });
  await page.locator("#tab-web").click();
  assert.equal(await frame.locator("#sent-count").textContent(), "1", "resizing and visiting every panel must preserve the chat");
  await page.screenshot({ path: join(root, "artifacts", "qa", "sidebar-web-wide.png"), fullPage: true });
  check("Settings subtabs and their controls use a centered 90% content width at 300, 520 and 1200 px; API reading and notes retain full-width panels");

  await page.setViewportSize({ width: 410, height: 900 });
  await page.evaluate(async () => {
    const records = {};
    for (let i = 0; i < 34; i++) records[`reading:fixture-${i}`] = {
      id: `fixture-${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), status: "complete",
      source: { title: `记录 ${i} · 用于验证最近五条与全部记录的展示`, url: "https://papers.example/history" },
      model: "测试模型", content: `## 记录 ${i}\n合成测试笔记。`,
    };
    await browser.storage.local.set(records);
  });
  // Saving through the actual UI must enforce the cap on persisted records.
  await page.locator("#web-paste-note").click();
  await page.locator("#web-answer").fill("## 新阅读记录\n验证最近记录和全部记录切换。");
  await page.locator("#web-save-note").click();
  await page.locator("#result").filter({ hasText: "验证最近记录" }).waitFor();
  const retained = await page.evaluate(() => browser.storage.local.get(null));
  assert.equal(Object.keys(retained).filter(key => key.startsWith("reading:")).length, 30);
  assert.equal(retained["reading:fixture-0"], undefined);
  assert.ok(retained["reading:fixture-33"]);
  await page.locator("#tab-history").click();
  await page.waitForFunction(() => document.querySelectorAll(".history-item").length === 5);
  await page.locator("#history-show-all").click();
  await page.waitForFunction(() => document.querySelectorAll(".history-item").length === 30);
  await page.locator("#clear-history").click();
  const confirmation = await page.locator("#clear-confirm").evaluate(el => el.getBoundingClientRect().toJSON());
  assert.ok(confirmation.top >= 72 && confirmation.bottom <= 875, `fixed footer brings the delete confirmation into view: ${JSON.stringify(confirmation)}`);
  await page.locator("#cancel-clear").click();
  await page.locator("#toast").waitFor({ state: "hidden" });
  const toggleBefore = await page.locator("#history-show-all").boundingBox();
  await page.locator(".history-scroll").evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert.ok(await page.locator(".history-scroll").evaluate(el => el.scrollTop > 500));
  const toggleAfter = await page.locator("#history-show-all").boundingBox();
  assert.deepEqual(toggleAfter, toggleBefore);
  await page.screenshot({ path: join(root, "artifacts", "qa", "sidebar-history-all.png") });
  await page.locator("#history-show-all").click();
  await page.waitForFunction(() => document.querySelectorAll(".history-item").length === 5);
  await page.locator("#history-show-all").click();
  await page.locator("#tab-web").click();
  await page.locator("#tab-history").click();
  await page.waitForFunction(() => document.querySelectorAll(".history-item").length === 5);
  await page.screenshot({ path: join(root, "artifacts", "qa", "sidebar-history-recent.png") });
  await page.locator("#tab-web").click();
  await page.locator("#web-focus-toggle").click();
  await page.screenshot({ path: join(root, "artifacts", "qa", "sidebar-web-focused.png") });
  await page.locator("#web-focus-toggle").click();
  check("Notes default to five, show up to thirty, trim older persisted records and keep the toggle fixed while scrolling");

  // Expanded drawers must remain reachable even in a short sidebar.
  await page.setViewportSize({ width: 520, height: 500 });
  await page.locator("#web-prompt-options > summary").click();
  await page.locator("#web-paste-note").click();
  await page.locator("#web-answer").fill("尚未保存的笔记草稿");
  assert.ok(await page.locator("#web-frame").evaluate(el => el.getBoundingClientRect().height >= 140));
  assert.ok(await page.locator(".web-notes").evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.height === 25 && rect.bottom === innerHeight;
  }), "an expanded note editor cannot grow or displace the footer");
  await page.locator("#web-cancel-note").click();
  await page.locator("#web-prompt-options > summary").click();
  await page.setViewportSize({ width: 300, height: 900 });
  await page.locator(".web-content").evaluate(el => { el.scrollTop = 0; });
  assert.ok(await page.locator("#web-frame").evaluate(el => el.getBoundingClientRect().height > 450));
  assert.equal(server.requests.length, 0);
  assert.deepEqual(errors, []);
  check("Short sidebars keep expanded controls reachable and restore chat height when closed, with zero API calls");
  blankFixture = true;
  await page.locator("#web-reload").click();
  await page.locator("#web-status").filter({ hasText: "尚未出现聊天输入框" }).waitFor();
  assert.ok(await page.locator("#web-fill").isDisabled(), "a live bridge is not proof that the chat UI is ready");
  await frame.locator("body").evaluate(body => {
    const input = document.createElement("textarea"); input.id = "chat-input"; body.append(input);
  });
  await page.locator("#web-status").filter({ hasText: "网页版已就绪" }).waitFor();
  assert.ok(await page.locator("#web-fill").isEnabled());
  check("Blank pages cannot appear chat-ready; SPA composer changes enable the toolbar");
  await writeFile(join(root, "artifacts", "qa", "web-browser-report.json"), JSON.stringify({
    version: "1.0.5", browser: await browser.version(), checks, errors, layouts, chromeLayouts,
    note: "Cross-origin iframe and bundled content bridge tested against a local DeepSeek UI fixture. Live authenticated DeepSeek not tested.",
  }, null, 2));
} finally { await browser.close(); await server.close(); }
