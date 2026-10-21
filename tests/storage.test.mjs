import test from "node:test";
import assert from "node:assert/strict";
import { loadSettings, loadHistory, saveReading, clearHistory } from "../src/storage.js";
import { DEFAULT_TEMPLATE, DEFAULT_REVIEW_TEMPLATE, LEGACY_DEFAULT_TEMPLATE } from "../src/core/defaults.js";

function mockStorage(t) {
  const local = { settings: { template: "保留我的模板" }, apiKey: "test-only-key" };
  const previous = globalThis.browser;
  globalThis.browser = { storage: { local: {
    get: async () => structuredClone(local),
    set: async values => Object.assign(local, structuredClone(values)),
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key]; },
  }, session: { get: async () => ({ apiKey: "session-only-key" }) } } };
  t.after(() => { if (previous === undefined) delete globalThis.browser; else globalThis.browser = previous; });
  return local;
}

test("old preset upgrades to the detailed diagram template without overwriting custom templates or credentials", async t => {
  const local = mockStorage(t);
  local.settings = { template: LEGACY_DEFAULT_TEMPLATE, model: "custom-model", rememberKey: true };
  let loaded = await loadSettings();
  assert.equal(loaded.settings.template, DEFAULT_TEMPLATE);
  assert.match(loaded.settings.template, /Mermaid \/ Graphviz/);
  assert.equal(loaded.settings.model, "custom-model");
  assert.equal(loaded.apiKey, "test-only-key");
  assert.equal(local.settings.template, LEGACY_DEFAULT_TEMPLATE, "reading settings must not overwrite concurrent changes");
  local.settings.template += "\n用户补充：逐图讲解。";
  loaded = await loadSettings();
  assert.equal(loaded.settings.template, local.settings.template);
  delete local.settings;
  loaded = await loadSettings();
  assert.equal(loaded.settings.template, DEFAULT_TEMPLATE);
  assert.equal(loaded.apiKey, "session-only-key");
});

test("notes retain the newest thirty, update existing records without duplication and preserve settings", async t => {
  const local = mockStorage(t);
  for (let i = 0; i < 35; i++) {
    await saveReading({ id: String(i), createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), content: `记录 ${i}`, status: "complete" });
  }
  assert.equal(Object.keys(local).filter(key => key.startsWith("reading:")).length, 30);
  assert.equal(local["reading:4"], undefined);
  assert.ok(local["reading:5"]);
  let history = await loadHistory();
  assert.deepEqual(history.map(item => item.id), Array.from({ length: 30 }, (_, i) => String(34 - i)));
  await saveReading({ ...history[3], content: "更新内容" });
  history = await loadHistory();
  assert.equal(history.length, 30);
  assert.equal(history[3].content, "更新内容");
  assert.equal(local.settings.template, "保留我的模板");
  assert.equal(local.apiKey, "test-only-key");
});

test("legacy custom template becomes Article while Review defaults independently; both custom templates survive reload", async t => {
  const local = mockStorage(t);
  const before = structuredClone(local);
  let loaded = await loadSettings();
  assert.equal(loaded.settings.template, "保留我的模板");
  assert.equal(loaded.settings.reviewTemplate, DEFAULT_REVIEW_TEMPLATE);
  assert.deepEqual(local, before, "migration is read-only until a user saves");
  local.settings.reviewTemplate = "我的综述证据地图";
  loaded = await loadSettings();
  assert.equal(loaded.settings.template, "保留我的模板");
  assert.equal(loaded.settings.reviewTemplate, "我的综述证据地图");
  assert.equal(loaded.apiKey, "session-only-key");
});

test("clearing notes removes only reading records", async t => {
  const local = mockStorage(t);
  await saveReading({ id: "one", createdAt: new Date().toISOString(), content: "记录" });
  await clearHistory();
  assert.deepEqual(await loadHistory(), []);
  assert.deepEqual(local, { settings: { template: "保留我的模板" }, apiKey: "test-only-key" });
});
