import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer, root, testText } from "./support.mjs";

const server = await startServer();
let executablePath = process.env.CHROMIUM_BINARY;
if (!executablePath && !existsSync(chromium.executablePath()) && process.env.LOCALAPPDATA) {
  for (const folder of await readdir(join(process.env.LOCALAPPDATA, "ms-playwright")).catch(() => [])) {
    const path = join(process.env.LOCALAPPDATA, "ms-playwright", folder, "chrome-win64", "chrome.exe");
    if (folder.startsWith("chromium-") && existsSync(path)) executablePath = path;
  }
}
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({ viewport: { width: 410, height: 900 } });
const checks = [], errors = [], layouts = [];
const check = text => { checks.push(text); console.log(`PASS: ${text}`); };
await context.addInitScript(({ origin }) => {
  const local = JSON.parse(sessionStorage.getItem("appearance-fixture") || "{}"), session = {}, listeners = [];
  const storage = (data, persistent) => ({
    get: async keys => keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, data[k]])),
    set: async values => {
      const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: data[key], newValue: value }]));
      Object.assign(data, structuredClone(values));
      if (persistent) { sessionStorage.setItem("appearance-fixture", JSON.stringify(data)); listeners.forEach(fn => fn(changes, "local")); }
    },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  globalThis.browser = {
    runtime: { getURL: path => origin + (path.startsWith("/") ? path : `/${path}`) },
    permissions: { contains: async () => true, request: async () => true }, windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: { query: async () => [{ id: 1, windowId: 1, title: "论文标题 · 不随界面翻译", url: "https://papers.example/paper" }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    storage: { local: storage(local, true), session: storage(session, false), onChanged: { addListener: fn => listeners.push(fn) } },
  };
}, { origin: server.origin });
const bridge = await readFile(join(root, "dist/deepseek.js"), "utf8");
await context.route("https://chat.deepseek.com/**", route => new URL(route.request().url()).pathname === "/bridge.js"
  ? route.fulfill({ contentType: "application/javascript", body: bridge })
  : route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><script defer src="/bridge.js"></script></head><body><textarea id="chat-input"></textarea><script>window.fixtureIdentity=Math.random();</script></body></html>' }));
const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
const openAppearance = async () => { await page.locator("#tab-settings").click(); await page.locator("#settings-tab-appearance").click(); };
try {
  await page.goto(`${server.origin}/sidebar.html`);
  await page.locator("#web-status").filter({ hasText: "网页版已就绪" }).waitFor();
  const frame = page.frameLocator("#web-frame");
  const identity = await frame.locator("body").evaluate(() => window.fixtureIdentity);
  await frame.locator("#chat-input").fill("这份未发送的聊天草稿必须保留");
  await page.locator("#tab-settings").click();
  assert.equal(await page.locator(".settings-tab").first().getAttribute("id"), "settings-tab-appearance");
  assert.ok(await page.locator("#settings-appearance").isVisible());
  assert.equal(await page.locator("html").getAttribute("data-accent"), "blue");
  assert.equal(await page.locator("html").getAttribute("data-theme-preference"), "browser");
  assert.equal(await page.locator('[data-theme-choice="browser"]').getAttribute("aria-checked"), "true");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  const typography = await page.evaluate(() => {
    const selectors = ["body", ".brand strong", ".version", ".tab", ".mode-note", ".section-label", ".step", ".settings-tab", ".appearance-option", ".hint", "#template-text", ".markdown", ".panel-footer", ".panel-footer button"];
    const sizes = () => selectors.map(selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize));
    const enlarged = sizes();
    document.documentElement.style.setProperty("--font-increase", "0pt");
    const base = sizes();
    document.documentElement.style.removeProperty("--font-increase");
    const reference = getComputedStyle(document.querySelector("#settings-appearance h2"));
    const properties = ["fontSize", "color", "fontFamily", "fontWeight", "lineHeight", "letterSpacing"];
    return { deltas: enlarged.map((size, i) => size - base[i]),
      headings: [...document.querySelectorAll(".history-heading,#panel-settings :is(h1,h2,h3,legend,label:not(.checkbox),.callout strong,.help summary)")].map(el => {
        const style = getComputedStyle(el);
        return { title: el.textContent, matches: properties.every(property => style[property] === reference[property]) };
      }), numbered: document.querySelectorAll("#panel-settings .step,#panel-history .step").length };
  });
  assert.ok(typography.deltas.every(value => Math.abs(value - 4 / 3) < .02));
  assert.ok(typography.headings.every(heading => heading.matches), JSON.stringify(typography.headings));
  assert.equal(typography.numbered, 0);
  await mkdir(join(root, "artifacts/qa"), { recursive: true });
  await page.screenshot({ path: join(root, "artifacts/qa/appearance-light-blue.png") });
  check("Appearance is the first default settings subtab, with blue and Follow browser defaults");
  await page.locator('[data-language-choice="zh-CN"]').press("ArrowRight");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.locator('[data-language-choice="en"]').press("Home");
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.locator('[data-theme-choice="light"]').click();
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.locator('[data-theme-choice="browser"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.waitForFunction(async () => (await browser.storage.local.get("appearance")).appearance?.theme === "browser");
  assert.equal(await frame.locator("body").evaluate(() => window.fixtureIdentity), identity);
  assert.equal(await frame.locator("#chat-input").inputValue(), "这份未发送的聊天草稿必须保留");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  check("Follow browser reacts live, fixed choices override it, and switching back preserves the chat draft");

  await page.locator("#settings-tab-template").click();
  const originalTemplate = await page.locator("#template-text").inputValue();
  await page.locator("#template-text").click();
  await page.locator("#template-text").fill(originalTemplate + "\n不丢失这段未保存的模板草稿。");
  await page.locator("#settings-tab-api").click();
  await page.locator("#api-key").fill("unsaved-appearance-test-key");
  await openAppearance();
  await page.locator('[data-language-choice="en"]').click();
  assert.equal(await page.locator("#tab-settings").textContent(), "Settings");
  assert.equal(await page.title(), "XPaper-Read");
  assert.equal(await page.locator(".brand strong").textContent(), "XPaper-Read");
  assert.equal(await page.locator("#settings-tab-appearance").textContent(), "Appearance");
  assert.equal(await page.locator("#web-status").textContent(), "Web chat is ready. Fill the prompt, then send it below. No API call is used.");
  assert.match(await page.locator("#template-text").inputValue(), /未保存的模板草稿/);
  assert.equal(await page.locator("#api-key").inputValue(), "unsaved-appearance-test-key");
  assert.equal(await frame.locator("#chat-input").inputValue(), "这份未发送的聊天草稿必须保留");
  assert.equal(await frame.locator("body").evaluate(() => window.fixtureIdentity), identity);
  check("English applies live, including status messages, without reloading chat or losing drafts");
  await page.locator("#settings-tab-about").click();
  assert.equal(await page.locator(".author-card .section-title").textContent(), "Author");
  assert.equal(await page.locator(".author-name").textContent(), "Xi Zhang");
  assert.equal(await page.locator(".author-card a").textContent(), "oca-john@hotmail.com");

  for (const language of ["en", "zh-CN"]) {
    await openAppearance(); await page.locator(`[data-language-choice="${language}"]`).click();
    for (const theme of ["light", "dark"]) for (const accent of ["red", "yellow", "green", "blue", "purple", "gray"]) {
      await openAppearance();
      await page.locator(`[data-theme-choice="${theme}"]`).click();
      await page.locator(`[data-accent-choice="${accent}"]`).click();
      assert.match(await page.locator(".brand img").getAttribute("src"), new RegExp(`book-${accent}\\.svg$`));
      assert.equal(await page.locator(`[data-accent-choice="${accent}"]`).getAttribute("aria-checked"), "true");
      for (const width of [280, 1000]) {
        await page.setViewportSize({ width, height: 900 });
        for (const name of ["web", "read", "history", "settings"]) {
          await page.locator(`#tab-${name}`).click();
          const layout = await page.evaluate(name => {
            const panel = document.querySelector(`#panel-${name}`), css = getComputedStyle(document.body);
            const footer = panel.querySelector(".panel-footer"), tabs = document.querySelector(".tabs"), active = tabs.querySelector(".active");
            const inactive = tabs.querySelector(".tab:not(.active)");
            const children = [...panel.querySelectorAll("button,select,textarea")].filter(el => el.getClientRects().length);
            const highlight = getComputedStyle(document.querySelector(".preview-highlight"));
            return { language: document.documentElement.lang, theme: document.documentElement.dataset.theme, accent: document.documentElement.dataset.accent,
              name, width: innerWidth, background: css.backgroundColor, ink: css.color, highlight: highlight.backgroundColor, highlightInk: highlight.color,
              height: footer.getBoundingClientRect().height, bottom: footer.getBoundingClientRect().bottom,
              mainTop: document.querySelector("main").getBoundingClientRect().top,
              overflow: document.documentElement.scrollWidth > innerWidth || footer.scrollWidth > footer.clientWidth || children.some(el => el.getBoundingClientRect().right > innerWidth + 1),
              well: getComputedStyle(tabs).boxShadow, active: getComputedStyle(active).boxShadow, inactive: getComputedStyle(inactive).boxShadow };
          }, name);
          layouts.push(layout);
          assert.equal(layout.overflow, false, JSON.stringify(layout));
          const navigation = await page.locator(".tabs .tab, .settings-tab").evaluateAll(buttons => buttons.filter(el => el.getClientRects().length).map(el => ({ id:el.id, width:el.clientWidth, content:el.scrollWidth })));
          assert.ok(navigation.every(button => button.content <= button.width), `navigation labels fit their buttons: ${language} ${width}px ${JSON.stringify(navigation)}`);
          if (name === "settings") {
            const groups = await page.locator(".appearance-options").evaluateAll(groups => groups.map(group => [...group.children].map(button => {
              const box = button.getBoundingClientRect(), label = button.querySelector("span").getBoundingClientRect();
              return { width:box.width, height:box.height, x:Math.abs(label.x + label.width / 2 - box.x - box.width / 2), y:Math.abs(label.y + label.height / 2 - box.y - box.height / 2), fits:button.scrollWidth <= button.clientWidth, align:getComputedStyle(button).textAlign };
            })));
            for (const group of groups) {
              assert.ok(group.every(button => Math.abs(button.width - group[0].width) < 1 && button.height === group[0].height));
              assert.ok(group.every(button => button.x < 1 && button.y < 1 && button.fits && button.align === "center"));
            }
          }
          if (name === "web") assert.ok(await page.locator(".web-mode-note").evaluate(el => {
            const hint = el.querySelector(".web-login-hint").getBoundingClientRect();
            const actions = el.querySelector(".web-login-actions").getBoundingClientRect();
            return hint.right < actions.left && actions.right <= innerWidth - 10;
          }), "login and reload stay to the right of the hint in both languages");
          if (["web", "read"].includes(name)) {
            const prefix = name === "web" ? "web" : "read";
            for (const type of ["review", "article"]) {
              await page.locator(`#${prefix}-paper-type`).press(type === "review" ? "End" : "Home");
              await page.waitForFunction(prefix => getComputedStyle(document.getElementById(`${prefix}-paper-type`), "::before").backgroundColor === getComputedStyle(document.querySelector(".appearance-preview")).backgroundColor, prefix);
              await page.waitForFunction(prefix => {
                const group = document.getElementById(`${prefix}-paper-type`);
                const thumb = getComputedStyle(group, "::before");
                return group.dataset.paperType === "article" ? new DOMMatrixReadOnly(thumb.transform).m41 === 0
                  : Math.abs(new DOMMatrixReadOnly(thumb.transform).m41 - parseFloat(thumb.width) - 3) < .1;
              }, prefix);
              const selector = await page.locator(`#${prefix}-paper-type`).evaluate(group => {
                const active = group.querySelector(".active");
                const box = group.getBoundingClientRect(), edit = document.getElementById("web-edit-template").getBoundingClientRect();
                const labels = [...group.querySelectorAll(".paper-type-label")];
                const thumb = getComputedStyle(group, "::before");
                const labelBox = active.getBoundingClientRect();
                const thumbLeft = box.left + group.clientLeft + parseFloat(thumb.left) + new DOMMatrixReadOnly(thumb.transform).m41;
                const thumbWidth = parseFloat(thumb.width) + (thumb.boxSizing === "border-box" ? 0 : parseFloat(thumb.borderLeftWidth) + parseFloat(thumb.borderRightWidth));
                return { width: box.width, left: box.left, right: box.right, top: box.top, bottom: box.bottom, edit: edit.toJSON(),
                  thumbLeft, thumbRight: thumbLeft + thumbWidth, labelLeft: labelBox.left, labelRight: labelBox.right,
                  fits: labels.every(label => label.scrollWidth <= label.clientWidth),
                  equal: Math.abs(labels[0].getBoundingClientRect().width - labels[1].getBoundingClientRect().width) < 1,
                  well: getComputedStyle(group).boxShadow, active: thumb.boxShadow,
                  radius: parseFloat(getComputedStyle(group).borderRadius), height: box.height, thumbRadius: parseFloat(thumb.borderRadius),
                  color: getComputedStyle(active).color, themeColor: getComputedStyle(document.querySelector(".tab.active")).color };
              });
              assert.ok(selector.fits && selector.equal && selector.left >= 0 && selector.right <= width, JSON.stringify(selector));
              assert.ok(selector.well.includes("inset") && selector.active.includes("inset"));
              assert.notEqual(selector.active, selector.well);
              assert.ok(selector.radius >= selector.height / 2 && selector.thumbRadius >= selector.height / 2);
              assert.ok(Math.abs(selector.thumbLeft - selector.labelLeft) < .75 && Math.abs(selector.thumbRight - selector.labelRight) < .75, `Thumb aligns with its label: ${JSON.stringify(selector)}`);
              assert.ok(selector.thumbLeft - selector.left >= 3.5 && selector.right - selector.thumbRight >= 3.5, `Thumb stays clear of the outer border: ${JSON.stringify(selector)}`);
              assert.equal(selector.color, selector.themeColor);
              if (name === "web" && width === 1000) assert.ok(selector.left > selector.edit.right && selector.top < selector.edit.bottom && selector.bottom > selector.edit.top);
            }
          }
          assert.equal(layout.height, 25); assert.equal(layout.bottom, 900); assert.equal(layout.mainTop, 72);
          assert.ok(layout.well.includes("inset") && layout.inactive.includes("inset"));
          assert.notEqual(layout.active, layout.inactive);
          // WCAG-style contrast calculation for core interface text in every palette.
          const luminance = rgb => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
          const a = luminance(layout.ink), b = luminance(layout.background);
          assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 7);
          const c = luminance(layout.highlight), d = luminance(layout.highlightInk);
          assert.ok((Math.max(c, d) + .05) / (Math.min(c, d) + .05) >= 4.5, `Highlight contrast: ${language} ${theme} ${accent}`);
        }
      }
    }
  }
  check("All 12 color/theme combinations in both languages fit 280px and 1000px across all four modes");
  check("Language and theme buttons are equal-width and centered; Notes and Settings headings share a uniform unnumbered style and fonts retain the 1pt increase");
  check("Main navigation has inset surfaces and raised selection; body contrast exceeds 7:1 and highlight text 4.5:1");
  check("Web and API capsules fit both languages in every palette; Article and Review thumbs align with their labels and stay inside the border");

  for (const [width, language, theme, accent, type, file] of [
    [640, "zh-CN", "light", "blue", "article", "web-type-light-blue.png"],
    [410, "zh-CN", "dark", "purple", "review", "web-type-dark-purple.png"],
    [280, "en", "light", "green", "review", "web-type-narrow-en.png"],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await openAppearance();
    await page.locator(`[data-language-choice="${language}"]`).click();
    await page.locator(`[data-theme-choice="${theme}"]`).click();
    await page.locator(`[data-accent-choice="${accent}"]`).click();
    await page.locator("#tab-web").click();
    await page.locator("#web-paper-type").press(type === "review" ? "End" : "Home");
    await page.locator("#web-paper-type").evaluate(el => el.blur());
    await page.locator("#web-top").screenshot({ path: join(root, "artifacts/qa", file), animations: "disabled" });
    if (width === 640) {
      await page.locator("#tab-read").click();
      await page.locator("#read-paper-type").press("End");
      await page.locator("#read-paper-type").evaluate(el => el.blur());
      await page.screenshot({ path: join(root, "artifacts/qa/api-type-capsule.png"), animations: "disabled" });
    }
  }

  await page.setViewportSize({ width: 410, height: 900 });
  await openAppearance(); await page.locator('[data-language-choice="en"]').click();
  await page.locator('[data-theme-choice="dark"]').click();
  await page.locator('[data-accent-choice="purple"]').click();
  await page.screenshot({ path: join(root, "artifacts/qa/appearance-dark-purple-en.png") });
  await page.locator('[data-accent-choice="purple"]').press("ArrowRight");
  assert.equal(await page.locator("html").getAttribute("data-accent"), "gray");
  await page.locator('[data-accent-choice="gray"]').press("Home");
  assert.equal(await page.locator("html").getAttribute("data-accent"), "red");
  await page.locator("#settings-tab-template").click(); await page.locator("#save-template").click();
  await page.locator("#settings-tab-api").click();
  await page.locator("#endpoint").fill(server.origin); await page.locator("#model").fill("test-401");
  await page.locator("#save-settings").click();
  await page.waitForFunction(async () => (await browser.storage.local.get("appearance")).appearance?.accent === "red");
  assert.deepEqual((await page.evaluate(() => browser.storage.local.get("appearance"))).appearance, { language: "en", theme: "dark", accent: "red" });
  await page.reload(); await page.locator("#web-status").filter({ hasText: "Web chat is ready" }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await page.locator("html").getAttribute("data-accent"), "red");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await openAppearance(); await page.locator("#settings-tab-template").click();
  assert.match(await page.locator("#template-text").inputValue(), /未保存的模板草稿/);
  check("Appearance persists after reload and API/template saves; radio controls support keyboard selection");

  await page.locator("#settings-tab-api").click(); await page.locator("#api-key").fill("test-only-key"); await page.locator("#save-settings").click();
  await page.locator("#tab-read").click(); await page.locator("#show-paste").click();
  await page.locator("#paste-title").fill("保留中文文献标题"); await page.locator("#paste-text").fill(testText);
  await page.locator("#use-paste").click();
  assert.equal(await page.locator("#source-kind").textContent(), "Pasted text");
  assert.equal(await page.locator("#source-title").textContent(), "保留中文文献标题");
  assert.match(await page.locator("#source-scope").textContent(), /^Pasted text/);
  assert.match(await page.locator("#send-info").textContent(), /Send to.*Estimated 1 request/);
  await page.locator("#summarize").click();
  await page.locator("#error").filter({ hasText: "Invalid or expired API key" }).waitFor();
  check("English localizes dynamic source details, cost notices and API errors while paper content stays unchanged");

  await page.evaluate(() => browser.storage.local.set({ appearance: { language: "zh-CN", theme: "light", accent: "green" } }));
  assert.equal(await page.locator("#tab-read").textContent(), "API 精读");
  assert.equal(await page.locator("html").getAttribute("data-accent"), "green");
  assert.match(await page.locator("#error").textContent(), /API Key 无效/);
  await openAppearance(); await page.locator("#reset-appearance").click();
  assert.equal(await page.locator("html").getAttribute("data-accent"), "blue");
  assert.equal(await page.locator("html").getAttribute("data-theme-preference"), "browser");
  assert.deepEqual(errors, []);
  check("External preference updates synchronize the sidebar, and reset restores Chinese/browser/blue");
  await writeFile(join(root, "artifacts/qa/appearance-report.json"), JSON.stringify({ version: "1.0.8", checks, errors, layouts }, null, 2));
} finally { await browser.close(); await server.close(); }
