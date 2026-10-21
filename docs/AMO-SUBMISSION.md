# XPaper-Read 1.0.8 — Firefox 商店提交

- 上传文件：`XPaper-Read-1.0.8.xpi`。
- 对应源码：`XPaper-Read-1.0.8-source.zip`。这两个文件由 `npm run package` 生成，位于源码目录下的 `artifacts/`。
- 作者：Xi Zhang；联系邮箱：oca-john@hotmail.com。
- 扩展 ID：`xpaper-read@local.extension`；Firefox 扩展版本：`1.0.8`；Node 包版本：`1.0.8`。
- XPI 根目录直接包含 `manifest.json`，没有多余顶层目录；只含扩展运行文件和第三方许可声明。
- 文件已在本地打包，未登录 Mozilla、上传、申请签名或公开发布。须通过开发者中心的检查与审核，由 Mozilla 返回签名版本。若 ID 已提交过版本 1.0.8，应先提高版本后重新构建。

Mozilla 的当前流程：[提交扩展](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)、[XPI 打包](https://extensionworkshop.com/documentation/publish/package-your-extension/)、[源码提交](https://extensionworkshop.com/documentation/publish/source-code-submission/)。提交时选择 **On this site** 上架商店，随包附上下面的英文审核说明，并根据商店表单填写名称、描述及隐私信息。详细数据说明在 `docs/PRIVACY.md`。

## Reviewer build instructions

This is a Firefox desktop WebExtension (Manifest V2, minimum Firefox 142). It does not require a server build or a private service. The displayed, manifest and npm versions are all 1.0.8.

Requirements: Node.js 22.13.0 or newer and npm. The build was verified on Windows with Node.js 26.8.1. Build scripts use portable Node filesystem APIs; no PowerShell or platform-specific compiler is required for the extension build. Internet access is needed only to install public npm dependencies. Unzip the source archive into a new directory and run from its root:

```text
npm ci
npm run build
```

The extension output is `dist/`. Compare its files with the unpacked XPI. Dependencies and integrity hashes are pinned by `package-lock.json`. Esbuild bundles locally with no minification; no remote code, generated secrets or production credentials are needed. PDF.js assets and third-party license notices are copied from the installed packages. The source archive excludes installed dependencies and generated runtime output. Curated verification reports, screenshots and a synthetic export example are retained in `docs/validation/`; test scripts generate new results separately in `artifacts/qa/`.

Optional checks:

```text
npm test
npm run lint:extension
npm run package
```

Browser UI tests require an installed compatible Playwright Chromium browser; `npm run test:firefox` uses Selenium, GeckoDriver and an installed desktop Firefox, with a separate headless test profile. The mock model endpoint uses invalid test-only credentials. These are verification tools, not runtime dependencies.

## Functionality and data handling

The default sidebar loads the real `https://chat.deepseek.com/` site in an iframe. Users sign in directly on that site. The extension does not implement OAuth, read cookies/login tokens or call undocumented chat APIs. Clicking Fill transfers a paper title, cleaned URL and the user's template into the site's input; it never clicks Send and never overwrites a draft. The iframe bridge checks the immediate parent extension origin, event source, message channel and request nonce. Reading selected answer text requires a separate user action and confirmation before local saving.

The optional API mode extracts a user-chosen page or PDF locally. Only clicking the reading action sends the previewed source, template and metadata to the configured HTTPS Chat Completions endpoint; PDF visual mode also sends the selected page images. API keys are sent only to that endpoint, never to the embedded website. Session storage is the default for keys, with an explicit opt-in for local persistence. There is no developer-owned relay, telemetry, analytics or cloud storage. The manifest declares website content and authentication information transmission; details are in `docs/PRIVACY.md`.

Language, accent and theme settings are local. Follow browser uses prefers-color-scheme and does not change Firefox settings. Both default templates request final Mermaid/Graphviz diagrams as declarative Markdown code. The extension does not execute those code blocks or load remote diagram renderers. Markdown is sanitized before display; the diagram code remains exportable.

Article and Review templates are independently editable. Existing custom templates remain Article templates; Review gets a separate default. Web and API pages share a capsule toggle that defaults to Article; clicking anywhere within its rounded surface flips the type. Web mode supplies only the title, public URL and selected template, without classification. API requests use the manually selected template. API chunk extraction and reduction preserve type-appropriate evidence. No extra paid request is made solely for classification. DeepSeek uses the full sidebar width; API reading, notes and Settings center their content at 90% of the available width.

## Permission and embedding review notes

`tabs` identifies the current paper's title/URL. `activeTab` and `scripting` support user-requested extraction. `storage` holds settings and up to 30 local reading notes. `clipboardWrite` supports explicit copy actions. Host permissions allow the default API and embedded DeepSeek site; additional page/PDF/custom API origins are requested individually when needed.

Firefox MV2 `webRequest` and `webRequestBlocking` are used for a narrowly scoped embedding adjustment: only a `sub_frame` request to `chat.deepseek.com` whose immediate ancestor URL is exactly this extension's `sidebar.html` qualifies. For that response only, X-Frame-Options is removed and the CSP frame-ancestors directive is amended to allow this extension's origin. All other CSP directives, normal tabs, unrelated frames/sites and cookies are left intact. This behavior is described to users in README and PRIVACY. Please review `allowSidebarFrame` in `src/core/web.js` and its tests. Approval of this embedding behavior remains a Mozilla review decision.

The local Add-ons Linter reports no errors and five existing third-party UNSAFE_VAR_ASSIGNMENT warnings: two Readability parsing uses of innerHTML, one DOMPurify parsing use, and two PDF.js dynamic-import paths. `docs/VALIDATION.md` describes each. The application processes Readability output as text, sanitizes Markdown to a restricted DOM fragment, and uses packaged PDF.js workers with eval/Wasm/XFA disabled. These warning explanations are provided for reviewer evaluation, not as a claim of Mozilla approval.

## Manual smoke test

1. Temporarily load `dist/manifest.json` in Firefox and open the sidebar using Alt+Shift+Y. Verify the horizontal Version 1.0.8 label and fixed 25 px footer.
2. In Settings → Appearance, use Follow browser, Light and Dark. When Follow browser is selected, changing Firefox's built-in browser theme should update the sidebar without reloading its chat frame.
3. Open a paper tab, inspect the structured prompt, and copy it without sending. Verify the Article / Review capsule to the right of Fill prompt, Copy prompt and Edit template (it wraps on narrow sidebars). Click its selected label, unselected label, gap, padding or edge: each click should flip the type exactly once. Article is selected by default even for a review title. The API page uses the same capsule. Settings → Templates edits and saves each template independently. API credentials are not required to test the web controls. `npm run test:templates` exercises these flows using synthetic materials and a local chat/API fixture.
4. Web chat requires a user-owned DeepSeek account for authenticated interactions. No reviewer credential is bundled. Login, sending and file upload are all handled by the website.
5. API reading requires a user-owned compatible API key. The automated API/PDF test suite provides a local mock service so reviewers can verify extraction, streaming and sanitization without purchasing API usage.

Only anonymous public DeepSeek embedding has been checked against the live site; authenticated chat behavior uses a cross-origin fixture in automated tests. No real model output or scientific accuracy has been validated by these tests.
