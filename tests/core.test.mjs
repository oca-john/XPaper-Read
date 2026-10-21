import test from "node:test";
import assert from "node:assert/strict";
import { createSseParser, normalizeEndpoint, streamCompletion, completionPayload, testConnection } from "../src/core/api.js";
import { makeManualSource, parsePageRange, planReading, publicSourceUrl, permissionOrigin, splitBlocks, validateSource } from "../src/core/source.js";
import { summarize, summaryMessages } from "../src/core/summarize.js";
import { DEFAULT_SETTINGS } from "../src/core/defaults.js";

const settings = { ...DEFAULT_SETTINGS };
const paper = () => makeManualSource("A controlled experiment reports a change in the response. ".repeat(50), "Test paper");
const key = "test-only-key";
const frame = (text, finish = null) => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish }] })}\r\n\r\n`;
const response = (text, byteSize = 3) => {
  const data = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < data.length; i += byteSize) controller.enqueue(data.slice(i, i + byteSize));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
};

test("endpoint validation protects credentials and preserves /v1", () => {
  assert.equal(normalizeEndpoint("https://api.deepseek.com/v1/chat/completions/"), "https://api.deepseek.com/v1");
  assert.equal(normalizeEndpoint("http://localhost:8181/v1"), "http://localhost:8181/v1");
  for (const url of ["http://evil.example", "https://key@evil.example", "https://host/?key=secret", "javascript:alert(1)"]) assert.throws(() => normalizeEndpoint(url));
  assert.equal(permissionOrigin("http://127.0.0.1:8181/paper"), "http://127.0.0.1/*");
  assert.equal(publicSourceUrl("https://journal.example/paper?token=secret#private"), "https://journal.example/paper");
});

test("PDF page selection validates boundaries, de-duplicates, sorts", () => {
  assert.deepEqual(parsePageRange("3,1-2,2", 6), [1, 2, 3]);
  assert.deepEqual(parsePageRange("", 2), [1, 2]);
  for (const value of ["0", "4-2", "7", "1,a", "1,", "-3"]) assert.throws(() => parsePageRange(value, 6));
});

test("chunking preserves every character, origin label and each image exactly once", () => {
  const blocks = [{ label: "p.1", text: "甲".repeat(100), image: "data:1" }, { label: "p.2", text: "乙".repeat(101), image: "data:2" }];
  const chunks = splitBlocks(blocks, 30, 1);
  assert.equal(chunks.flat().map(x => x.text).join(""), blocks.map(x => x.text).join(""));
  assert.equal(chunks.flat().filter(x => x.image).length, 2);
  assert.ok(chunks.every(c => c.reduce((n, b) => n + b.text.length, 0) <= 30));
  assert.ok(chunks.flat().every(b => ["p.1", "p.2"].includes(b.label)));
});

test("oversized source is rejected rather than silently truncated", () => {
  const source = paper();
  source.blocks[0].text = "a".repeat(400001);
  assert.throws(() => validateSource(source), /未截断/);
});

test("SSE parser handles split CRLF, multi-line payloads, comments, EOF", () => {
  const values = [];
  const parser = createSseParser(x => values.push(x));
  parser.push(": keep alive\r\n\r");
  parser.push("\ndata: first\r\ndata: second\r\n\r");
  parser.push("\ndata: end", true);
  assert.deepEqual(values, ["first\nsecond", "end"]);
});

test("stream decodes fragmented UTF-8 and captures usage without sending cookies", async () => {
  let request, output = "";
  const result = await streamCompletion({
    settings, apiKey: key, messages: [], onDelta: x => { output += x; },
    fetchFn: async (url, options) => {
      request = { url, ...options };
      return response(`: keep-alive\n\n${frame("研究")}${frame("结果", "stop")}data: {"choices":[],"usage":{"total_tokens":51}}\n\ndata: [DONE]\n\n`, 1);
    },
  });
  assert.equal(result.content, "研究结果"); assert.equal(output, "研究结果");
  assert.equal(result.usage.total_tokens, 51);
  assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "error");
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(JSON.parse(request.body).thinking.type, "disabled");
});

test("truncated connections and output limits preserve deltas but fail completion", async () => {
  for (const [stream, expected] of [[frame("partial"), /提前中断/], [frame("partial", "length"), /token 上限/]]) {
    let output = "";
    await assert.rejects(streamCompletion({
      settings, apiKey: key, messages: [], onDelta: x => { output += x; },
      fetchFn: async () => response(stream),
    }), expected);
    assert.equal(output, "partial");
  }
});

test("malformed stream and HTTP errors expose actionable messages, never raw provider data", async () => {
  await assert.rejects(streamCompletion({ settings, apiKey: key, messages: [], fetchFn: async () => response("data: broken-json\n\n") }), /不完整/);
  await assert.rejects(streamCompletion({ settings, apiKey: key, messages: [], fetchFn: async () => new Response("private account detail", { status: 401 }) }), /Key 无效/);
});

test("a stream error after final content is not reported as success", async () => {
  await assert.rejects(streamCompletion({
    settings, apiKey: key, messages: [], fetchFn: async () => response(`${frame("partial")}\ndata: {"error":{"message":"secret"}}\n\n`),
  }), /服务返回错误/);
});

test("cancellation propagates to the network request", async () => {
  const controller = new AbortController();
  const pending = streamCompletion({
    settings, apiKey: key, messages: [], signal: controller.signal,
    fetchFn: async (_, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("custom compatible endpoints do not receive DeepSeek-specific parameters", () => {
  const body = completionPayload({ ...settings, endpoint: "https://provider.example/v1", thinking: true }, []);
  assert.equal(body.thinking, undefined);
});

test("connection test uses models endpoint and never sends paper content", async () => {
  let options;
  const result = await testConnection(settings, key, async (url, opts) => {
    assert.equal(url, "https://api.deepseek.com/models"); options = opts;
    return Response.json({ data: [{ id: "deepseek-flash" }] });
  });
  assert.ok(result.available); assert.equal(options.body, undefined);
});

test("prompt uses the user's five questions and records evidence boundaries", () => {
  const messages = summaryMessages(paper(), settings.template);
  assert.match(messages[1].content, /研究解决了什么领域问题/);
  assert.match(messages[1].content, /创新设计或巧思/);
  assert.match(messages[1].content, /怎么逐步实施/);
  assert.match(messages[1].content, /核心结果逐个推进/);
  assert.match(messages[1].content, /为什么能发表到该期刊/);
  assert.match(messages[1].content, /子问题.*小问题/);
  assert.match(messages[1].content, /原子结果/);
  assert.match(messages[1].content, /Mermaid \/ Graphviz/);
  assert.match(messages[1].content, /flowchart TD/);
  assert.match(messages[1].content, /图完成后不再追加解释文字/);
  assert.match(messages[0].content, /不是指令/);
  assert.match(messages[2].content, /\[§1\]/);
});

test("visual prompt maps each image to its source page", () => {
  const source = paper();
  source.blocks = [{ label: "p.7", text: "figure legend", image: "data:image/jpeg;base64,abc" }];
  const msg = summaryMessages(source, settings.template)[2];
  assert.equal(msg.content[2].image_url.url, source.blocks[0].image);
  assert.match(msg.content[1].text, /\[p\.7\]/);
});

test("long documents cover all chunks and all reduction levels; call estimate is exact", async () => {
  const source = paper();
  source.blocks = Array.from({ length: 21 }, (_, i) => ({ label: `p.${i + 1}`, text: `${i}:` + "x".repeat(17000) }));
  const plan = planReading(source); const seen = [];
  const result = await summarize(source, settings, key, {
    complete: async ({ messages, onDelta }) => {
      seen.push(messages); onDelta?.("final");
      return { content: "evidence [p.1]", usage: { total_tokens: 7 } };
    },
  });
  assert.ok(!plan.direct); assert.equal(seen.length, plan.calls);
  assert.equal(result.requests, plan.calls); assert.equal(result.usage.total_tokens, 7 * plan.calls);
  assert.ok(seen.slice(0, 21).every((m, i) => m[2].content.includes(`[p.${i + 1}]`)));
  assert.ok(seen.slice(0, 21).every(m => m[1].content.includes("逐项原子结果") || m[1].content.includes("逐项保留原子结果")));
  assert.match(seen.at(-1)[1].content, /分层流程图/);
});

test("cancelling between map chunks stops subsequent paid requests", async () => {
  const controller = new AbortController(), source = paper();
  source.blocks = [{ label: "p.1", text: "a".repeat(55000) }];
  let count = 0;
  await assert.rejects(summarize(source, settings, key, {
    signal: controller.signal,
    complete: async () => { count++; controller.abort(); return { content: "partial" }; },
  }), { name: "AbortError" });
  assert.equal(count, 1);
});
