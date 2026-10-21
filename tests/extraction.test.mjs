import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractDocument } from "../src/extract.js";

test("article extraction retains metadata, paragraphs and tables while discarding navigation/forms", () => {
  const html = `<!doctype html><title>Paper title</title>
  <meta name="citation_title" content="Controlled scientific study">
  <meta name="citation_author" content="A. Author">
  <meta name="citation_journal_title" content="Test Journal">
  <meta name="citation_doi" content="10.0000/test">
  <meta name="citation_article_type" content="Research Article">
  <meta name="citation_pdf_url" content="/paper.pdf">
  <nav>Navigate account settings</nav><form><input value="PRIVATE_PASSWORD"><p>PRIVATE_FORM_DATA</p></form>
  <article><h1>Controlled scientific study</h1><h2>Introduction</h2>
  <p>${"The field has an unresolved question that this experiment investigates. ".repeat(30)}</p>
  <h2>Methods</h2><p>${"Independent animals were assigned to a randomized controlled study. ".repeat(30)}</p>
  <table><tr><th>Group</th><th>Result</th></tr><tr><td>Control</td><td>42</td></tr></table>
  <h2>Results</h2><p>${"A significant result was observed, with limitations in generalizability. ".repeat(30)}</p>
  <div hidden>HIDDEN_SECRET</div><script>window.secret="SCRIPT_SECRET"</script></article><footer>Footer links</footer>`;
  const doc = new JSDOM(html, { url: "https://journal.example/article?access=private" }).window.document;
  const result = extractDocument(doc);
  assert.equal(result.title, "Controlled scientific study");
  assert.equal(result.metadata.journal, "Test Journal");
  assert.equal(result.metadata.articleType, "Research Article");
  assert.deepEqual(result.metadata.authors, ["A. Author"]);
  assert.equal(result.pdfCandidates[0], "https://journal.example/paper.pdf");
  const text = result.blocks.map(b => b.text).join("\n");
  assert.match(text, /Control \| 42/);
  assert.doesNotMatch(text, /PRIVATE_|HIDDEN_SECRET|SCRIPT_SECRET|Navigate account/);
  assert.match(text, /Methods/); assert.match(text, /Results/);
});

test("short landing pages are marked as potentially incomplete", () => {
  const doc = new JSDOM("<title>Abstract only</title><article><p>Small abstract.</p></article>", { url: "https://journal.example" }).window.document;
  const result = extractDocument(doc);
  assert.ok(result.warnings.some(w => /摘要/.test(w)));
  assert.match(result.scope, /尚未核实/);
});

test("selection does not implicitly add the full document", () => {
  const dom = new JSDOM("<p id='selection'>Selected paragraph.</p><p>PRIVATE_OUTSIDE_SELECTION</p>", { url: "https://journal.example" });
  const range = dom.window.document.createRange(); range.selectNodeContents(dom.window.document.getElementById("selection"));
  dom.window.getSelection().addRange(range);
  const source = extractDocument(dom.window.document, { selectionOnly: true });
  assert.equal(source.blocks[0].text, "Selected paragraph.");
  assert.match(source.scope, /仅选中/);
});
