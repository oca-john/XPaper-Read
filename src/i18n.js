import { EN, PATTERNS } from "./locales/en.js";
let language = "zh-CN";
const textBindings = new Map(), attrBindings = new Map();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = PATTERNS.map(([source, target]) => {
  const names = [...source.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
  const regexp = new RegExp("^" + source.split(/\{\w+\}/g).map(escape).join("([\\s\\S]*?)") + "$", "u");
  return { regexp, names, target };
});

export const getLanguage = () => language;
export function translate(value) {
  const text = String(value ?? "");
  if (language !== "en") return text;
  if (Object.hasOwn(EN, text)) return EN[text];
  for (const { regexp, names, target } of patterns) {
    const match = regexp.exec(text);
    if (!match) continue;
    return target.replace(/\{(\w+)\}/g, (_, name) => {
      const value = match[names.indexOf(name) + 1];
      // Only nested UI fragments are localized; source/title/model parameters stay verbatim.
      return ["plan", "images"].includes(name) ? translate(value) : value;
    });
  }
  return text;
}

export function uiText(element, source) {
  source = String(source ?? "");
  const rendered = translate(source);
  textBindings.set(element, { message: source, rendered });
  element.textContent = rendered;
}

export function uiAttr(element, name, source) {
  if (!attrBindings.has(element)) attrBindings.set(element, new Map());
  attrBindings.get(element).set(name, source);
  element.setAttribute(name, translate(source));
}

// Capture only initial, known interface copy. No observer scans paper text,
// generated notes, textarea values or the embedded third-party page.
export function registerStaticUI(document) {
  const walker = document.createTreeWalker(document, 4);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest("textarea,script,style,pre")) continue;
    const source = node.data.trim();
    if (!Object.hasOwn(EN, source)) continue;
    const leading = node.data.match(/^\s*/)[0], trailing = node.data.match(/\s*$/)[0];
    textBindings.set(node, { source, leading, trailing });
  }
  for (const element of document.querySelectorAll("*")) {
    for (const name of ["title", "placeholder", "aria-label"]) {
      const source = element.getAttribute(name);
      if (source && Object.hasOwn(EN, source)) uiAttr(element, name, source);
    }
  }
}

export function setLanguage(value, document) {
  language = value === "en" ? "en" : "zh-CN";
  if (document) document.documentElement.lang = language;
  for (const [element, source] of textBindings) {
    if (!element.isConnected) { textBindings.delete(element); continue; }
    if ("source" in source) element.data = source.leading + translate(source.source) + source.trailing;
    else if (element.textContent === source.rendered) {
      source.rendered = translate(source.message);
      element.textContent = source.rendered;
    } else textBindings.delete(element);
  }
  for (const [element, attributes] of attrBindings) {
    if (!element.isConnected) { attrBindings.delete(element); continue; }
    for (const [name, source] of attributes) element.setAttribute(name, translate(source));
  }
}
