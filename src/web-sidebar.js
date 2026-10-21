import { buildWebPrompt, prepareWebSource, DEEPSEEK_URL, DEEPSEEK_ORIGIN, WEB_CHANNEL, isDeepSeekUrl } from "./core/web.js";
import { saveReading } from "./storage.js";
import { uiText } from "./i18n.js";
import { selectReadingPlan, readingTypeLabel } from "./core/paper-type.js";

export function initializeWebPanel({ getSettings, getTab, onRecord, onEditTemplate, toast }) {
  const $ = id => document.getElementById(id);
  const frame = $("web-frame");
  const nonce = crypto.randomUUID(), pending = new Map();
  let connected = false, composerReady = false, loaded = false, handshakeTimer, statusTimer;
  let source = null, lastTabUrl = "", lastReading = null, noteSource = null;
  let lastTabTitle = "", followingTab = true;
  let filling = false, conversationUrl = DEEPSEEK_URL, helloRevision = 0;

  function status(message, error = false) {
    // Keep connection changes accessible without a permanent visual status row.
    uiText($("web-status"), message);
    if (error) toast(message);
  }
  function updateButtons() {
    $("web-fill").disabled = !connected || !composerReady || !source || filling;
    $("web-selection").disabled = !connected;
    $("web-copy-prompt").disabled = !source;
    $("web-copy-url").disabled = !source;
  }
  function refreshPrompt() {
    try {
      source = prepareWebSource($("web-url").value, $("web-title").value);
      const plan = selectReadingPlan(source, getSettings(), $("web-paper-type").value);
      $("web-prompt").value = buildWebPrompt(source, getSettings(), plan.mode);
      uiText($("web-type-status"), readingTypeLabel(plan));
      $("web-paper-title").textContent = source.title;
      $("web-paper-title").title = source.url;
      $("web-domain").textContent = new URL(source.url).hostname;
      uiText($("web-source-hint"), source.warnings.join(" ") || "仅提供网址和模板。发送前请开启 DeepSeek 的联网搜索；没有取得全文时，需在聊天框上传 PDF。");
    } catch (error) {
      source = null; $("web-prompt").value = "";
      uiText($("web-source-hint"), error.message);
      $("web-domain").textContent = "";
      uiText($("web-type-status"), "类型待确认，模型取得材料后先判断再选模板");
      uiText($("web-paper-title"), "打开论文网页，或在下方填写网址");
    }
    updateButtons();
  }
  function useTab(tab = getTab()) {
    if (!tab?.url || isDeepSeekUrl(tab.url)) return;
    if (tab.url !== lastTabUrl) $("web-paper-type").value = "auto";
    $("web-url").value = tab.url; $("web-title").value = tab.title || "当前文献";
    lastTabUrl = tab.url; lastTabTitle = tab.title || ""; followingTab = true;
    refreshPrompt();
    if (source) $("web-url").value = source.url;
  }
  function refreshTab(tab) {
    if (tab?.url && !isDeepSeekUrl(tab.url) && (tab.url !== lastTabUrl || (followingTab && (tab.title || "") !== lastTabTitle))) useTab(tab);
  }
  function readingSnapshot() {
    const captured = structuredClone(source);
    const readingPlan = selectReadingPlan(captured, getSettings(), $("web-paper-type").value);
    return { source: captured, template: readingPlan.template, readingPlan };
  }
  function send(command, extra = {}, timeout = 6000) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("侧栏网页未响应。请刷新，或复制提示词后粘贴到聊天框。")); }, timeout);
      pending.set(id, { resolve, reject, timer });
      frame.contentWindow.postMessage({ channel: WEB_CHANNEL, nonce, id, command, ...extra }, DEEPSEEK_ORIGIN);
    });
  }
  function hello() {
    const revision = ++helloRevision;
    send("hello", {}, 2500).then(result => {
      if (revision !== helloRevision) return;
      connected = true; clearInterval(handshakeTimer); clearTimeout(statusTimer);
      composerReady = Boolean(result.composerReady);
      if (isDeepSeekUrl(result.url)) conversationUrl = result.url;
      updateButtons();
      status(result.login ? "请在此登录，或在 Firefox 标签页登录后刷新。登录状态由 DeepSeek 和 Firefox 管理。" : composerReady ? "网页版已就绪。填入提示后可直接在下方发送；不调用模型 API。" : "网页已连接，尚未出现聊天输入框。若下方持续空白，请先在标签页打开 DeepSeek，再刷新侧栏。");
    }).catch(() => {});
  }
  window.addEventListener("message", event => {
    if (event.source !== frame.contentWindow || event.origin !== DEEPSEEK_ORIGIN || event.data?.channel !== WEB_CHANNEL) return;
    if (event.data.available) { hello(); return; }
    if (event.data.nonce !== nonce) return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id); clearTimeout(request.timer);
    if (event.data.error) request.reject(new Error(String(event.data.error)));
    else request.resolve(event.data.result || {});
  });
  frame.addEventListener("load", () => {
    if (!loaded) return;
    connected = false; composerReady = false; updateButtons(); clearInterval(handshakeTimer); clearTimeout(statusTimer);
    hello();
    handshakeTimer = setInterval(hello, 3000);
    statusTimer = setTimeout(() => {
      clearInterval(handshakeTimer);
      if (!connected) status("未能连接网页工具。若下方为空白或验证页面，请先在标签页完成登录/验证后刷新；也可使用复制提示词。", true);
    }, 18000);
  });
  async function load(permission) {
    try {
      if (!await permission) throw new Error("打开内嵌 DeepSeek 需要该站点权限。可点击“打开 DeepSeek 侧栏”重试。");
      helloRevision++;
      connected = false; composerReady = false; loaded = true; updateButtons();
      $("web-placeholder").hidden = true; frame.hidden = false;
      status("正在加载 DeepSeek 网页…");
      frame.src = conversationUrl;
    } catch (error) { status(error.message, true); }
  }
  $("web-connect").addEventListener("click", () => load(browser.permissions.request({ origins: [`${DEEPSEEK_ORIGIN}/*`] })));
  $("web-reload").addEventListener("click", () => load(browser.permissions.request({ origins: [`${DEEPSEEK_ORIGIN}/*`] })));
  $("web-login").addEventListener("click", () => {
    browser.tabs.create({ url: DEEPSEEK_URL }).catch(error => status(error.message, true));
  });
  $("web-fill").addEventListener("click", async () => {
    if (!source || filling) return;
    const reading = readingSnapshot();
    const prompt = buildWebPrompt(reading.source, getSettings(), reading.readingPlan.mode);
    filling = true; updateButtons();
    try {
      const result = await send("fill", { prompt });
      lastReading = reading;
      status(result.message); toast("网址与模板已填入，请在 DeepSeek 网页中发送。");
    } catch (error) { status(error.message, true); }
    finally { filling = false; updateButtons(); }
  });
  async function copy(text, message) {
    try { await navigator.clipboard.writeText(text); toast(message); }
    catch { status("复制失败。可展开“网址与提示词”手动选择并复制。", true); }
  }
  $("web-copy-url").addEventListener("click", () => { if (source) copy(source.url, "论文网址已复制。"); });
  $("web-copy-prompt").addEventListener("click", () => {
    if (!source) return;
    lastReading = readingSnapshot();
    copy($("web-prompt").value, "结构化提示词已复制。");
  });
  $("web-use-current").addEventListener("click", () => {
    if (isDeepSeekUrl(getTab()?.url)) { toast("当前主窗口是 DeepSeek，请切回论文标签页。"); return; }
    useTab();
  });
  for (const id of ["web-title", "web-url"]) $(id).addEventListener("input", () => {
    followingTab = false;
    $("web-paper-type").value = "auto";
    refreshPrompt();
  });
  $("web-paper-type").addEventListener("change", refreshPrompt);
  $("web-edit-template").addEventListener("click", () => onEditTemplate(selectReadingPlan(source || {}, getSettings(), $("web-paper-type").value).type));

  function editNote(text = "") {
    noteSource = lastReading || (source ? readingSnapshot() : null);
    uiText($("web-note-source"), noteSource ? `保存来源：${noteSource.source.title} · ${noteSource.source.url}。请确认回答属于这篇论文。` : "未绑定论文链接：将作为手动导入的 DeepSeek 笔记保存。");
    $("web-note-editor").hidden = false; $("web-note-editor").open = true;
    $("web-answer").value = text;
  }
  $("web-selection").addEventListener("click", async () => {
    try {
      const result = await send("selection");
      if (typeof result.text !== "string" || !result.text.trim()) throw new Error("没有读取到选中的文字。");
      if (result.text.length > 200000) throw new Error("选中的回答过长。");
      if (isDeepSeekUrl(result.url)) conversationUrl = result.url;
      editNote(result.text); toast("已读取选中文字，请核对来源后保存。选择文字可能不保留表格排版；可改用网页的复制回答按钮。");
    } catch (error) { status(error.message, true); }
  });
  $("web-paste-note").addEventListener("click", () => {
    editNote($("web-answer").value); $("web-answer").focus();
  });
  $("web-cancel-note").addEventListener("click", () => { $("web-note-editor").hidden = true; });
  $("web-save-note").addEventListener("click", async () => {
    const content = $("web-answer").value.trim();
    if (!content || content.length > 200000) { status("请粘贴有效的回答（不超过 200,000 字符）。", true); return; }
    const record = {
      id: crypto.randomUUID(), createdAt: new Date().toISOString(), content, status: "imported",
      model: "DeepSeek 网页版", method: "网页版回答 · 手动核对导入",
      source: noteSource?.source || { title: "DeepSeek 阅读笔记", url: "", scope: "用户导入的网页版回答；未绑定原文", warnings: [] },
      template: noteSource?.template || getSettings().template,
      readingPlan: noteSource?.readingPlan || null,
    };
    try {
      $("web-save-note").disabled = true;
      await saveReading(record); $("web-note-editor").hidden = true;
      onRecord(record); toast("已保存为本机笔记，可复制或导出 Markdown。");
    } catch (error) { status(error.message, true); }
    finally { $("web-save-note").disabled = false; }
  });
  refreshPrompt();
  browser.permissions.contains({ origins: [`${DEEPSEEK_ORIGIN}/*`] }).then(granted => {
    if (granted) load(Promise.resolve(true));
    else status("点击下方按钮启用 DeepSeek 网页侧栏。");
  }).catch(() => status("点击下方按钮启用 DeepSeek 网页侧栏。"));
  window.addEventListener("pagehide", () => {
    clearInterval(handshakeTimer); clearTimeout(statusTimer);
    for (const request of pending.values()) clearTimeout(request.timer);
    pending.clear();
  });
  return { refreshTab, refreshPrompt, activate: () => { if (loaded) hello(); } };
}
