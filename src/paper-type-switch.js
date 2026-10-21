// A single button makes the entire capsule one toggle target, including its
// labels, selected thumb, gap and outer padding.
export function initializePaperTypeSwitch(element, onChange) {
  let value = element.dataset.paperType === "review" ? "review" : "article";
  function setValue(next, notify = false) {
    value = next === "review" ? "review" : "article";
    element.dataset.paperType = value;
    element.setAttribute("aria-checked", String(value === "review"));
    for (const label of element.querySelectorAll("[data-type-label]")) {
      label.classList.toggle("active", label.dataset.typeLabel === value);
    }
    if (notify) onChange(value);
  }
  element.addEventListener("click", () => {
    if (!element.disabled) setValue(value === "article" ? "review" : "article", true);
  });
  element.addEventListener("keydown", event => {
    if (element.disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "article" : event.key === "End" ? "review"
      : value === "article" ? "review" : "article";
    setValue(next, true);
  });
  setValue(value);
  return { get value() { return value; }, setValue };
}
