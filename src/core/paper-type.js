import { DEFAULT_ARTICLE_TEMPLATE, DEFAULT_REVIEW_TEMPLATE } from "./defaults.js";

const normalize = value => String(value || "").normalize("NFKC").replace(/[‐‑–—_-]/g, " ").replace(/\s+/g, " ").trim();
const REVIEW_LABEL = /^(?:(?:systematic|scoping|narrative|umbrella|literature|critical|integrative|mini|state of the art) )?review(?: article| paper)?$|^meta analysis$|^(?:综述|综述论文|文献综述|系统综述|范围综述|述评)$/i;
const ARTICLE_LABEL = /^(?:original|research|original research)(?: article| paper| report)?$|^(?:原创研究|研究论文|研究型论文|论著)$/i;
// A generic publisher label such as "Article" / "Journal Article" also covers reviews.
function explicitType(value) {
  const label = normalize(value);
  if (REVIEW_LABEL.test(label)) return "review";
  if (ARTICLE_LABEL.test(label)) return "article";
  return null;
}

export function detectPaperType(source = {}) {
  const evidence = [];
  const add = (type, reason) => { if (type) evidence.push({ type, reason }); };
  const raw = source.metadata?.articleType;
  for (const item of (Array.isArray(raw) ? raw : [raw]).flatMap(value => String(value || "").split(/[;|]/))) add(explicitType(item), "metadata");

  // Do not infer from a journal name, URL path, reference list, "peer review",
  // "retrospective chart review", or a population survey alone.
  const title = normalize(source.title).split(/\s+[|]\s+/)[0];
  const nonReviewStudy = /\b(?:retrospective|chart|medical record|record|case) review\b|\bpeer review\b|病历回顾/i.test(title);
  if (!nonReviewStudy && (/\b(?:systematic|scoping|narrative|umbrella|literature|integrative|critical|comprehensive|mini|state of the art) review\b|\bmeta analys(?:is|es)\b/i.test(title)
    || /^(?:a |an )?review(?: of\b|:|$)|:\s*(?:a |an )?review\b|\b(?:a|an) review\s*$/i.test(title)
    || /(?:综述|研究进展|研究现状)(?:[：:。！？]|$)/.test(title))) add("review", "title");
  if (/\b(?:randomi[sz]ed controlled|randomi[sz]ed clinical) trial\b/i.test(title) && !/\bprotocols?\b|研究方案/i.test(title) && !evidence.some(e => e.type === "review")) add("article", "title");

  // Read only the front of the supplied material; never silently fetch anything.
  // A middle PDF page or a selected paragraph is not reliable front matter.
  const blocks = source.blocks || [];
  const frontAvailable = source.kind !== "selection" && !/仅选中/.test(source.scope || "")
    && (source.kind !== "pdf" || blocks[0]?.label === "p.1");
  if (frontAvailable && blocks.length) {
    const front = blocks.slice(0, 24).map(b => b.text || "").join("\n").slice(0, 8000).split(/\n\s*(?:references|bibliography|参考文献)\s*\n/i)[0];
    for (const line of front.slice(0, 1200).split("\n")) add(explicitType(line), "frontmatter");
    if (/\b(?:in this (?:systematic |scoping |narrative |umbrella )?review\b|this (?:systematic |scoping |narrative |umbrella )?review (?:aims|summari[sz]es|synthesi[sz]es|examines|discusses|provides|focuses|explores|presents)\b)|本综述|本文(?:系统)?综述了/i.test(front)) add("review", "abstract");
  }
  const types = new Set(evidence.map(e => e.type));
  if (types.size > 1) return { type: "unknown", reason: "conflict" };
  return evidence[0] || { type: "unknown", reason: "insufficient" };
}

export function templateFor(settings, type) {
  const value = type === "review" ? settings.reviewTemplate ?? DEFAULT_REVIEW_TEMPLATE : settings.template ?? DEFAULT_ARTICLE_TEMPLATE;
  if (typeof value !== "string" || !value.trim() || value.length > 20000) throw new Error("模板不能为空，且不能超过 20,000 字符。");
  return value.trim();
}

export function selectReadingPlan(source, settings, mode = "auto") {
  if (!["auto", "article", "review"].includes(mode)) mode = "auto";
  const detection = mode === "auto" ? detectPaperType(source) : { type: mode, reason: "manual" };
  const { type } = detection;
  const classification = `【先判断文章类型，再使用对应模板】
先核实实际材料与阅读范围，再判断 Article（原创研究）或 Review（综述，包括系统综述与 Meta 分析），在回答开头写明文章类型及材料中的判断依据。不能仅凭“Methods/Results”栏目、引用了综述或期刊名称判断类型；不要把综述转述的研究当作作者亲自开展的实验。综述子类型也须有材料依据。`;
  let template;
  if (type === "unknown") {
    template = `${classification}
当前线索不足或相互冲突，尚未确定类型。取得材料后先完成上述判断，然后仅采用下列相应的一套模板，不混合两套栏目。若仍无法判断，或材料是社论、协议、评论等不属于这两类，说明原因并请我补充材料或手动选择，不默认套用 Article。

【Article 精读模板：仅在判断为原创研究时使用】
${templateFor(settings, "article")}

【Review 精读模板：仅在判断为综述时使用】
${templateFor(settings, "review")}`;
  } else {
    const name = type === "review" ? "Review" : "Article";
    template = `${classification}
${mode === "auto" ? `插件依据现有线索初判为 ${name}。请用实际材料复核；若明确不符，说明冲突并请我切换类型后重新填入/生成，不套用错误模板。` : `我已手动选择 ${name}，请使用该模板；若与材料明显冲突，请先说明冲突并请我确认，不擅自改用另一模板。`}

【${name} 精读模板】
${templateFor(settings, type)}`;
  }
  return { ...detection, mode, template };
}

export function readingTypeLabel(plan) {
  if (plan.reason === "manual") return plan.type === "review" ? "手动：Review 综述" : "手动：Article 研究型";
  if (plan.type === "review") return "自动初判：Review 综述";
  if (plan.type === "article") return "自动初判：Article 研究型";
  return plan.reason === "conflict" ? "类型线索冲突，模型将先核实再选模板" : "类型待确认，模型取得材料后先判断再选模板";
}
