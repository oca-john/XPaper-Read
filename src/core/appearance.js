export const DEFAULT_APPEARANCE = Object.freeze({ language: "zh-CN", theme: "browser", accent: "blue" });
export const PALETTES = Object.freeze({
  red: { background: "#fee2e2", ink: "#991b1b" },
  yellow: { background: "#fef3c7", ink: "#854d0e" },
  green: { background: "#dcfce7", ink: "#166534" },
  blue: { background: "#dbeafe", ink: "#1e40af" },
  purple: { background: "#f3e8ff", ink: "#6b21a8" },
  gray: { background: "#e5e7eb", ink: "#374151" },
});

export function normalizeAppearance(value = {}) {
  return {
    language: value?.language === "en" ? "en" : "zh-CN",
    theme: ["light", "dark"].includes(value?.theme) ? value.theme : "browser",
    accent: Object.hasOwn(PALETTES, value?.accent) ? value.accent : "blue",
  };
}

export function iconPath(accent) {
  return `icons/book-${normalizeAppearance({ accent }).accent}.svg`;
}

export function bookIcon(accent) {
  const { background, ink } = PALETTES[normalizeAppearance({ accent }).accent];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="${background}"/>
  <path d="M14 17h13c3 0 5 2 5 4 0-2 2-4 5-4h13v31H37c-3 0-5 2-5 4 0-2-2-4-5-4H14Z" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linejoin="round"/>
  <path d="M32 23v25M20 26h6m-6 7h6m12-7h6m-6 7h6" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/>
</svg>\n`;
}
