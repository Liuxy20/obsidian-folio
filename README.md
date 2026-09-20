# Folio Codex · 页间

在 Obsidian 里点中一段内容，留下问题或修改要求。Folio 使用你本机的 Codex，原地显示回答和修改建议。

**Desktop public beta · 桌面公开测试版**。支持 Markdown 笔记与静态 HTML，目前已在 macOS 验证；Windows/Linux 的原生 Obsidian 流程尚未验证。尚未上架社区插件目录。

> Folio lets you comment on Markdown and HTML in Obsidian, ask questions with inline answers, and review AI edits before saving. It uses your own local Codex CLI and provider configuration. See [Privacy](PRIVACY.md) before submitting content.

## 0.4.6：引用追问、重答与原文修订

讨论按旧到新展示，历史问答在上，新追问在下。长回答随正文滚动，手动折叠状态在重载后保留；卡片可导出全部轮次为独立笔记，弹窗中可修改保存目录与文件名。卡片里的“继续追问”直接展开输入，可切换“继续提问 / 让 AI 重答 / 修改笔记原文”；选中 AI 回答片段可点“引用追问”，草稿连同引用自动保留。修改生成后点“预览并保存”，确认采用才写入。阅读时侧栏按需打开：笔记顶部“审稿与历史”或卡片“查看详情与引用”，用完可收起。

- **AI 主动批注**：点击“请 AI 审稿”，预览发送范围后，让 AI 对当前笔记提出最多 5 条具体意见。全文审稿限 60 KB，不提供联网事实核查。
- **段落连续讨论**：在留言卡片继续提问、重答或修改笔记原文，带上本线程最近的对话；可以标记解决、重新打开或重新关联原文。
- **集中修订**：多处意见生成建议后，点击“集中预览与选择修改”，逐项勾选，检查最终正文后保存，支持整批撤销。

Review notes in place: AI leaves anchored comments, you discuss them in a thread, then accept selected revisions with a full-document preview and batch undo. Existing HTML annotation remains available.

### 重答与修改的区别

卡片中选择“让 AI 重答”可填写调整要求（可留空），点击“重新生成回答”后追加一轮回答，旧回答保留。选择“修改笔记原文”才会生成原文修改建议，仍需预览确认后保存。侧栏回答也提供重答入口，先带入留言，再由用户发送。

侧栏与卡片的关联原文均支持 Markdown 渲染、双向滚动和拖动右下角调高；侧栏点击行号可回到正文。

## 能做什么

- **一个入口**：点击左侧页间，自动使用当前笔记或 HTML；笔记侧栏跟随正在阅读的文档。
- **原地提问**：点中段落，弹出输入框；提交后留下留言卡片，支持 Markdown 回答和源码行引用。
- **审阅修改**：先看差异，点击“采用并保存”才改笔记；保存前备份，可在未发生后续修改时撤销。
- **HTML 批注**：点选真实元素，留言修改文字或样式；支持静态 HTML 导入及支持的图片附件化。
- **恢复记录**：草稿、答案与备份保存在自己的笔记库，重开可恢复。

## 安装测试版

1. 安装并配置可正常使用的 [Codex CLI](https://developers.openai.com/codex/cli/)。Folio 沿用本地登录或 provider 配置，不提供模型额度，也不需要你把 API key 填进插件。
2. 从 [Releases](https://github.com/Liuxy20/obsidian-folio/releases) 下载 `folio-codex-0.4.6.zip`，将其中的 `folio-codex` 文件夹放进笔记库 `.obsidian/plugins/`。
3. 重启 Obsidian，在“设置 → 社区插件”启用 **Folio Codex · 页间**。
4. 打开一篇 Markdown 笔记，点击左侧页间，点中段落后选择“提问”或“修改”。

也可以使用 BRAT，通过 `Liuxy20/obsidian-folio` 安装 GitHub 测试版。Folio 自身不需要运行网页服务。

## 数据与费用

**AI 请求会发往你的 Codex 所配置的模型服务，不是离线推理。** Markdown 问答会发送选区和当前笔记上下文，短笔记可能全文发送；HTML 会发送选中元素和相关上下文。费用、保留政策由你的 provider 决定。

Folio 不内置开发者网关、分析统计或密钥。评论与笔记上下文会存入插件状态文件，备份或同步笔记库时也可能被复制。导入远程图片会请求对应图片服务器。详细说明见 [PRIVACY.md](PRIVACY.md)。请勿在公开 Issue 中粘贴配置、状态文件、私人笔记或完整诊断输出。

## 当前边界

- 桌面端；不支持移动端、Word/PDF、Excalidraw 画布批注或任意在线网页。
- Markdown 使用渲染段落定位，表格和列表通常整体选取；编辑模式可精确选择文字。
- 笔记修改后，原文可唯一匹配的留言会跟随；歧义、删除或已修改的内容需要重新关联。本地保留全部已保存讨论，列表每次加载 30 条；旧版本已淘汰的记录不会自动恢复。
- 继续讨论仅携带本线程最近最多 8 轮内容（约 16 KB 上限）；新选区不附带其他讨论。不读取链接笔记；不提供联网检索。
- HTML 导入最多 25 MB；图片提取后正文最多 5 MB。脚本、外部 CSS、SVG 和 CSS 背景图不支持。

高级用法、配置选项和保存行为见 [使用说明](obsidian/README.md)。当前不支持 Codex 默认 profile；可在插件设置选择独立配置目录。以环境变量认证时，需要确保 Obsidian 启动环境包含这些变量。

## 从源码构建

需要 Node.js 22 或更新版本。

```sh
npm ci --ignore-scripts
npm test
npm run build:obsidian
```

产物在 `dist/obsidian/folio-codex/`，同时生成 ZIP 安装包。GitHub Release 另外上传 `main.js`、`manifest.json` 和 `styles.css`，版本标签与 manifest 一致。

自动化测试使用合成数据和模型替身。`npm run test:codex` 会调用真实本机 Codex，只使用脚本中的合成内容，可能产生模型费用，不属于默认测试。原生界面测试使用独立 `.test-vault` 和 `.test-profile`；不要对正式笔记库运行重置型测试。

## 反馈

通过 [Issues](https://github.com/Liuxy20/obsidian-folio/issues) 提供版本、系统、复现步骤及合成示例。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE)。发行包包含第三方依赖的许可证说明。
