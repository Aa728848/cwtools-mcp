# cwtools-mcp

[English](#english) | [中文](#zh-cn)

<a id="english"></a>

## English

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes the CWTools Paradox/Stellaris semantic tools (project knowledge pack,
bounded project graph, syntax check, scope queries, definitions, references,
diagnostics, scripted triggers/effects/enums, and seven Shader queries) to
external agents such as Codex and Claude Code.

This repository was split out of
[cwtools-vscode](https://github.com/Aa728848/cwtools-vscode), which vendors it
back as the `submodules/cwtools-mcp` submodule. The VS Code extension no longer
bundles the MCP server — install it standalone:

- **npm**: `npx -y cwtools-mcp --stdio`
- **Single file**: download `cwtools-mcp.cjs` from
  [Releases](https://github.com/Aa728848/cwtools-mcp/releases) and point your
  MCP client at `node cwtools-mcp.cjs --stdio`

By default the proxy bridges into the active VS Code-compatible host (VS Code,
Insiders, VSCodium, Cursor, Antigravity) through the `bridge-manifest.json` the
extension writes under its `globalStorage`, auto-discovered across all
supported hosts — reusing the IDE's CWTools language client and diagnostics
instead of starting a second server. A legacy self-hosted LSP mode is available
with `--standalone`.

### Setup

```sh
# Codex
codex mcp add cwtools -- npx -y cwtools-mcp --stdio

# Claude Code
claude mcp add cwtools --scope user -- npx -y cwtools-mcp --stdio
```

For hand-written `~/.codex/config.toml`, `--standalone` / `--rules` / `--cache`
/ `--game-path` advanced options, and Antigravity setup, see
[packages/cwtools-mcp/README.md](packages/cwtools-mcp/README.md).

### Development

```sh
git submodule update --init   # pulls submodules/cwtools-stellaris-config (CWT rules for tests/dev)
npm install
npm run build            # build both packages (cwtools-shared, cwtools-mcp)
npm run test:contracts   # contract tests (schema drift, read-only, routing)
npm run bundle           # single-file dist/cwtools-mcp.cjs via esbuild
```

The MCP tool schema is **generated**, not handwritten: it is produced by
`tools/generate-mcp-schema.cjs` in the
[cwtools-vscode](https://github.com/Aa728848/cwtools-vscode) repository from the
extension's tool definitions, and committed here under
`packages/cwtools-shared/src/generated/mcpTools.ts`.

### Publishing

Both packages are published to npm (`cwtools-shared` first, then
`cwtools-mcp`). Tags (`v*`) trigger a GitHub Release with the single-file
`cwtools-mcp.cjs` attached.

<a id="zh-cn"></a>

## 中文

只读的 [Model Context Protocol](https://modelcontextprotocol.io) 服务，把
CWTools 的 Paradox/Stellaris 语义工具（项目知识包、有界项目语义图、语法检查、
作用域查询、定义/引用、诊断、scripted triggers/effects/enums 和七个 Shader
查询）开放给 Codex、Claude Code 等外部 Agent。

本仓库从 [cwtools-vscode](https://github.com/Aa728848/cwtools-vscode) 拆出，
主仓库以 `submodules/cwtools-mcp` submodule 形式挂回。VS Code 扩展不再随包
携带 MCP 服务——请独立安装：

- **npm**：`npx -y cwtools-mcp --stdio`
- **单文件**：从 [Releases](https://github.com/Aa728848/cwtools-mcp/releases)
  下载 `cwtools-mcp.cjs`，MCP 客户端配置 `node cwtools-mcp.cjs --stdio`

默认模式下代理会通过扩展写入 `globalStorage` 的 `bridge-manifest.json`
（在所有受支持宿主中自动发现：VS Code / Insiders / VSCodium / Cursor /
Antigravity）桥接进已激活的 VS Code 兼容宿主，复用 IDE 已有的 CWTools 语言
客户端与诊断，不启动第二个服务。旧的自托管 LSP 模式可用 `--standalone`
显式启用。

### 接入

```sh
# Codex
codex mcp add cwtools -- npx -y cwtools-mcp --stdio

# Claude Code
claude mcp add cwtools --scope user -- npx -y cwtools-mcp --stdio
```

`~/.codex/config.toml` 手写配置、`--standalone` / `--rules` / `--cache` /
`--game-path` 高级选项与 Antigravity 接入方式见
[packages/cwtools-mcp/README.md](packages/cwtools-mcp/README.md)。

### 开发

```sh
git submodule update --init   # 拉取 submodules/cwtools-stellaris-config（测试/开发用 CWT 规则）
npm install
npm run build            # 构建两个包（cwtools-shared、cwtools-mcp）
npm run test:contracts   # 合约测试（schema 漂移、只读、路由）
npm run bundle           # esbuild 产出单文件 dist/cwtools-mcp.cjs
```

MCP 工具 schema 为**生成物**，不手写：由
[cwtools-vscode](https://github.com/Aa728848/cwtools-vscode) 仓库的
`tools/generate-mcp-schema.cjs` 从扩展工具定义生成，提交在本仓库
`packages/cwtools-shared/src/generated/mcpTools.ts`。

### 发布

两个包都发布到 npm（先 `cwtools-shared`，再 `cwtools-mcp`）。打 `v*` 标签会
触发 GitHub Release 并附带单文件 `cwtools-mcp.cjs`。
