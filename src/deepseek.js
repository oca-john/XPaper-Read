import { DEEPSEEK_ORIGIN, WEB_CHANNEL } from "./core/web.js";
import { fillComposer, findComposer } from "./web-composer.js";

// Runs in an isolated content-script world. Never reads cookies, storage or tokens.
if (location.origin === DEEPSEEK_ORIGIN && window.parent !== window) {
  const extension = new URL(browser.runtime.getURL("/"));
  const parentOrigin = `${extension.protocol}//${extension.host}`;
  const send = message => window.parent.postMessage({ channel: WEB_CHANNEL, ...message }, parentOrigin);
  const pageState = () => ({
    url: location.href,
    composerReady: Boolean(findComposer()),
    login: /\/(?:sign_in|sign_up|login|register)(?:\/|$)/i.test(location.pathname),
  });
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.origin !== parentOrigin || event.data?.channel !== WEB_CHANNEL) return;
    const { command, id, nonce, prompt } = event.data;
    if (typeof id !== "string" || typeof nonce !== "string") return;
    try {
      let result;
      if (command === "hello") result = pageState();
      else if (command === "fill") result = fillComposer(prompt);
      else if (command === "selection") {
        const text = window.getSelection()?.toString().trim() || "";
        if (!text) throw new Error("请先在 DeepSeek 回答中选中文字，再点“保存选中回答”；或使用“粘贴回答”。");
        if (text.length > 200000) throw new Error("选中的回答过长，请缩小选区。");
        result = { text, url: location.href };
      } else return;
      send({ id, nonce, result });
    } catch (error) { send({ id, nonce, error: error.message }); }
  });
  let previousState = "", timer;
  const announce = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = JSON.stringify(pageState());
      if (next !== previousState) { previousState = next; send({ available: true }); }
    }, 250);
  };
  // Login and new-chat transitions may happen without a document navigation.
  new MutationObserver(announce).observe(document.documentElement, { childList: true, subtree: true });
  send({ available: true });
}
