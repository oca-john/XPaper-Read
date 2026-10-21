import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer, root, testTitle } from "./support.mjs";

const server = await startServer();
const binaries = [process.env.FIREFOX_BINARY, "D:\\Program Files\\Mozilla Firefox\\firefox.exe", "C:\\Program Files\\Mozilla Firefox\\firefox.exe"].filter(Boolean);
const binary = binaries.find(existsSync);
const options = new firefox.Options().addArguments("-headless");
options.setPageLoadStrategy("eager");
if (binary) options.setBinary(binary);
// All preferences apply only to the isolated WebDriver profile.
options.setPreference("sidebar.position_start", false);
options.setPreference("browser.shell.checkDefaultBrowser", false);
options.setPreference("datareporting.policy.dataSubmissionEnabled", false);
options.setPreference("pdfjs.disabled", false);
options.setPreference("browser.download.open_pdf_attachments_inline", true);
const service = new firefox.ServiceBuilder(process.env.GECKODRIVER).addArguments("--allow-system-access");
const builder = new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(service);
let driver;
const report = { extensionVersion: "1.0.8", checks: [], layouts: [], chromeLayouts: [], note: "Stock Firefox, isolated headless profile; local simulated model API. Embedded public DeepSeek page is observed without signing in or sending a message." };
const check = text => { report.checks.push(text); console.log(`PASS: ${text}`); };
async function chrome() {
  await driver.switchTo().defaultContent();
  await driver.setContext(firefox.Context.CHROME);
}
async function sidebar() {
  await chrome();
  await driver.wait(() => driver.executeScript(`
    const panel = document.getElementById("sidebar").contentDocument;
    const browser = panel?.querySelector("browser");
    return !!browser?.browsingContext?.currentWindowGlobal;
  `), 15000, "Native sidebar browser should be loaded");
  await driver.wait(() => evaluate('!!document.getElementById("tab-settings")'), 10000);
}
// Sidebar content browsers are not exposed as tabs by WebDriver. Use Firefox's
// own Marionette actor in this isolated --allow-system-access test profile.
const actorSetup = `
  const panel = document.getElementById("sidebar").contentDocument;
  const target = panel.querySelector("browser");
  const actor = target.browsingContext.currentWindowGlobal.getActor("MarionetteCommands");
`;
async function evaluate(expression) {
  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    ${actorSetup}
    actor.executeScript(arguments[0], [], {timeout: 10000}).then(value => done({value}), error => done({error: String(error)}));
  `, `return (${expression});`);
  if (result.error) throw new Error(result.error);
  return result.value;
}
async function click(id) {
  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1], selector = arguments[0];
    ${actorSetup}
    actor.findElement("css selector", selector, {timeout: 10000})
      .then(el => actor.clickElement(el, {toJSON: () => ({"moz:webdriverClick": true})}))
      .then(() => done({ok:true}), error => done({error:String(error)}));
  `, `#${id}`);
  if (result.error) throw new Error(result.error);
}
async function fill(id, value) { await evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}`); }
async function text(id) { return evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`); }
async function ready() { await driver.wait(() => evaluate('!document.getElementById("capture").disabled'), 30000); }
async function waitText(id, text, ms = 15000) {
  await driver.wait(async () => (await evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`)).includes(text), ms, `${id} should contain ${text}`);
}

try {
  driver = await builder.build();
  await driver.manage().setTimeouts({ script: 20000, pageLoad: 20000 });
  await driver.manage().window().setRect({ width: 1400, height: 1100 });
  report.version = (await driver.getCapabilities()).get("browserVersion");
  // Visit the ordinary public page first, as in the user's "log in in Firefox"
  // workflow. No credentials are entered and no verification is automated.
  try {
    await driver.get("https://chat.deepseek.com/");
    await driver.wait(() => driver.executeScript('return document.body?.innerText.trim().length > 100;'), 20000);
    report.liveTopPage = await driver.executeScript('return {url:location.href,title:document.title,excerpt:document.body.innerText.slice(0,250)};');
  } catch (error) {
    report.liveTopPage = { available: false, error: error.name };
  }
  await driver.get(`${server.origin}/fixture/article`);
  await driver.installWebExtension(join(root, "dist"), { permanent: false });
  await chrome();
  // Test fixture hosts are granted via Firefox's own permission store.
  // The production manifest and source files remain unchanged.
  await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
    const extension = WebExtensionPolicy.getByID("xpaper-read@local.extension").extension;
    ExtensionPermissions.add("xpaper-read@local.extension", { origins: ["http://127.0.0.1/*"], permissions: [] }, extension)
      .then(() => done(true), err => done(String(err)));
  `);
  await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const id = [...SidebarController.sidebars.keys()].find(k => k.includes("xpaper"));
    SidebarController.show(id).then(() => done(id), e => done(String(e)));
  `);
  await sidebar();
  await waitText("tab-title", testTitle);
  check("Installed unmodified Firefox MV2 extension and opened native Firefox sidebar");
  assert.equal(await evaluate('document.getElementById("tab-web").getAttribute("aria-selected")'), "true");
  assert.equal(await evaluate('document.getElementById("panel-web").hidden'), false);
  check("Integrated DeepSeek panel is the default native sidebar view");
  assert.equal(await evaluate('document.getElementById("web-paper-type").dataset.paperType'), "article");
  assert.match(await evaluate('document.getElementById("web-prompt").value'), /Article（研究文章）/);
  assert.doesNotMatch(await evaluate('document.getElementById("web-prompt").value'), /先判断文章类型|【Review 精读模板】/);
  await click("web-type-review");
  assert.equal(await evaluate('document.getElementById("web-paper-type").dataset.paperType'), "review");
  assert.match(await evaluate('document.getElementById("web-prompt").value'), /【Review 精读模板】/);
  assert.doesNotMatch(await evaluate('document.getElementById("web-prompt").value'), /先判断文章类型|【Article 精读模板】/);
  await driver.wait(async () => {
    report.capsuleReviewGeometry = await evaluate(`(() => {
      const group = document.getElementById("web-paper-type"), box = group.getBoundingClientRect();
      const thumb = getComputedStyle(group, "::before"), label = group.querySelector(".active").getBoundingClientRect();
      const left = box.left + group.clientLeft + parseFloat(thumb.left) + new DOMMatrixReadOnly(thumb.transform).m41;
      const width = parseFloat(thumb.width) + (thumb.boxSizing === "border-box" ? 0 : parseFloat(thumb.borderLeftWidth) + parseFloat(thumb.borderRightWidth));
      return {leftInset:left-box.left,rightInset:box.right-left-width,leftDelta:left-label.left,rightDelta:left+width-label.right};
    })()`);
    const geometry = report.capsuleReviewGeometry;
    return geometry.leftInset >= 3.5 && geometry.rightInset >= 3.5 && Math.abs(geometry.leftDelta) < .75 && Math.abs(geometry.rightDelta) < .75;
  }, 3000, "Review thumb should align with its label and stay clear of the outer border");
  await click("web-edit-template");
  assert.equal(await evaluate('document.getElementById("template-choice-review").getAttribute("aria-checked")'), "true");
  await click("tab-web"); await click("web-type-article");
  check("Native Firefox defaults to Article; the top selector updates only the chosen prompt and opens the matching editor without classification");
  assert.equal(await evaluate('document.documentElement.dataset.themePreference'), "browser");
  // Extension sidebars follow browser chrome, not the separate website override.
  // Change built-in themes only in this isolated test profile.
  const themes = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    AddonManager.getAddonsByTypes(["theme"]).then(items => done(items.map(item => ({id:item.id,active:item.isActive}))), error => done({error:String(error)}));
  `);
  const previousTheme = themes.find(theme => theme.active)?.id;
  const nativeThemes = Object.fromEntries(["dark", "light"].map(scheme => [scheme, themes.find(theme => theme.id.includes(`compact-${scheme}`))?.id]));
  assert.ok(nativeThemes.dark && nativeThemes.light, JSON.stringify(themes));
  const setBrowserTheme = async id => {
    const result = await driver.executeAsyncScript(`
      const id = arguments[0], done = arguments[arguments.length - 1];
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      AddonManager.getAddonByID(id).then(addon => addon.enable()).then(() => done({ok:true}), error => done({error:String(error)}));
    `, id);
    assert.equal(result.ok, true, result.error);
  };
  report.browserThemeChanges = [];
  for (const expected of ["dark", "light", "dark"]) {
    await setBrowserTheme(nativeThemes[expected]);
    await driver.wait(() => evaluate(`document.documentElement.dataset.theme === "${expected}"`), 5000, `Follow Firefox ${expected} preference`);
    report.browserThemeChanges.push(await evaluate('({preference:document.documentElement.dataset.themePreference,resolved:document.documentElement.dataset.theme,mediaDark:matchMedia("(prefers-color-scheme: dark)").matches})'));
  }
  await click("tab-settings"); await click("settings-tab-appearance");
  await evaluate('document.querySelector(\'[data-theme-choice="light"]\').click()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), "light");
  await evaluate('document.querySelector(\'[data-theme-choice="browser"]\').click()');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), "dark");
  await driver.wait(() => evaluate('getComputedStyle(document.querySelector(".appearance-option.active")).backgroundColor === getComputedStyle(document.querySelector(".appearance-preview")).backgroundColor'), 5000);
  await writeFile(join(root, "artifacts", "qa", "firefox-follow-browser-native.png"), Buffer.from(await driver.takeScreenshot(), "base64"));
  if (previousTheme) await setBrowserTheme(previousTheme);
  await click("tab-web");
  check("Native sidebar follows Firefox's actual dark/light preference changes and supports a fixed override");
  try {
    await driver.wait(async () => (await text("web-status")).includes("网页版已就绪") || (await text("web-status")).includes("请在此登录"), 20000);
    report.liveEmbed = { connected: true, status: await text("web-status"), authenticated: false };
  } catch {
    report.liveEmbed = { connected: false, status: await text("web-status"), authenticated: false };
  }
  if (!report.liveEmbed.connected) {
    await evaluate(`(() => {
      window.qaFrameRequests = [];
      browser.webRequest.onHeadersReceived.addListener(d => {
        window.qaFrameRequests.push({
          url:d.url, type:d.type, documentUrl:d.documentUrl, originUrl:d.originUrl,
          frameAncestors:d.frameAncestors, tabId:d.tabId,
          headers:d.responseHeaders.filter(h => /^(x-frame-options|content-security-policy)$/i.test(h.name))
        });
      }, {urls:["https://chat.deepseek.com/*"],types:["sub_frame"]}, ["responseHeaders"]);
      return true;
    })()`);
    await click("web-reload");
    try { await driver.wait(async () => (await text("web-status")).includes("请在此登录") || (await text("web-status")).includes("网页版已就绪"), 20000); } catch {}
    report.liveEmbed.diagnostics = await evaluate('({sidebar:location.href, requests:window.qaFrameRequests})');
  }
  await mkdir(join(root, "artifacts", "qa"), { recursive: true });
  await writeFile(join(root, "artifacts", "qa", "firefox-web-native.png"), Buffer.from(await driver.takeScreenshot(), "base64"));
  console.log(`OBSERVATION: live embedded page ${JSON.stringify(report.liveEmbed)}`);

  for (const width of [300, 540, 1000, 340]) {
    await chrome();
    // Resize only the native sidebar in this temporary test profile.
    await driver.executeScript(`
      const box = document.getElementById("sidebar-box");
      for (const name of ["width", "min-width", "max-width"]) box.style.setProperty(name, arguments[0] + "px", "important");
    `, width);
    await driver.wait(() => evaluate(`Math.abs(innerWidth - ${width}) < 24`), 10000);
    const layout = await evaluate(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { width: innerWidth, height: innerHeight, main: rect("main"), panel: rect("#panel-web"), frame: rect("#web-frame"), notes: rect(".web-notes") };
    })()`);
    report.layouts.push(layout);
    assert.ok(Math.abs(layout.panel.height - layout.main.height) < 1 && Math.abs(layout.panel.y - layout.main.y) < 1, `${width}px: native chat fills available height`);
    assert.ok(Math.abs(layout.frame.x) < 1 && Math.abs(layout.frame.width - layout.width) < 1, `${width}px: native iframe fills the sidebar width`);
    assert.ok(layout.frame.height > 400 && layout.notes.bottom <= layout.height + 1, `${width}px: native chat stays tall with notes visible`);
    if (width === 1000) {
      await writeFile(join(root, "artifacts", "qa", "firefox-web-wide-native.png"), Buffer.from(await driver.takeScreenshot(), "base64"));
    }
    for (const name of ["web", "read", "history", "settings"]) {
      await click(`tab-${name}`);
      const chromeLayout = await evaluate(`(() => {
        const panel = document.getElementById("panel-${name}");
        const rect = el => el.getBoundingClientRect().toJSON();
        return { name: "${name}", width: innerWidth, height: innerHeight, panel: rect(panel),
          header: rect(document.querySelector(".app-header")), tabs: rect(document.querySelector(".tabs")),
          badge: rect(document.querySelector(".version")), footer: rect(panel.querySelector(".panel-footer")),
          versionLines: [...document.querySelector(".version").children].map(rect),
          buttons: [...panel.querySelectorAll(".panel-footer button")].filter(el => el.getClientRects().length).map(rect) };
      })()`);
      report.chromeLayouts.push(chromeLayout);
      assert.ok(chromeLayout.panel.x < 1 && Math.abs(chromeLayout.panel.width - chromeLayout.width) < 1);
      assert.equal(chromeLayout.header.height, 40);
      assert.equal(chromeLayout.tabs.bottom, 72);
      assert.equal(chromeLayout.badge.height, 20);
      assert.ok(chromeLayout.versionLines[0].right < chromeLayout.versionLines[1].left && chromeLayout.versionLines[0].top === chromeLayout.versionLines[1].top);
      assert.equal(chromeLayout.footer.height, 25);
      assert.equal(chromeLayout.footer.bottom, chromeLayout.height);
      assert.ok(chromeLayout.buttons.every(button => button.height === 18));
      await evaluate(`document.querySelector("#panel-${name} .panel-scroll").scrollTop = 99999`);
      assert.equal(await evaluate(`document.querySelector("#panel-${name} .panel-footer").getBoundingClientRect().bottom`), chromeLayout.height);
      await evaluate(`document.querySelector("#panel-${name} .panel-scroll").scrollTop = 0`);
    }
    await click("tab-web");
  }
  check("Real Firefox sidebar resizes from 300 to 1000 px with a full-height chat and full-width panels");
  check("Native modes share the compact header, horizontal Version 1.0.8 badge and 25px footer that stays fixed during scrolling");
  await click("tab-settings");
  await click("settings-tab-appearance");
  await evaluate('document.querySelector(\'[data-language-choice="en"]\').click()');
  await evaluate('document.querySelector(\'[data-theme-choice="dark"]\').click()');
  await evaluate('document.querySelector(\'[data-accent-choice="purple"]\').click()');
  assert.equal(await text("tab-settings"), "Settings");
  assert.ok(await evaluate('document.documentElement.dataset.theme === "dark" && document.querySelector(".brand img").src.endsWith("book-purple.svg")'));
  await driver.wait(async () => {
    const icons = await driver.executeScript('return [...SidebarController.sidebars.entries()].filter(([key]) => key.includes("xpaper")).map(([key,value]) => ({key,icon:value.icon,iconUrl:value.iconUrl,iconURL:value.iconURL,iconSource:value.iconSource}));');
    report.iconObservation = icons;
    return JSON.stringify(icons).includes("book-purple.svg");
  }, 10000, "The native sidebar icon should follow the selected palette");
  await driver.wait(() => evaluate('getComputedStyle(document.querySelector(".appearance-option.active")).backgroundColor === getComputedStyle(document.querySelector(".appearance-preview")).backgroundColor'), 5000, "Theme color transitions should finish before visual inspection");
  report.darkControls = await evaluate('[".appearance-option.active", ".tab:not(.active)", ".color-swatch.active"].map(selector => { const css = getComputedStyle(document.querySelector(selector)); return {selector,background:css.backgroundColor,color:css.color,appearance:css.appearance}; })');
  await writeFile(join(root, "artifacts", "qa", "firefox-appearance-native.png"), Buffer.from(await driver.takeScreenshot(), "base64"));
  await click("reset-appearance");
  assert.equal(await text("tab-settings"), "设置");
  await click("tab-web");
  check("Native appearance switches language, dark mode and both in-panel/native sidebar icons, then resets to blue");
  await click("web-focus-toggle");
  assert.equal(await evaluate('document.getElementById("web-frame").getBoundingClientRect().y'), 0);
  assert.equal(await evaluate('getComputedStyle(document.getElementById("main-tabs")).display'), "none");
  assert.ok(await evaluate('document.getElementById("web-focus-toggle").getBoundingClientRect().right <= innerWidth - 88'));
  await writeFile(join(root, "artifacts", "qa", "firefox-web-focused-native.png"), Buffer.from(await driver.takeScreenshot(), "base64"));
  await click("web-focus-toggle");
  check("Native focus toggle collapses every extension top control and restores the default view");
  await click("web-edit-template");
  assert.equal(await evaluate('document.getElementById("tab-settings").getAttribute("aria-selected")'), "true");
  assert.ok(await evaluate('document.getElementById("panel-settings").contains(document.getElementById("template-text")) && !document.getElementById("tab-template")'));
  assert.match(await evaluate('document.getElementById("template-text").value'), /核心结果逐个推进/);
  await writeFile(join(root, "artifacts", "qa", "firefox-settings-native.png"), Buffer.from(await driver.takeScreenshot(), "base64"));
  const compactHeight = await evaluate('document.getElementById("template-text").getBoundingClientRect().height');
  assert.ok(await evaluate('document.getElementById("template-text").readOnly'));
  await click("template-text");
  assert.ok(Math.abs(await evaluate('document.getElementById("template-text").getBoundingClientRect().height') - compactHeight * 2) < 1);
  await click("save-template");
  await waitText("toast", "模板已保存");
  assert.ok(await evaluate('document.getElementById("template-text").readOnly'));
  await click("template-choice-review");
  assert.match(await evaluate('document.getElementById("template-text").value'), /综述知识结构与证据关系图/);
  assert.equal(await text("template-editor-label"), "Review 精读模板");
  await click("template-text");
  await fill("template-text", "NATIVE_REVIEW_TEMPLATE\n比较主题证据与分歧，末尾给出 Mermaid 流程图。");
  await click("save-template"); await waitText("toast", "模板已保存");
  await click("template-choice-article");
  assert.match(await evaluate('document.getElementById("template-text").value'), /核心结果逐个推进/);
  check("Native Firefox saves Review separately and retains the Article template");
  await click("settings-tab-about");
  assert.equal(await evaluate('document.getElementById("settings-template").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#settings-about .pill").textContent'), "1.0.8");
  assert.equal(await evaluate('document.querySelector(".author-name").textContent'), "Xi Zhang");
  assert.equal(await evaluate('document.querySelector(".author-card a").getAttribute("href")'), "mailto:oca-john@hotmail.com");
  await writeFile(join(root, "artifacts", "qa", "firefox-about-native.png"), Buffer.from(await driver.takeScreenshot(), "base64"));
  await click("settings-tab-api");
  check("Native Settings subtabs switch correctly; the compact template expands on click and collapses on Save");
  await fill("api-key", "test-only-key");
  await fill("endpoint", server.origin);
  await click("test-api");
  await waitText("connection-status", "连接成功");
  await click("save-settings");
  await click("tab-read");
  await click("capture");
  await ready();
  await waitText("source-title", testTitle);
  assert.match(await text("source-text"), /Independent animals/);
  assert.equal(server.requests.length, 0);
  check("Native scripting permission + Readability extracted current article without API transmission");
  await click("summarize");
  await ready();
  await waitText("result-status", "已完成", 25000);
  assert.equal(server.requests.length, 1);
  assert.equal(await evaluate('document.querySelectorAll("#result img, #result script").length'), 0);
  check("Real extension CSP permits local mock SSE and sanitizes generated Markdown");
  await click("tab-history");
  await driver.wait(() => evaluate('!!document.querySelector(".history-item")'), 10000);
  check("Completed summary persisted locally");
  await click("tab-read");
  await click("show-paste");
  await fill("paste-title", "Neural plasticity: a systematic review");
  await fill("paste-text", "In this review, we synthesize evidence and compare conflicting results. ".repeat(20));
  await click("use-paste"); await ready();
  await click("read-paper-type");
  await waitText("read-type-status", "已选择：Review文章");
  await click("summarize"); await ready(); await waitText("result-status", "已完成", 25000);
  assert.match(server.requests.at(-1).body.messages[1].content, /NATIVE_REVIEW_TEMPLATE/);
  assert.doesNotMatch(server.requests.at(-1).body.messages[1].content, /核心结果逐个推进/);
  check("Native Firefox detects Review from supplied material and sends only the Review template to the local API fixture");
  // Navigate the real current web tab to Firefox's built-in PDF viewer.
  await chrome();
  await driver.executeScript(`
    gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
    });
  `, `${server.origin}/fixture/paper.pdf`);
  await sidebar();
  await driver.wait(async () => (await text("tab-title")) !== testTitle, 15000, "Current tab should change to PDF");
  await click("capture");
  await ready();
  await waitText("source-kind", "PDF · 文字", 25000);
  assert.match(await text("source-text"), /\[p\.2\]/);
  check("Direct URL from Firefox PDF viewer is downloaded and parsed");
  await evaluate('document.querySelector(".pdf-options").open = true');
  await fill("pdf-mode", "visual"); await fill("page-range", "1");
  await click("capture");
  await ready();
  await waitText("source-kind", "PDF · 图文", 25000);
  await click("summarize");
  await ready();
  await waitText("result-status", "已完成", 25000);
  assert.equal(server.requests.at(-1).body.messages[2].content.filter(p => p.type === "image_url").length, 1);
  check("Native sidebar rendered and sent one selected PDF page as a data image");
  // Exercise the fallback for PDF addresses without a .pdf suffix.
  await fill("pdf-mode", "text"); await fill("page-range", "");
  await driver.executeScript(`
    gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
    });
  `, `${server.origin}/fixture/download`);
  await driver.wait(() => driver.executeScript('return gBrowser.selectedBrowser.currentURI.spec.endsWith("/fixture/download");'), 10000);
  await driver.wait(() => evaluate('document.getElementById("tab-domain").title.endsWith("/fixture/download")'), 10000);
  await click("capture"); await ready();
  await waitText("source-kind", "PDF · 文字", 25000);
  assert.match(await text("source-text"), /\[p\.2\]/);
  check("PDF URL without extension falls back from blocked content injection to file parsing");
  await mkdir(join(root, "artifacts", "qa"), { recursive: true });
  await evaluate('document.querySelector(".pdf-options").open = false');
  await click("tab-history");
  await driver.wait(() => evaluate('document.querySelectorAll(".history-item").length >= 2'), 10000);
  await evaluate('document.querySelector(".history-item").click()');
  await evaluate('document.getElementById("result-card").scrollIntoView({block:"start"})');
  await driver.wait(() => evaluate('document.getElementById("toast").hidden'), 10000);
  await chrome();
  await writeFile(join(root, "artifacts", "qa", "firefox-native.png"), await driver.takeScreenshot(), "base64");
  report.status = "passed";
  await writeFile(join(root, "artifacts", "qa", "firefox-report.json"), JSON.stringify(report, null, 2));
  console.log(`PASS: Firefox ${report.version}, ${report.checks.length} integration checks.`);
} catch (error) {
  await mkdir(join(root, "artifacts", "qa"), { recursive: true });
  if (driver) {
    try { console.log("Failure status:", await evaluate('({error:document.getElementById("error").textContent,connection:document.getElementById("connection-status").textContent,activity:document.getElementById("activity-text").textContent})')); } catch {}
    try { await chrome(); await writeFile(join(root, "artifacts", "qa", "firefox-failure.png"), await driver.takeScreenshot(), "base64"); } catch {}
  }
  throw error;
} finally { if (driver) await driver.quit(); await server.close(); }
