import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { prepareWebSource, buildWebPrompt, allowSidebarFrame, DEEPSEEK_ORIGIN } from "../src/core/web.js";
import { DEFAULT_TEMPLATE } from "../src/core/defaults.js";
import { findComposer, fillComposer } from "../src/web-composer.js";

test("web prompts preserve article identifiers, remove credentials and require access verification", () => {
  const source = prepareWebSource("https://journal.example/download?id=paper42&format=pdf&token=secret&utm_source=mail#p2", "A study\nTitle");
  assert.equal(source.url, "https://journal.example/download?id=paper42&format=pdf");
  assert.equal(source.title, "A study Title");
  assert.equal(source.warnings.length, 1);
  const prompt = buildWebPrompt(source, DEFAULT_TEMPLATE);
  assert.ok(prompt.includes(DEFAULT_TEMPLATE));
  assert.match(prompt, /实际阅读范围/);
  assert.match(prompt, /停止精读/);
  assert.match(prompt, /不能|不臆测/);
  assert.ok(!prompt.includes("secret"));
  for (const url of ["file:///c:/paper.pdf", "blob:https://example.org/a", "about:blank", "javascript:alert(1)", "https://user:pass@example.org", DEEPSEEK_ORIGIN]) {
    assert.throws(() => prepareWebSource(url));
  }
  assert.throws(() => buildWebPrompt(source, ""));
});

test("frame compatibility is restricted to the direct sidebar child and preserves other CSP rules", () => {
  const sidebar = "moz-extension://local-uuid/sidebar.html";
  const headers = [
    { name: "X-Frame-Options", value: "DENY" },
    { name: "Content-Security-Policy", value: "default-src 'self'; frame-ancestors 'none'; script-src 'nonce-123'; connect-src https://api.example" },
    { name: "Content-Security-Policy", value: "frame-ancestors 'self', frame-ancestors https://other.example; object-src 'none'" },
    { name: "Set-Cookie", value: "session=untouched; Secure; HttpOnly" },
    { name: "Content-Security-Policy-Report-Only", value: "frame-ancestors 'none'" },
  ];
  const request = { url: `${DEEPSEEK_ORIGIN}/sign_in`, type: "sub_frame", frameAncestors: [{ url: sidebar }], responseHeaders: headers };
  const result = allowSidebarFrame(request, sidebar).responseHeaders;
  assert.equal(result.length, 4);
  assert.equal(result[0].value, "default-src 'self'; frame-ancestors 'self' moz-extension://local-uuid; script-src 'nonce-123'; connect-src https://api.example");
  assert.equal(result[1].value, "frame-ancestors 'self' moz-extension://local-uuid, frame-ancestors 'self' moz-extension://local-uuid; object-src 'none'");
  assert.strictEqual(result[2], headers[3], "cookies are neither parsed nor modified");
  assert.strictEqual(result[3], headers[4]);
  assert.equal(headers[0].value, "DENY", "do not mutate the incoming object");
  for (const patch of [
    { type: "main_frame" },
    { url: "https://other.example/" },
    { frameAncestors: [{ url: "https://evil.example" }, { url: sidebar }] },
    { frameAncestors: [{ url: "moz-extension://other/sidebar.html" }] },
    { frameAncestors: [{ url: `${sidebar}.spoof` }] },
    { frameAncestors: [] },
  ]) assert.equal(allowSidebarFrame({ ...request, ...patch }, sidebar), undefined);
});

function composerDom(markup, path = "/") {
  const dom = new JSDOM(markup, { url: `${DEEPSEEK_ORIGIN}${path}` });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", { value: () => [{ width: 300, height: 90 }] });
  return dom;
}

test("composer works with controlled textareas, never sends, and never overwrites a draft", () => {
  const dom = composerDom('<textarea id="chat-input" placeholder="给 DeepSeek 发送消息"></textarea><button id="send">发送</button>');
  const { document } = dom.window;
  const input = document.querySelector("textarea");
  let updates = 0, submits = 0;
  input.addEventListener("input", () => updates++);
  document.querySelector("button").addEventListener("click", () => submits++);
  const prompt = "研究问题\nhttps://example.org/?id=123\n<script>bad()</script>";
  fillComposer(prompt, document);
  assert.equal(input.value, prompt);
  assert.equal(updates, 1);
  fillComposer(prompt, document);
  assert.equal(updates, 1, "retries are idempotent");
  assert.throws(() => fillComposer("replace", document), /已有草稿/);
  assert.equal(input.value, prompt);
  assert.equal(submits, 0);
  assert.equal(document.querySelectorAll("script").length, 0);
  dom.window.close();
});

test("composer supports plain contenteditable but rejects login and ambiguous inputs", () => {
  const editable = composerDom('<div role="textbox" contenteditable="true" aria-label="Message DeepSeek"></div>');
  fillComposer("hello\nworld", editable.window.document);
  assert.equal(editable.window.document.querySelector("div").textContent, "hello\nworld");
  editable.window.close();
  for (const [html, path] of [
    ['<textarea id="chat-input"></textarea>', "/sign_in"],
    ["<textarea></textarea><textarea></textarea>", "/"],
    ['<textarea style="display:none"></textarea>', "/"],
    ['<textarea readonly></textarea>', "/"],
  ]) {
    const dom = composerDom(html, path);
    assert.equal(findComposer(dom.window.document), null);
    dom.window.close();
  }
});

test("web mode has no API request path and the bridge does not read login credentials", async () => {
  const ui = await readFile(new URL("../src/web-sidebar.js", import.meta.url), "utf8");
  const bridge = await readFile(new URL("../src/deepseek.js", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /streamCompletion|fetch\(|apiKey|Authorization/);
  assert.doesNotMatch(bridge, /document\.cookie|localStorage|sessionStorage|browser\.cookies/);
  assert.match(bridge, /event\.source !== window\.parent/);
  assert.match(bridge, /event\.origin !== parentOrigin/);
  assert.match(ui, /event\.source !== frame\.contentWindow/);
  assert.match(ui, /event\.data\.nonce !== nonce/);
});
