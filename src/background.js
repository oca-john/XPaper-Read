import { allowSidebarFrame } from "./core/web.js";
import { normalizeAppearance, iconPath } from "./core/appearance.js";

let appearanceUpdates = Promise.resolve();
function updateAppearance(value) {
  const appearance = normalizeAppearance(value);
  appearanceUpdates = appearanceUpdates.catch(() => {}).then(() => Promise.all([
    browser.browserAction.setIcon({ path: iconPath(appearance.accent) }),
    browser.sidebarAction.setIcon({ path: iconPath(appearance.accent) }),
    browser.browserAction.setTitle({ title: appearance.language === "en" ? "Open XPaper-Read" : "打开 XPaper-Read" }),
  ])).catch(() => {});
}
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.appearance) updateAppearance(changes.appearance.newValue);
});
browser.storage.local.get("appearance").then(({ appearance }) => updateAppearance(appearance)).catch(() => {});

// Keep this synchronous: Firefox requires sidebarAction.open in a user gesture.
browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.open().catch(() => {});
});

browser.webRequest.onHeadersReceived.addListener(
  details => allowSidebarFrame(details, browser.runtime.getURL("sidebar.html")),
  { urls: ["https://chat.deepseek.com/*"], types: ["sub_frame"] },
  ["blocking", "responseHeaders"],
);
