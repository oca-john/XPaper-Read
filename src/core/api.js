import { templateFor } from "./paper-type.js";

export function normalizeEndpoint(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new Error("API 地址格式不正确。"); }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("API 地址必须使用 HTTPS；本机 localhost / 127.0.0.1 可使用 HTTP。");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("API 地址不能包含用户名、密码、查询参数或片段。");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return `${url.origin}${path}`;
}

export function validateSettings(settings, apiKey) {
  normalizeEndpoint(settings.endpoint);
  if (!apiKey?.trim()) throw new Error("请在设置中填写 API Key。");
  if (/[\r\n]/.test(apiKey)) throw new Error("API Key 不能包含换行。");
  if (!settings.model?.trim()) throw new Error("请填写模型名称。");
  if (!settings.template?.trim()) throw new Error("总结模板不能为空。");
  if (settings.template.length > 20000) throw new Error("模板过长，请保持在 20,000 字符以内。");
  templateFor(settings, "review");
  if (!Number.isInteger(settings.maxTokens) || settings.maxTokens < 1024 || settings.maxTokens > 32768) {
    throw new Error("最大输出 token 应在 1024–32768 之间。");
  }
}

export function friendlyHttpError(status) {
  const messages = {
    400: "请求参数被拒绝。请核对模型名称；图文模式需要支持图片输入的模型。",
    401: "API Key 无效或已失效，请在设置中更新。",
    402: "API 余额不足。网页聊天与 API 账户计费可能不同，请检查开放平台余额。",
    403: "API 拒绝访问，请检查账户、模型和接口权限。",
    404: "找不到接口或模型，请核对 API 地址和模型名称。",
    413: "请求过大，请减少文献页数或改用文字模式。",
    422: "API 无法处理请求，请核对模型和参数。",
    429: "请求达到频率或配额限制，请稍后重试。",
    500: "模型服务暂时出错，请稍后重试。",
    502: "模型服务网关暂时不可用，请稍后重试。",
    503: "模型服务繁忙，请稍后重试。",
  };
  return messages[status] || `API 请求失败（HTTP ${status}）。`;
}

// Incremental SSE parser. Frames may cross both UTF-8 and network boundaries.
export function createSseParser(onData) {
  let buffer = "";
  return {
    push(text, final = false) {
      buffer += text;
      if (buffer.length > 2 * 1024 * 1024) throw new Error("接口流格式异常：单条事件过大。");
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        dispatch(event);
      }
      if (final && buffer.trim()) { dispatch(buffer); buffer = ""; }
    },
  };
  function dispatch(event) {
    const data = event.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
    if (data) onData(data);
  }
}

export function completionPayload(settings, messages, maxTokens = settings.maxTokens) {
  const body = { model: settings.model.trim(), messages, stream: true, max_tokens: maxTokens };
  // Only the official endpoint receives DeepSeek-specific fields.
  if (new URL(normalizeEndpoint(settings.endpoint)).hostname === "api.deepseek.com") {
    body.thinking = { type: settings.thinking ? "enabled" : "disabled" };
  }
  return body;
}

export async function streamCompletion({ settings, apiKey, messages, maxTokens, signal, onDelta = () => {}, onThinking = () => {}, fetchFn = fetch }) {
  const controller = new AbortController();
  let timeoutReason = "";
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  let idleTimer;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timeoutReason = "接口超过 120 秒未响应，请稍后重试。"; controller.abort(); }, 120000);
  };
  const totalTimer = setTimeout(() => { timeoutReason = "本次请求超过 10 分钟，已停止。"; controller.abort(); }, 600000);
  touch();
  let reader;
  try {
    const response = await fetchFn(`${normalizeEndpoint(settings.endpoint)}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify(completionPayload(settings, messages, maxTokens)),
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
    });
    if (!response.ok) throw new Error(friendlyHttpError(response.status));
    let content = "", finishReason = null, usage = null, done = false;
    const accept = (packet) => {
      if (packet.error) throw new Error("模型服务返回错误，已保留收到的部分内容。");
      if (packet.usage) usage = packet.usage;
      const choice = packet.choices?.[0];
      const delta = choice?.delta || choice?.message;
      if (typeof delta?.content === "string") { content += delta.content; onDelta(delta.content); }
      if (delta?.reasoning_content) onThinking();
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    };
    if (response.headers.get("content-type")?.includes("application/json")) {
      accept(await response.json());
      done = true;
    } else {
      if (!response.body) throw new Error("接口没有返回可读取的内容。");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser(data => {
        if (data.trim() === "[DONE]") { done = true; return; }
        let packet;
        try { packet = JSON.parse(data); } catch { throw new Error("接口返回了不完整的流数据，已保留部分内容。"); }
        accept(packet);
      });
      while (true) {
        const next = await reader.read(); touch();
        if (next.done) { parser.push(decoder.decode(), true); break; }
        parser.push(decoder.decode(next.value, { stream: true }));
        if (done) break;
      }
      if (!done && !finishReason) throw new Error("连接提前中断，当前结果不完整，请重试。");
    }
    if (finishReason === "length") throw new Error("达到输出 token 上限，结果不完整。请提高最大输出 token 或关闭深度思考后重试。");
    if (finishReason && finishReason !== "stop") throw new Error(`模型未正常完成（${String(finishReason).slice(0, 60)}），结果不完整。`);
    if (!content.trim()) throw new Error("模型未返回正文。可关闭深度思考或提高输出 token 后重试。");
    return { content, usage };
  } catch (error) {
    if (timeoutReason) throw new Error(timeoutReason);
    if (signal?.aborted || error.name === "AbortError") throw new DOMException("已停止生成。", "AbortError");
    if (error instanceof TypeError) throw new Error("连接失败，请检查网络、API 地址和站点权限。");
    throw error;
  } finally {
    clearTimeout(idleTimer); clearTimeout(totalTimer);
    signal?.removeEventListener("abort", abort);
    if (reader) await reader.cancel().catch(() => {});
  }
}

export async function testConnection(settings, apiKey, fetchFn = fetch) {
  validateSettings(settings, apiKey);
  const response = await fetchFn(`${normalizeEndpoint(settings.endpoint)}/models`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(friendlyHttpError(response.status));
  const data = await response.json();
  const models = (Array.isArray(data.data) ? data.data : []).map(m => m.id).filter(x => typeof x === "string");
  return { models, available: models.includes(settings.model.trim()) };
}
