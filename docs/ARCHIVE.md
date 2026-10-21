# XPaper-Read 1.0.5 项目归档

> 当前开发状态（2026-10-21）：`source/` 已更新为 1.0.8，网页版与 API 共用 Article / Review 胶囊切换。DeepSeek 使用全宽，其他页面内容保持 90% 宽度；胶囊 Review 滑块的偏移已修正。当前重建产物为 `source/artifacts/XPaper-Read-1.0.8.xpi` 和 `source/artifacts/XPaper-Read-1.0.8-source.zip`，验证见 [验证记录](VALIDATION.md)。以下内容是 1.0.5 归档时的历史记录；外层原始 1.0.5 ZIP / XPI 不代表当前源码。

归档日期：2026-10-21。

## 保留内容

项目已完成清理，根目录仅保留以下三个项目：

```text
source/                         完整可编辑、可重建的项目源码和资料
XPaper-Read-1.0.5-source.zip      source/ 全部内容的压缩包
XPaper-Read-1.0.5.xpi             已验证的原始 1.0.5 运行包，尚未签名
```

`source/` 与源码 ZIP 的文件内容一致，均包含业务代码、扩展资源、构建和打包脚本、全部测试、依赖清单及锁文件、README、隐私说明、商店审核说明、验证记录、精选截图、导出示例和 Logo 素材。README 展示图片位于 `assets/`，也包含在源码 ZIP 中。ZIP 根目录直接包含 `package.json`，没有额外的 `source/` 包装层。

扩展业务源码、运行资源、测试和依赖锁文件保持不变；本次仅整理资料、更新说明及打包配置。打包脚本只生成一份 XPI 和一份源码 ZIP，源码打包范围包含新增的 `assets/` 目录。保留的 XPI 没有重新编译或改动内容，版本仍为 1.0.5。

`docs/assets/book-blue.png` 是原构建目录中单独保存的蓝色 Logo 参考素材。构建仍使用 `extension/icons/` 的 SVG 及构建脚本生成的主题图标。

## 恢复开发与重新打包

在 `source/` 中，或把源码 ZIP 解压到一个新目录后，在含有 `package.json` 的目录中执行：

```text
npm ci
npm test
npm run package
```

需要 Node.js 22.13.0 或更高版本与 npm；归档重建验证使用 Node.js 26.8.1。`npm ci` 按锁文件恢复依赖，首次安装通常需要网络。归档不包含 `node_modules/`。

`npm run package` 自动构建 `dist/`，然后在 `artifacts/` 生成 `XPaper-Read-1.0.5.xpi` 与 `XPaper-Read-1.0.5-source.zip`。源码修改后再次运行即可重新打包。浏览器集成测试需要额外的浏览器环境，配置方法见[使用指南](USAGE.md#开发与验证)；这些环境不是插件运行依赖。

## GitHub 使用

将 `source/` 内的全部内容作为仓库根目录，包括 `.gitignore` 和 `package-lock.json`。文档与截图使用仓库内相对链接。无需上传 `node_modules/`、`dist/` 或临时测试目录；`.gitignore` 已排除这些生成内容。ZIP 和 XPI 可单独复制或作为 Release 附件保存。本次没有创建远程仓库或上传任何文件。

## 验证与清理范围

原有成功测试的报告、精选的 10 张验证截图和合成导出示例保留在 `docs/validation/`。另 10 张旧截图由作者主动移除，README 已替换为当前展示图片；此项资料精简不影响插件运行或源码构建。

最初归档时已从源码 ZIP 解压、独立恢复依赖、运行单元测试和打包，并逐文件比较新 XPI 与保留的原始 XPI：38 项单元测试通过，208 个运行文件一致。结果见 `docs/validation/archive-rebuild-report.json`；静态检查结果见 `docs/validation/amo-lint-report.json`。报告保留当时的测试结果与文件校验值，并另外记录后续资料调整，不将文档更新描述为重新运行测试。这些检查验证构建完整性与软件行为，不代表已验证真实模型的论文理解质量。

重复的根目录源码、已安装依赖、可重新生成的构建目录、旧版本包、临时重建目录和运行日志已由作者手动清理。当前保留的源码、测试、文档及精选资料均位于 `source/`；外层源码 ZIP 已同步当前内容。此次更新检查文档本地链接、打包脚本语法及 ZIP 逐文件一致性，未重新安装依赖或执行浏览器测试。

原始 XPI 的 SHA-256：`ffd1556ce021b4bff87c12ab43faed9405227229afd1123b7c229ccbc8a1b50d`。

重新打包可能因 ZIP 时间戳而产生不同的压缩包校验值；归档验证以包内每个文件的名称与内容一致为准。未签名 XPI 可临时加载，正式永久安装仍需 Mozilla 签名。
