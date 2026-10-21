import { DEFAULT_APPEARANCE, normalizeAppearance, iconPath } from "./core/appearance.js";
import { setLanguage } from "./i18n.js";

export async function initializeAppearance({ onLanguageChange = () => {}, toast }) {
  let appearance = normalizeAppearance((await browser.storage.local.get("appearance")).appearance);
  let writes = Promise.resolve(), pendingWrites = 0;
  const choices = [
    ["[data-language-choice]", "language", "languageChoice"],
    ["[data-theme-choice]", "theme", "themeChoice"],
    ["[data-accent-choice]", "accent", "accentChoice"],
  ];
  const browserScheme = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme() {
    document.documentElement.dataset.themePreference = appearance.theme;
    document.documentElement.dataset.theme = appearance.theme === "browser"
      ? (browserScheme.matches ? "dark" : "light") : appearance.theme;
  }
  browserScheme.addEventListener("change", () => {
    if (appearance.theme === "browser") applyTheme();
  });
  function apply(next) {
    appearance = normalizeAppearance(next);
    const root = document.documentElement;
    applyTheme();
    root.dataset.accent = appearance.accent;
    for (const image of document.querySelectorAll(".brand img,.theme-logo")) image.src = iconPath(appearance.accent);
    for (const [selector, key, field] of choices) {
      for (const button of document.querySelectorAll(selector)) {
        const selected = button.dataset[field] === appearance[key];
        button.classList.toggle("active", selected);
        button.setAttribute("aria-checked", String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
    }
    setLanguage(appearance.language, document);
    onLanguageChange();
  }
  function change(patch) {
    const next = normalizeAppearance({ ...appearance, ...patch });
    apply(next);
    pendingWrites++;
    writes = writes.catch(() => {}).then(() => browser.storage.local.set({ appearance: next }))
      .catch(() => toast("外观保存失败，请重试。"))
      .finally(() => { pendingWrites--; });
  }
  for (const [selector, key, field] of choices) {
    const buttons = [...document.querySelectorAll(selector)];
    buttons.forEach((button, index) => {
      button.addEventListener("click", () => change({ [key]: button.dataset[field] }));
      button.addEventListener("keydown", event => {
        const next = ["ArrowRight", "ArrowDown"].includes(event.key) ? (index + 1) % buttons.length
          : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (index + buttons.length - 1) % buttons.length
            : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
        if (next == null) return;
        event.preventDefault(); buttons[next].focus(); buttons[next].click();
      });
    });
  }
  document.getElementById("reset-appearance").addEventListener("click", () => {
    change(DEFAULT_APPEARANCE); toast("外观已恢复默认。");
  });
  // Another sidebar/window may change appearance. Local pending choices win
  // until the serialized writes finish; saving API/template cannot replace them.
  browser.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.appearance && !pendingWrites) apply(changes.appearance.newValue);
  });
  apply(appearance);
}
