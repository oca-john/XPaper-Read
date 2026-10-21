import { DEFAULT_SETTINGS, DEFAULT_TEMPLATE, LEGACY_DEFAULT_TEMPLATE, LIMITS } from "./core/defaults.js";

export async function loadSettings() {
  const local = await browser.storage.local.get(["settings", "apiKey"]);
  const session = await browser.storage.session.get("apiKey");
  const settings = { ...DEFAULT_SETTINGS, ...local.settings };
  if (typeof settings.template === "string" && settings.template.replaceAll("\r\n", "\n").trim() === LEGACY_DEFAULT_TEMPLATE.trim()) {
    settings.template = DEFAULT_TEMPLATE;
  }
  return {
    settings,
    apiKey: local.settings?.rememberKey ? (local.apiKey || "") : (session.apiKey || ""),
  };
}

export async function saveSettings(settings, apiKey) {
  await browser.storage.local.set({ settings });
  if (settings.rememberKey) {
    await browser.storage.local.set({ apiKey });
    await browser.storage.session.remove("apiKey");
  } else {
    await browser.storage.session.set({ apiKey });
    await browser.storage.local.remove("apiKey");
  }
}

export async function clearKey() {
  await browser.storage.local.remove("apiKey");
  await browser.storage.session.remove("apiKey");
}

export async function loadHistory() {
  // Separate keys avoid two browser windows overwriting each other's history.
  const all = await browser.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith("reading:")).map(([, v]) => v)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, LIMITS.history);
}

export async function saveReading(record) {
  await browser.storage.local.set({ [`reading:${record.id}`]: record });
  const all = await browser.storage.local.get(null);
  const records = Object.entries(all).filter(([k]) => k.startsWith("reading:"))
    .sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt));
  const expired = records.slice(LIMITS.history).map(([key]) => key);
  if (expired.length) await browser.storage.local.remove(expired);
}

export async function clearHistory() {
  const all = await browser.storage.local.get(null);
  await browser.storage.local.remove(Object.keys(all).filter(k => k.startsWith("reading:")));
}
