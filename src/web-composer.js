export function findComposer(doc = document) {
  if (/\/(?:sign_in|sign_up|login|register)(?:\/|$)/i.test(doc.location.pathname)) return null;
  const candidates = [...doc.querySelectorAll('textarea, [contenteditable="true"][role="textbox"]')].filter(el => {
    const style = doc.defaultView.getComputedStyle(el);
    return !el.disabled && !el.readOnly && el.getAttribute("aria-disabled") !== "true"
      && style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0
      && !el.closest('nav, [role="search"], [aria-hidden="true"]');
  });
  const preferred = candidates.filter(el => el.id === "chat-input" || /deepseek|message|发送|消息|提问/i.test(`${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""}`));
  if (preferred.length === 1) return preferred[0];
  return candidates.length === 1 ? candidates[0] : null;
}

export function fillComposer(prompt, doc = document) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 60000) throw new Error("提示词为空或过长，请检查模板。");
  const el = findComposer(doc);
  if (!el) throw new Error("没有找到聊天输入框。请先完成登录并打开对话；也可复制提示词后手动粘贴。");
  const existing = el.tagName === "TEXTAREA" ? el.value : el.textContent;
  if (existing === prompt) return { message: "提示词已在输入框中。检查联网搜索选项后，点击 DeepSeek 的发送按钮。" };
  if (existing.trim()) throw new Error("输入框中已有草稿，已保留。请先发送或清空草稿，再填入提示词。");
  const win = doc.defaultView;
  el.focus();
  if (el.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, prompt);
  } else {
    el.replaceChildren(doc.createTextNode(prompt));
  }
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
  const value = el.tagName === "TEXTAREA" ? el.value : el.textContent;
  if (value !== prompt) throw new Error("网页未接受填入的文字，请使用“复制提示词”后手动粘贴。");
  return { message: "已填入网址和模板。检查联网搜索选项后，点击 DeepSeek 的发送按钮。" };
}
