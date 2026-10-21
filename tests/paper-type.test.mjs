import test from "node:test";
import assert from "node:assert/strict";
import { detectPaperType, selectReadingPlan } from "../src/core/paper-type.js";
import { DEFAULT_SETTINGS, DEFAULT_REVIEW_TEMPLATE } from "../src/core/defaults.js";
import { buildWebPrompt, prepareWebSource } from "../src/core/web.js";
import { summarize } from "../src/core/summarize.js";
import { planReading } from "../src/core/source.js";
import { fillComposer } from "../src/web-composer.js";
import { JSDOM } from "jsdom";

const settings = { ...DEFAULT_SETTINGS, template: "ARTICLE_CUSTOM_ONLY", reviewTemplate: "REVIEW_CUSTOM_ONLY" };
const source = (title, text = "Synthetic paper evidence. ".repeat(30)) => ({ title, kind: "manual", scope: "Supplied excerpt", metadata: {}, blocks: [{ label: "§1", text }] });

test("type detection uses explicit publisher types, recognizable review titles and self-descriptions", () => {
  for (const title of ["Auditory plasticity: a review", "A systematic review of randomized controlled trials", "Neural dynamics: a meta-analysis", "听觉皮层可塑性研究进展", "Mechanisms: an integrative review"]) {
    assert.equal(detectPaperType(source(title)).type, "review", title);
  }
  assert.equal(detectPaperType({ metadata: { articleType: "Review" } }).type, "review");
  assert.equal(detectPaperType({ metadata: { articleType: "research-article" } }).type, "article");
  assert.equal(detectPaperType({ metadata: { articleType: "Journal Article" } }).type, "unknown");
  assert.equal(detectPaperType(source("New perspectives", "In this review, we synthesize the evidence.")).type, "review");
  assert.equal(detectPaperType(source("新视角", "本文系统综述了不同主题的证据。")).type, "review");
  assert.equal(detectPaperType({ ...source("A trial"), kind: "pdf", blocks: [{ label: "p.1", text: "RESEARCH ARTICLE\nA trial" }] }).type, "article");
});

test("ambiguous signals, selected passages, middle PDF pages and conflicting metadata do not force a template", () => {
  for (const title of ["Peer review improves reporting", "A retrospective chart review", "A survey of patients", "Mechanisms | Nature Reviews", "The role of reviewers", "Protocol for a randomized controlled trial", "New evidence"]) {
    assert.equal(detectPaperType(source(title, "Previous reviews discussed these results. References cite systematic reviews.")).type, "unknown", title);
  }
  const partial = source("Paper", "In this review, we summarize all evidence.");
  assert.equal(detectPaperType({ ...partial, scope: "仅选中的文字" }).type, "unknown");
  assert.equal(detectPaperType({ ...partial, kind: "pdf", blocks: [{ label: "p.5", text: partial.blocks[0].text }] }).type, "unknown");
  assert.equal(detectPaperType(source("Paper", "Main text\nReferences\nIn this review we synthesize evidence.")).type, "unknown");
  const conflict = detectPaperType({ ...source("A systematic review"), metadata: { articleType: "Original Article" } });
  assert.deepEqual(conflict, { type: "unknown", reason: "conflict" });
});

test("routing selects one saved template when known or manually set, otherwise instructs classification before choosing", () => {
  const review = source("Hearing: a systematic review");
  const automatic = selectReadingPlan(review, settings);
  assert.equal(automatic.type, "review");
  assert.match(automatic.template, /REVIEW_CUSTOM_ONLY/);
  assert.doesNotMatch(automatic.template, /ARTICLE_CUSTOM_ONLY/);
  const manual = selectReadingPlan(review, settings, "article");
  assert.equal(manual.reason, "manual");
  assert.match(manual.template, /ARTICLE_CUSTOM_ONLY/);
  assert.doesNotMatch(manual.template, /REVIEW_CUSTOM_ONLY/);
  const pending = selectReadingPlan(source("Unclear"), settings);
  assert.equal(pending.type, "unknown");
  assert.match(pending.template, /先判断文章类型/);
  assert.match(pending.template, /ARTICLE_CUSTOM_ONLY/);
  assert.match(pending.template, /REVIEW_CUSTOM_ONLY/);
  assert.match(pending.template, /不混合两套栏目/);
  assert.match(pending.template, /不默认套用 Article/);
});

test("web prompts default to Article and use only the user-selected template without classification", () => {
  const review = prepareWebSource("https://papers.example/42", "Neural plasticity: a review");
  const defaultPrompt = buildWebPrompt(review, settings);
  assert.match(defaultPrompt, /ARTICLE_CUSTOM_ONLY/);
  assert.doesNotMatch(defaultPrompt, /REVIEW_CUSTOM_ONLY|先判断文章类型|判断依据|初判|复核|类型.*冲突/);
  assert.equal(buildWebPrompt(review, settings, "auto"), defaultPrompt);
  const prompt = buildWebPrompt(review, settings, "review");
  assert.match(prompt, /REVIEW_CUSTOM_ONLY/);
  assert.doesNotMatch(prompt, /ARTICLE_CUSTOM_ONLY/);
  assert.match(prompt, /无法访问正文/);
  assert.doesNotMatch(prompt, /先判断文章类型|判断依据|初判|复核|类型.*冲突/);
  assert.match(buildWebPrompt(prepareWebSource("https://papers.example/unknown"), settings, "review"), /REVIEW_CUSTOM_ONLY/);
  assert.match(buildWebPrompt(review, { ...settings, reviewTemplate: "" }), /ARTICLE_CUSTOM_ONLY/);
  assert.throws(() => buildWebPrompt(review, { ...settings, reviewTemplate: "" }, "review"));
});

test("web prompts with a maximum-length selected template and URL fit the composer", () => {
  const prompt = buildWebPrompt(prepareWebSource("https://papers.example/?id=" + "a".repeat(7900)), { template: "A".repeat(20000), reviewTemplate: "R".repeat(20000) }, "review");
  const dom = new JSDOM('<textarea id="chat-input"></textarea>', { url: "https://chat.deepseek.com/" });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", { value: () => [{ width: 300, height: 90 }] });
  fillComposer(prompt, dom.window.document);
  assert.equal(dom.window.document.querySelector("textarea").value, prompt);
  assert.ok(prompt.length < 60000);
  assert.doesNotMatch(prompt, /A{20000}/);
  dom.window.close();
});

test("Review preset handles subtype, evidence provenance, disagreements and hierarchical diagram source", () => {
  for (const pattern of [/叙述性/, /PRISMA/, /不强行/, /未读过被引原文/, /重复队列/, /异质性/, /共识/, /逐项结果/, /未来验证/, /flowchart TD/, /digraph Review/, /方法流程图/, /局部.*主题.*综合结论/, /不生成猜测性图/]) assert.match(DEFAULT_REVIEW_TEMPLATE, pattern);
});

test("direct API reviews and manual overrides use the correct template without an extra classification request", async () => {
  for (const [mode, expected, excluded] of [["auto", "REVIEW_CUSTOM_ONLY", "ARTICLE_CUSTOM_ONLY"], ["article", "ARTICLE_CUSTOM_ONLY", "REVIEW_CUSTOM_ONLY"]]) {
    const calls = [];
    const result = await summarize(source("Hearing: a review"), settings, "test-only", { paperType: mode, complete: async ({ messages }) => {
      calls.push(messages); return { content: "Synthetic result" };
    } });
    assert.equal(calls.length, 1);
    assert.ok(calls[0][1].content.includes(expected));
    assert.ok(!calls[0][1].content.includes(excluded));
    assert.equal(result.readingPlan.mode, mode);
  }
});

test("long reviews retain review-specific evidence through mapping, reduction and synthesis with unchanged call estimates", async () => {
  const review = source("Neural mechanisms: a systematic review");
  review.blocks = Array.from({ length: 6 }, (_, i) => ({ label: `p.${i + 1}`, text: "e".repeat(18000) }));
  const calls = [];
  const result = await summarize(review, settings, "test-only", { complete: async ({ messages }) => {
    calls.push(messages); return { content: "Synthetic review evidence [p.1]", usage: { total_tokens: 4 } };
  } });
  assert.equal(calls.length, planReading(review).calls);
  assert.equal(result.requests, calls.length);
  assert.equal(result.readingPlan.type, "review");
  for (const messages of calls.slice(0, -1)) {
    assert.match(messages[1].content, /按 Review 保留/);
    assert.match(messages[1].content, /引用编号/);
    assert.match(messages[1].content, /共识与矛盾/);
    assert.doesNotMatch(messages[1].content, /按 Article 保留|ARTICLE_CUSTOM_ONLY/);
  }
  assert.match(calls.at(-1)[1].content, /REVIEW_CUSTOM_ONLY/);
  assert.doesNotMatch(calls.at(-1)[1].content, /ARTICLE_CUSTOM_ONLY/);
});
