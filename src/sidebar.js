import { DEFAULT_SETTINGS, DEFAULT_ARTICLE_TEMPLATE, DEFAULT_REVIEW_TEMPLATE, LIMITS } from "./core/defaults.js";
import { selectReadingPlan, readingTypeLabel } from "./core/paper-type.js";
import { normalizeEndpoint, validateSettings, testConnection } from "./core/api.js";
import { makeManualSource, looksLikePdf, permissionOrigin, sourceText, sourceStats, sourceMeta, planReading, validateSource, publicSourceUrl } from "./core/source.js";
import { summarize } from "./core/summarize.js";
import { configurePdf, fetchPdf, extractPdf } from "./pdf.js";
import { loadSettings, saveSettings, clearKey, loadHistory, saveReading, clearHistory } from "./storage.js";
import { renderMarkdown, exportMarkdown } from "./render.js";
import { initializeWebPanel } from "./web-sidebar.js";
import { initializeAppearance } from "./appearance.js";
import { registerStaticUI, uiText, uiAttr, translate, getLanguage } from "./i18n.js";

registerStaticUI(document);

const $ = id => document.getElementById(id);
const state = { settings: { ...DEFAULT_SETTINGS }, apiKey: "", source: null, record: null, tab: null, windowId: null, busy: false, controller: null };
const baseUrl = browser.runtime.getURL("/");
configurePdf(baseUrl);
let renderTimer = null, persistTimer = null, toastTimer = null, saving = Promise.resolve();
let webPanel;
let templateEditing = false, historyAll = false, historyRevision = 0;
let templateKind = "article";
const templateDrafts = { article: "", review: "" };
const templateKey = kind => kind === "review" ? "reviewTemplate" : "template";

function toast(message) {
  uiText($("toast"), message); $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500);
}

function panel(name) {
  document.body.classList.toggle("web-layout", name === "web");
  document.body.classList.toggle("history-layout", name === "history");
  if (name !== "web") setWebFocus(false);
  if (name !== "settings") finishTemplateEditing();
  for (const el of document.querySelectorAll("[data-panel]")) {
    const active = el.dataset.panel === name;
    el.classList.toggle("active", active); el.setAttribute("aria-selected", String(active));
    $(`panel-${el.dataset.panel}`).hidden = !active;
  }
  if (name === "history") {
    historyAll = false;
    document.querySelector(".history-scroll").scrollTop = 0;
    refreshHistory().catch(showError);
  }
  if (name === "web") webPanel?.activate();
}

function setWebFocus(focused) {
  document.body.classList.toggle("web-focused", focused);
  const button = $("web-focus-toggle");
  button.setAttribute("aria-expanded", String(!focused));
  uiText(button, focused ? "展开顶部 ↓" : "收起顶部 ↑");
  uiAttr(button, "title", focused ? "显示导航、网址和阅读工具" : "折叠顶部工具，让会话占满侧栏");
  document.querySelector(".web-content").scrollTop = 0;
}

function selectSettingsSection(sectionId) {
  finishTemplateEditing();
  for (const button of document.querySelectorAll("[data-settings-section]")) {
    const active = button.dataset.settingsSection === sectionId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    $(button.dataset.settingsSection).hidden = !active;
  }
  for (const footer of document.querySelectorAll("[data-settings-footer]")) {
    footer.hidden = footer.dataset.settingsFooter !== sectionId;
  }
  const hints = {
    "settings-appearance": "（即时生效 · 自动保存）",
    "settings-template": "（修改后需保存）",
    "settings-api": "（使用自己的 API）",
    "settings-about": "（把阅读变成理解）"
  };
  uiText($("settings-footer-hint"), hints[sectionId]);
  document.querySelector(".settings-scroll").scrollTop = 0;
}

function openSettings(sectionId) {
  panel("settings");
  selectSettingsSection(sectionId);
  $(sectionId).focus({ preventScroll: true });
}

function editTemplate(kind = "article") {
  openSettings("settings-template");
  selectTemplate(kind === "review" ? "review" : "article");
}

function selectTemplate(kind) {
  templateDrafts[templateKind] = $("template-text").value;
  finishTemplateEditing();
  templateKind = kind;
  $("template-text").value = templateDrafts[kind];
  for (const button of document.querySelectorAll("[data-template-kind]")) {
    const active = button.dataset.templateKind === kind;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  uiText($("template-editor-label"), kind === "review" ? "Review 精读模板" : "Article 精读模板");
  updateTemplateHint();
}

function updateTemplateHint() {
  const changed = $("template-text").value.trim() !== state.settings[templateKey(templateKind)];
  uiText($("template-edit-status"), templateEditing
    ? "编辑中 · 点击保存模板后生效；点击外部可收起。"
    : changed ? "有未保存的修改。点击模板可继续编辑，点击保存后生效。"
      : "点击文本框展开编辑，点击外部收起。修改后需保存模板。");
}

function startTemplateEditing() {
  templateEditing = true;
  $("template-text").readOnly = false;
  $("template-text").classList.add("is-editing");
  updateTemplateHint();
}

function finishTemplateEditing() {
  templateEditing = false;
  const field = $("template-text");
  field.readOnly = true;
  field.classList.remove("is-editing");
  field.scrollTop = 0;
  field.scrollLeft = 0;
  updateTemplateHint();
}

function showError(error) {
  $("error").hidden = false;
  uiText($("error"), error.name === "AbortError" ? "已停止。可以调整材料或设置后重新开始。" : (error.message || String(error)));
}

function clearError() { $("error").hidden = true; uiText($("error"), ""); }
function progress(text) { uiText($("activity-text"), text); }

function busy(value, text = "正在处理…") {
  state.busy = value;
  for (const el of document.querySelectorAll("[data-idle], .history-item")) el.disabled = value;
  $("activity").hidden = !value;
  $("summarize").disabled = value || !state.source;
  $("pdf-mode").disabled = value; $("page-range").disabled = value; $("capture-kind").disabled = value;
  progress(text);
}

function authorize(url) {
  // Invoked directly by the click handler, before any asynchronous work.
  try {
    return browser.permissions.request({ origins: [permissionOrigin(url)] }).then(granted => {
      if (!granted) throw new Error("未获得此站点的访问权限。可以重新授权，或改为导入 PDF / 粘贴正文。");
    });
  } catch (error) { return Promise.reject(error); }
}

async function runRead(permission, task) {
  if (state.busy) return;
  clearError(); busy(true, "正在读取文献…");
  $("read-paper-type").value = "auto";
  state.source = null; showSource();
  state.controller = new AbortController();
  try {
    await permission;
    state.controller.signal.throwIfAborted();
    const source = await task(state.controller.signal);
    state.controller.signal.throwIfAborted();
    validateSource(source);
    source.id ||= crypto.randomUUID();
    state.source = source; state.record = null;
    showSource(); showResult();
  } catch (error) { showError(error); }
  finally { state.controller = null; busy(false); }
}

function pdfOptions(signal, title, url = "") {
  return { signal, title, url, pageRange: $("page-range").value, visual: $("pdf-mode").value === "visual", baseUrl, onProgress: progress };
}

async function readPdfUrl(url, signal, title) {
  progress("正在获取 PDF 原文件…");
  const data = await fetchPdf(url, { signal });
  return extractPdf(data, pdfOptions(signal, title || "PDF 文献", url));
}

async function captureTab(tab, mode, signal) {
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    throw new Error("此标签页不能直接读取。本地 PDF 请使用“导入 PDF”；浏览器内部页面请改为粘贴正文。");
  }
  if (mode === "pdf" || (mode === "auto" && looksLikePdf(tab.url))) return readPdfUrl(tab.url, signal, tab.title);
  const before = await browser.tabs.get(tab.id);
  if (before.url !== tab.url) throw new Error("页面已变化，请等页面加载完成后重新读取。");
  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["extract.js"] });
    const result = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: (options) => globalThis.XPaperCapture.capture(options),
      args: [{ selectionOnly: mode === "selection" }],
    });
    signal.throwIfAborted();
    const source = result[0]?.result;
    if (!source) throw new Error("未能提取正文，请导入 PDF 或粘贴文字。");
    if (source.url !== tab.url) throw new Error("读取期间页面发生变化，请重新读取。");
    return source;
  } catch (error) {
    if (signal.aborted || mode === "selection") throw error;
    // A PDF need not have a .pdf suffix. The built-in viewer blocks injection.
    if (/permission|access|restricted|Missing host|execute script|inject|禁止|权限/i.test(error.message)) {
      return readPdfUrl(tab.url, signal, tab.title);
    }
    throw error;
  }
}

function showSource() {
  const source = state.source;
  updateReadingType();
  $("source-card").hidden = !source;
  $("summarize").disabled = !source || state.busy;
  if (!source) {
    uiText($("send-info"), "读取后可先核对原文，再发送给模型。");
    return;
  }
  const stats = sourceStats(source);
  uiText($("source-kind"), source.kind === "pdf" ? (stats.images ? "PDF · 图文" : "PDF · 文字") : source.kind === "manual" ? "粘贴材料" : "网页正文");
  uiText($("source-count"), `${stats.chars.toLocaleString()} 字符${stats.images ? ` · ${stats.images} 张图` : ""}`);
  $("source-title").textContent = source.title;
  uiText($("source-scope"), source.scope);
  $("source-warnings").replaceChildren(...(source.warnings || []).map(w => { const li = document.createElement("li"); uiText(li, w); return li; }));
  $("source-text").textContent = sourceText(source);
  $("source-images").replaceChildren();
  $("source-preview").open = false;
  uiText($("preview-label"), stats.images ? ` · 含 ${stats.images} 页图片` : "");
  const linked = source.pdfCandidates?.[0];
  $("pdf-link-row").hidden = !linked;
  uiText($("pdf-link-host"), linked ? `来源：${new URL(linked).hostname}。读取时会请求该站点权限。` : "");
  updateTabChange(); updateSendInfo();
}

function updateReadingType() {
  const plan = selectReadingPlan(state.source || {}, state.settings, $("read-paper-type").value);
  uiText($("read-type-status"), state.source ? readingTypeLabel(plan) : "读取材料后自动判断 Article / Review，也可手动选择。");
  const labels = !state.source || plan.type === "unknown" ? ["先判断文章类型，再使用对应精读框架。"]
    : plan.type === "review" ? ["综述范围", "组织框架", "主题证据", "共识分歧", "缺口贡献"]
      : ["领域问题", "设计巧思", "实施路径", "结果链条", "研究贡献"];
  $("reading-framework").replaceChildren();
  for (const [index, label] of labels.entries()) {
    if (index) { const arrow = document.createElement("i"); arrow.textContent = "→"; $("reading-framework").append(arrow); }
    const span = document.createElement("span"); uiText(span, label); $("reading-framework").append(span);
  }
}

function updateSendInfo() {
  $("key-notice").hidden = !!state.apiKey;
  if (!state.source) return;
  const plan = planReading(state.source);
  const host = new URL(normalizeEndpoint(state.settings.endpoint)).host;
  uiText($("send-info"), `发送至 ${host} · ${state.settings.model} · ${plan.chars.toLocaleString()} 字符${plan.images ? ` + ${plan.images} 页图片` : ""}。${plan.direct ? "预计 1 次请求" : `分段阅读，预计 ${plan.calls} 次请求`}，按 API 用量计费。`);
}

function updateTabChange() {
  $("tab-changed").hidden = !state.source?.url || !state.tab?.url || state.source.url === state.tab.url;
}

async function refreshTab() {
  if (state.windowId == null) state.windowId = (await browser.windows.getCurrent()).id;
  const tabs = await browser.tabs.query({ active: true, windowId: state.windowId });
  state.tab = tabs[0] || null;
  if (state.tab?.title) $("tab-title").textContent = state.tab.title;
  else uiText($("tab-title"), "打开一篇学术文章");
  $("tab-domain").title = state.tab?.url || "";
  try { uiText($("tab-domain"), new URL(state.tab.url).hostname || "本地文件 / 浏览器页面"); }
  catch { uiText($("tab-domain"), "可导入 PDF 或粘贴正文"); }
  updateTabChange();
  webPanel?.refreshTab(state.tab);
}

function showResult() {
  const r = state.record;
  $("result-card").hidden = !r;
  $("empty-state").hidden = !!r;
  $("copy-result").disabled = !r?.content;
  $("export-result").disabled = !r?.content;
  if (!r) return;
  $("result-title").textContent = r.source.title;
  uiText($("result-status"), r.status === "imported" ? "已导入" : r.status === "complete" ? "已完成" : r.status === "running" && state.busy ? "生成中" : "部分结果");
  const total = r.usage?.total_tokens;
  uiText($("result-meta"), `${translate(r.model)} · ${translate(r.method || "正在整理")}${total ? ` · ${total.toLocaleString()} tokens` : ""}${r.error ? ` · ${translate(r.error)}` : ""}`);
  renderMarkdown($("result"), r.content || translate("正在梳理文献，请稍候…"));
}

function persistRecord() {
  if (!state.record?.content) return saving;
  const copy = structuredClone(state.record);
  saving = saving.catch(() => {}).then(() => saveReading(copy));
  return saving;
}

function streamUpdate(delta) {
  state.record.content += delta;
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; showResult(); }, 120);
  if (!persistTimer) persistTimer = setTimeout(() => {
    persistTimer = null;
    persistRecord().catch(() => toast("本机记录保存失败，请及时导出当前笔记。"));
  }, 1000);
}

async function generate(permission) {
  if (state.busy) return;
  clearError();
  try { validateSettings(state.settings, state.apiKey); validateSource(state.source); }
  catch (error) {
    // Consume the permission promise even if validation fails.
    permission.catch(() => {});
    showError(error);
    if (!state.apiKey) { openSettings("settings-api"); $("api-key").focus({ preventScroll: true }); toast("请先填写并保存 API Key。"); }
    return;
  }
  busy(true, "准备发送材料…");
  state.controller = new AbortController();
  try {
    await permission;
    state.controller.signal.throwIfAborted();
    const { source, settings, apiKey } = state;
    const paperType = $("read-paper-type").value;
    const readingPlan = selectReadingPlan(source, settings, paperType);
    state.record = {
      id: crypto.randomUUID(), source: sourceMeta(source), model: settings.model,
      createdAt: new Date().toISOString(), content: "", status: "running", method: "",
      template: readingPlan.template, readingPlan,
    };
    showResult();
    const result = await summarize(source, settings, apiKey, {
      signal: state.controller.signal, onDelta: streamUpdate, onProgress: progress, paperType,
    });
    Object.assign(state.record, result, { status: "complete" });
  } catch (error) {
    if (state.record?.status === "running") {
      state.record.status = "partial";
      state.record.error = error.name === "AbortError" ? "已停止" : error.message;
    }
    showError(error);
  } finally {
    clearTimeout(renderTimer); clearTimeout(persistTimer); renderTimer = persistTimer = null;
    state.controller = null; busy(false); showResult();
    await persistRecord().catch(() => toast("保存记录失败，请导出笔记以免丢失。"));
  }
}

function fillSettings() {
  $("api-key").value = state.apiKey;
  $("remember-key").checked = state.settings.rememberKey;
  $("endpoint").value = state.settings.endpoint;
  $("model").value = state.settings.model;
  $("thinking").checked = state.settings.thinking;
  $("max-tokens").value = String(state.settings.maxTokens);
  templateDrafts.article = state.settings.template;
  templateDrafts.review = state.settings.reviewTemplate;
  $("template-text").value = templateDrafts[templateKind];
  finishTemplateEditing();
  updateSendInfo();
}

function readSettings() {
  return {
    ...state.settings, endpoint: normalizeEndpoint($("endpoint").value),
    model: $("model").value.trim(), rememberKey: $("remember-key").checked,
    thinking: $("thinking").checked, maxTokens: Number($("max-tokens").value),
  };
}

async function refreshHistory() {
  const revision = ++historyRevision;
  const history = await loadHistory();
  if (revision !== historyRevision) return;
  const visible = historyAll ? history : history.slice(0, LIMITS.historyPreview);
  uiText($("history-show-all"), historyAll ? "最近 5 条" : `全部记录（${history.length}）`);
  $("history-show-all").setAttribute("aria-pressed", String(historyAll));
  uiText($("history-summary"), `${historyAll ? "显示全部" : "显示最近"} ${visible.length} 条 · 共 ${history.length} 条。最多保留 ${LIMITS.history} 条阅读记录。`);
  const list = $("history-list");
  list.replaceChildren();
  if (!history.length) {
    const empty = document.createElement("p"); empty.className = "history-empty";
    uiText(empty, "还没有阅读记录。完成第一篇精读后，笔记会出现在这里。"); list.append(empty);
  }
  for (const item of visible) {
    const button = document.createElement("button"); button.className = "history-item"; button.disabled = state.busy;
    const title = document.createElement("strong"); title.textContent = item.source.title;
    const info = document.createElement("small");
    info.textContent = `${new Date(item.createdAt).toLocaleString(getLanguage(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${translate(item.model)} · ${translate(item.status === "imported" ? "已导入" : item.status === "complete" ? "已完成" : "部分结果")}`;
    button.append(title, info);
    button.addEventListener("click", () => {
      if (state.busy) return;
      state.record = item; showResult(); clearError(); panel("read");
      $("result-card").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    list.append(button);
  }
}

for (const button of document.querySelectorAll("[data-panel]")) button.addEventListener("click", () => panel(button.dataset.panel));
const settingsTabs = [...document.querySelectorAll("[data-settings-section]")];
for (const button of settingsTabs) {
  button.addEventListener("click", () => selectSettingsSection(button.dataset.settingsSection));
  button.addEventListener("keydown", event => {
    const index = settingsTabs.indexOf(button);
    const next = event.key === "ArrowRight" ? (index + 1) % settingsTabs.length
      : event.key === "ArrowLeft" ? (index + settingsTabs.length - 1) % settingsTabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? settingsTabs.length - 1 : null;
    if (next == null) return;
    event.preventDefault();
    selectSettingsSection(settingsTabs[next].dataset.settingsSection);
    settingsTabs[next].focus();
  });
}
$("web-focus-toggle").addEventListener("click", () => setWebFocus(!document.body.classList.contains("web-focused")));
$("history-show-all").addEventListener("click", () => {
  historyAll = !historyAll;
  document.querySelector(".history-scroll").scrollTop = 0;
  refreshHistory().catch(showError);
});
$("template-text").addEventListener("focus", startTemplateEditing);
$("template-text").addEventListener("click", startTemplateEditing);
$("template-text").addEventListener("input", updateTemplateHint);
$("template-text").addEventListener("keydown", event => {
  if (event.key === "Tab" || event.key === "Escape") finishTemplateEditing();
  if (event.key === "Escape") { event.preventDefault(); $("settings-template").focus({ preventScroll: true }); }
});
// Collapse after the outside click is delivered, so a Save button below the
// editor cannot move out from under the pointer before its click fires.
document.addEventListener("click", event => {
  if (templateEditing && event.target !== $("template-text") && !event.target.closest?.('label[for="template-text"]')) finishTemplateEditing();
});
window.addEventListener("blur", () => { if (templateEditing) finishTemplateEditing(); });
$("edit-template").addEventListener("click", () => editTemplate(selectReadingPlan(state.source || {}, state.settings, $("read-paper-type").value).type));
$("read-paper-type").addEventListener("change", updateReadingType);
const templateChoices = [...document.querySelectorAll("[data-template-kind]")];
for (const button of templateChoices) {
  button.addEventListener("click", () => selectTemplate(button.dataset.templateKind));
  button.addEventListener("keydown", event => {
    const index = templateChoices.indexOf(button);
    const next = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key) ? 1 - index
      : event.key === "Home" ? 0 : event.key === "End" ? 1 : null;
    if (next == null) return;
    event.preventDefault(); selectTemplate(templateChoices[next].dataset.templateKind); templateChoices[next].focus();
  });
}
$("go-settings").addEventListener("click", () => openSettings("settings-api"));
$("capture").addEventListener("click", () => {
  if (state.busy) return;
  const tab = state.tab, mode = $("capture-kind").value;
  const permission = authorize(tab?.url || "");
  runRead(permission, signal => captureTab(tab, mode, signal));
});
$("read-linked-pdf").addEventListener("click", () => {
  if (state.busy) return;
  const url = state.source.pdfCandidates[0], title = state.source.title;
  runRead(authorize(url), signal => readPdfUrl(url, signal, title));
});
$("import-pdf").addEventListener("click", () => $("pdf-file").click());
$("pdf-file").addEventListener("change", () => {
  const file = $("pdf-file").files[0];
  $("pdf-file").value = "";
  if (!file) return;
  runRead(Promise.resolve(), async signal => {
    if (file.size > LIMITS.pdfBytes) throw new Error("PDF 超过 40 MB，请使用较小的文件。");
    return extractPdf(new Uint8Array(await file.arrayBuffer()), pdfOptions(signal, file.name));
  });
});
$("show-paste").addEventListener("click", () => { $("paste-box").hidden = false; $("paste-text").focus(); });
$("cancel-paste").addEventListener("click", () => { $("paste-box").hidden = true; });
$("use-paste").addEventListener("click", () => runRead(Promise.resolve(), async () => {
  const source = makeManualSource($("paste-text").value, $("paste-title").value);
  $("paste-box").hidden = true;
  return source;
}));
$("summarize").addEventListener("click", () => {
  if (state.busy) return;
  // Missing credentials shouldn't cause an unnecessary host permission prompt.
  generate(state.apiKey ? authorize(state.settings.endpoint) : Promise.resolve());
});
$("stop").addEventListener("click", () => { state.controller?.abort(); progress("正在停止…"); });
$("source-preview").addEventListener("toggle", () => {
  if (!$("source-preview").open || $("source-images").childElementCount || !state.source) return;
  for (const block of state.source.blocks.filter(b => b.image)) {
    const figure = document.createElement("figure"), img = document.createElement("img"), caption = document.createElement("figcaption");
    img.src = block.image; img.alt = `PDF ${block.label}`; img.loading = "lazy"; caption.textContent = block.label;
    figure.append(img, caption); $("source-images").append(figure);
  }
});
$("save-template").addEventListener("click", async () => {
  finishTemplateEditing();
  const template = $("template-text").value.trim();
  if (!template || template.length > 20000) { toast("模板不能为空，且不能超过 20,000 字符。"); return; }
  const kind = templateKind;
  $("save-template").disabled = true;
  try {
    const settings = { ...state.settings, [templateKey(kind)]: template };
    await saveSettings(settings, state.apiKey); state.settings = settings;
    updateTemplateHint();
    updateReadingType();
    webPanel?.refreshPrompt();
    toast("模板已保存，网页版提示词与 API 精读已更新。");
  } catch { toast("保存失败，请检查本地存储。"); }
  finally { $("save-template").disabled = state.busy; }
});
$("reset-template").addEventListener("click", () => { $("template-text").value = templateKind === "review" ? DEFAULT_REVIEW_TEMPLATE : DEFAULT_ARTICLE_TEMPLATE; finishTemplateEditing(); toast("默认模板已载入，点击保存后生效。"); });
$("settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const settings = readSettings(), apiKey = $("api-key").value.trim();
    validateSettings(settings, apiKey);
    await saveSettings(settings, apiKey);
    state.settings = settings; state.apiKey = apiKey;
    updateSendInfo(); toast("设置已保存。");
  } catch (error) { toast(error.message); }
});
$("toggle-key").addEventListener("click", () => {
  const reveal = $("api-key").type === "password";
  $("api-key").type = reveal ? "text" : "password"; uiText($("toggle-key"), reveal ? "隐藏" : "显示");
});
$("forget-key").addEventListener("click", async () => {
  try { await clearKey(); state.apiKey = ""; $("api-key").value = ""; updateSendInfo(); toast("已清除本机和当前会话中的 Key。"); }
  catch { toast("清除失败，请重试。"); }
});
$("test-api").addEventListener("click", async () => {
  const box = $("connection-status"); box.hidden = false;
  uiText(box, "正在测试连接…");
  box.scrollIntoView({ block: "nearest" });
  try {
    const settings = readSettings(), key = $("api-key").value.trim();
    validateSettings(settings, key);
    const permission = authorize(settings.endpoint);
    $("test-api").disabled = true;
    await permission;
    const result = await testConnection(settings, key);
    uiText(box, result.available ? `连接成功，模型 ${settings.model} 可用。记得保存设置。` : `连接成功，但模型列表未列出 ${settings.model}。请核对名称。`);
    if (result.models.length) $("models").replaceChildren(...result.models.map(id => { const option = document.createElement("option"); option.value = id; return option; }));
  } catch (error) { uiText(box, error.name === "TimeoutError" ? "连接超时，请检查网络。" : (error.message || "连接失败")); }
  finally { $("test-api").disabled = state.busy; }
});
$("copy-result").addEventListener("click", async () => {
  if (!state.record?.content) return;
  try { await navigator.clipboard.writeText(exportMarkdown(state.record)); toast("笔记已复制。"); }
  catch { toast("复制失败，可使用“导出 Markdown”。"); }
});
$("export-result").addEventListener("click", () => {
  if (!state.record?.content) return;
  const url = URL.createObjectURL(new Blob([exportMarkdown(state.record)], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url;
  a.download = `${(state.record.source.title || "文献笔记").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 90)}.md`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
});
$("clear-history").addEventListener("click", () => {
  $("clear-confirm").hidden = false;
  $("clear-confirm").scrollIntoView({ block: "nearest" });
});
$("cancel-clear").addEventListener("click", () => { $("clear-confirm").hidden = true; });
$("confirm-clear").addEventListener("click", async () => {
  try { await saving.catch(() => {}); await clearHistory(); $("clear-confirm").hidden = true; await refreshHistory(); toast("阅读记录已清空。"); }
  catch { toast("清空失败，请重试。"); }
});
browser.tabs.onActivated.addListener(info => { if (info.windowId === state.windowId) refreshTab().catch(() => {}); });
browser.tabs.onUpdated.addListener((id, change) => { if (id === state.tab?.id && (change.url || change.title || change.status === "complete")) refreshTab().catch(() => {}); });
window.addEventListener("pagehide", () => {
  if (state.record?.status === "running") { state.record.status = "partial"; state.record.error = "侧栏已关闭，任务中止"; }
  clearTimeout(persistTimer);
  state.controller?.abort();
  persistRecord().catch(() => {});
});

async function init() {
  await initializeAppearance({ toast, onLanguageChange: () => {
    if (state.record) showResult();
    if (!$("panel-history").hidden) refreshHistory().catch(showError);
    uiText($("toggle-key"), $("api-key").type === "password" ? "显示" : "隐藏");
  } });
  const loaded = await loadSettings();
  state.settings = loaded.settings; state.apiKey = loaded.apiKey;
  // Validate persisted endpoint before using it in the interface.
  try { state.settings.endpoint = normalizeEndpoint(state.settings.endpoint); }
  catch { state.settings.endpoint = DEFAULT_SETTINGS.endpoint; }
  fillSettings();
  webPanel = initializeWebPanel({
    getSettings: () => state.settings, getTab: () => state.tab, toast, onEditTemplate: editTemplate,
    onRecord: record => {
      if (state.busy) { panel("history"); return; }
      state.record = record; showResult(); panel("read"); $("result-card").scrollIntoView({ block: "start" });
    },
  });
  await refreshTab();
  const history = await loadHistory();
  if (history.length) { state.record = history[0]; showResult(); }
}
init().catch(showError);
