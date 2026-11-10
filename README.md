# cwtools-mcp

[English](#english) | [中文](#zh-cn)

<a id="english"></a>

## English

[Model Context Protocol](https://modelcontextprotocol.io) server that
exposes CWTools Paradox/Stellaris semantic tools and default-on whitelisted domain writes (project knowledge pack,
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

Both modes require reliable Paradox/CWT evidence. A lone `common/` directory or a
generic `metadata.json` is not enough. Unsupported or ambiguous workspaces expose
no tools/resources and never spawn an LSP. If the game is unknown, Standalone uses
generic `paradox` mode rather than assuming Stellaris. CWT-only workspaces expose
only the seven document/navigation/diagnostic tools that work without a game model.

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
npm run build            # build the packages (cwtools-shared, cwtools-node, cwtools-mcp)
npm run test:contracts   # contract tests (schema drift, write policy, routing)
npm run bundle           # single-file dist/cwtools-mcp.cjs via esbuild
```

The MCP tool schema is **generated**, not handwritten: it is produced by
`tools/generate-mcp-schema.cjs` in the
[cwtools-vscode](https://github.com/Aa728848/cwtools-vscode) repository from the
extension's tool definitions, and committed here under
`packages/cwtools-shared/src/generated/mcpTools.ts`.

### Packages

Three packages with a strictly one-way dependency graph:

| Package | Contains | Depends on |
| --- | --- | --- |
| `cwtools-shared` | Transport-free contracts, generated tool schemas, the transport-neutral tool call handler (`tools/callHandler`), and pure computations such as `tools/targetingWeights` | nothing |
| `cwtools-node` | Node host services: filesystem, standalone LSP process, native active-host client, revalidation, project detection | `cwtools-shared`, `chokidar`, `vscode-jsonrpc` — never the MCP SDK |
| `cwtools-mcp` | MCP transport, generated schemas, resources, bridge proxy; re-exports the Node hosts for compatibility | `cwtools-shared`, `cwtools-node`, `@modelcontextprotocol/sdk` |

A host that needs CWTools semantics without an MCP dependency imports `cwtools-node`
and calls `createToolCallHandler` from `cwtools-shared`. Cancellation is part of the
contract: every LSP-backed call accepts an `AbortSignal`, and an abort surfaces as an
`AbortError` instead of an `unavailable` result. A Node host also validates the
`cwtools.ai.getHostCapabilities` handshake on first start and reports
`backend_incompatible` (releasing the backend) for an old, malformed or incomplete
answer. Non-MCP consumers can also inject `NativeBridgeLspHost`: discovery validates the
native manifest, live process, exact workspace and `/cwtools/healthz`, then calls only
the separate bearer-authenticated `/cwtools/rpc` API. Unavailable hosts allow standalone
fallback; incompatible active hosts return `backend_incompatible` without a second process.

### Publishing

All three packages are published to npm (`cwtools-shared` first, then
`cwtools-node`, then `cwtools-mcp`). Tags (`v*`) trigger a GitHub Release with the
single-file `cwtools-mcp.cjs` attached.

<a id="zh-cn"></a>

## 中文

[Model Context Protocol](https://modelcontextprotocol.io) 服务，默认提供白名单领域写入，并把
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

两种模式都要求可靠的 Paradox/CWT 证据。单独一个 `common/` 或通用
`metadata.json` 不足以启用。非支持或歧义工作区不披露工具/资源，也不会启动
LSP。无法确定游戏时，Standalone 使用通用 `paradox` 模式而不是假定 Stellaris。
CWT-only 工作区只暴露无需游戏模型即可工作的七个文档、导航与诊断工具。

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
npm run build            # 构建三个包（cwtools-shared、cwtools-node、cwtools-mcp）
npm run test:contracts   # 合约测试（schema 漂移、写入策略、路由）
npm run bundle           # esbuild 产出单文件 dist/cwtools-mcp.cjs
```

MCP 工具 schema 为**生成物**，不手写：由
[cwtools-vscode](https://github.com/Aa728848/cwtools-vscode) 仓库的
`tools/generate-mcp-schema.cjs` 从扩展工具定义生成，提交在本仓库
`packages/cwtools-shared/src/generated/mcpTools.ts`。

### 包结构

三个包，依赖关系严格单向：

| 包 | 内容 | 依赖 |
| --- | --- | --- |
| `cwtools-shared` | 与传输无关的契约、生成的工具 schema、传输无关的工具调用处理器（`tools/callHandler`）、以及 `tools/targetingWeights` 这类纯计算 | 无 |
| `cwtools-node` | Node 宿主服务：文件系统、独立 LSP 进程、原生活跃宿主客户端、复验、项目探测 | `cwtools-shared`、`chokidar`、`vscode-jsonrpc`——绝不依赖 MCP SDK |
| `cwtools-mcp` | MCP 传输、生成 schema、资源、桥接代理；为兼容而重新导出 Node 宿主 | `cwtools-shared`、`cwtools-node`、`@modelcontextprotocol/sdk` |

需要 CWTools 语义但不想引入 MCP 依赖的宿主，导入 `cwtools-node`，并从 `cwtools-shared` 取
`createToolCallHandler`。取消是契约的一部分：每个走 LSP 的调用都接受 `AbortSignal`，中止会以
`AbortError` 抛出而不是变成 `unavailable` 结果。Node 宿主在首次启动时还会校验
`cwtools.ai.getHostCapabilities` 握手，对旧的、畸形的或不完整的响应报
`backend_incompatible` 并释放后端。非 MCP 消费者还可注入 `NativeBridgeLspHost`：发现阶段校验
原生清单、活进程、精确工作区与 `/cwtools/healthz`，随后只调用独立的 bearer 认证
`/cwtools/rpc` API。不可用宿主允许独立回退；活跃宿主不兼容则返回
`backend_incompatible`，不会创建第二个进程。

### 发布

三个包都发布到 npm（先 `cwtools-shared`，再 `cwtools-node`，最后 `cwtools-mcp`）。打 `v*` 标签会
触发 GitHub Release 并附带单文件 `cwtools-mcp.cjs`。
