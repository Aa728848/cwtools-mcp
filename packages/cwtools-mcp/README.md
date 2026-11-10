# cwtools-mcp

[English](#english) | [中文](#zh-cn)

<a id="english"></a>

## English

CWTools MCP is the external-agent entry point for this extension's Paradox /
Stellaris semantic tools.

### Default Mode: Extension Bridge

By default, `cwtools-mcp` is a lightweight MCP proxy. It does **not** start a
second `CWTools Server` process. Instead, it connects to the MCP bridge started
inside the active VS Code-compatible extension host and reuses that host's:

- existing CWTools language client;
- current workspace root;
- Problems diagnostics from the IDE;
- rules/cache/localisation/user settings;
- shared indexes and AI read tools.

This keeps memory use low and makes MCP diagnostics match the IDE.

Bridge mode is deliberately strict about project identity without requiring a
project path in global MCP settings. By default, the proxy discovers the current
client workspace from MCP roots, known per-session environment variables, or the
MCP process cwd. That workspace must match the `workspaceRoot` served by the
extension bridge. If they do not match, tool calls return `bridge_unavailable`
instead of silently answering from a different project. `--workspace` remains an
optional override for clients that cannot expose a per-project root.

The extension writes both files below into the current host's own
`globalStorage/mcp/` directory when the project is active:

```text
cwtools-mcp.cjs
bridge-manifest.json
```

External agents should run the `cwtools-mcp.cjs` copied by the same host they are
using. The proxy reads `bridge-manifest.json` next to itself. This is host-name
agnostic: VS Code, Cursor, VSCodium, Antigravity, and other compatible hosts all
work as long as they support the VS Code extension APIs and activate this
extension.

### Quick Setup

Use the `globalStorage` path from the compatible host where the extension is
active. The placeholder below means the directory that contains the host's
`foreverskywalker.foreverskywalker-stellaris-cwtools` global storage folder.

#### Codex

```sh
codex mcp add cwtools -- node "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs" --stdio
```

#### Claude Code

```sh
claude mcp add cwtools --scope user -- node "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs" --stdio
```

#### Antigravity

Antigravity reads MCP servers from `~/.gemini/config/mcp_config.json`. Add this
server entry:

```json
{
  "mcpServers": {
    "cwtools": {
      "command": "node",
      "args": [
        "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs",
        "--stdio"
      ]
    }
  }
}
```

Or merge it into an existing config with a Node one-liner:

```sh
node -e "const fs=require('fs'),os=require('os'),path=require('path');const p=path.join(os.homedir(),'.gemini','config','mcp_config.json');const s=process.argv[1];const cfg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};cfg.mcpServers={...(cfg.mcpServers||{}),cwtools:{command:'node',args:[s,'--stdio']}};fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(cfg,null,2)+'\n')" "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs"
```

If the compatible host is closed, the workspace is not active, the manifest is
stale, or the client workspace differs from the bridge workspace, tool
calls return `bridge_unavailable` with recovery instructions. The proxy
intentionally does not silently fall back to a separate language server.

### Project Detection And Capability Modes

The server separates project support from game identity. Strong evidence includes
`descriptor.mod`, a valid `.cwtools/project/profile.json`, distinctive nested game
directories, known Workshop App IDs, and validated game-data paths. Generic content
directories require at least two directories plus a real PDX payload file. Parent
lookup accepts only strong non-recursive evidence; child lookup accepts exactly one
project and returns `project_ambiguous` when several exist.

Unsupported and ambiguous workspaces return empty `tools/list` and
`resources/list`, never start an LSP, and reject cached calls. A supported mod with
an inconclusive game uses generic `paradox` mode with no Stellaris rules/cache;
`--game` supplies an explicit game. `--force-start` permits generic mode without
markers but does not invent a game or select among multiple child projects.

CWT-only mode starts the LSP as `cwt` and exposes only `get_diagnostics`,
`analyze_diagnostic_error`, `get_completion_at`, `document_symbols`,
`workspace_symbols`, `go_to_definition`, and `find_references`. Other cached tool
calls fail with `tool_not_available_in_cwt_only`.

### Optional Standalone Mode

Use standalone mode only when you explicitly want the MCP process to start its
own CWTools language server and build an independent diagnostic state.

```sh
cwtools-mcp --standalone --workspace /path/to/mod --game stellaris --stdio
```

HTTP transport is available in both modes:

```sh
cwtools-mcp --http --host 127.0.0.1 --port 3000
cwtools-mcp --standalone --workspace /path/to/mod --http --host 127.0.0.1 --port 3000
```

### Standalone Rules And Vanilla Cache

These options apply to standalone mode:

```sh
cwtools-mcp --standalone --workspace /path/to/mod --game stellaris --game-path "/path/to/Stellaris"
cwtools-mcp --standalone --workspace /path/to/mod --game stellaris --cache "/path/to/.cwtools"
cwtools-mcp --standalone --workspace /path/to/mod --game stellaris --rules "/path/to/rules/config"
```

When standalone mode lacks a vanilla `.cwb` cache or `--game-path`, vanilla IDs
may be absent and diagnostics can differ from the IDE. Bridge mode avoids this by
using the active extension host's loaded state.

### Tools

The MCP surface exposes generated CWTools semantic tools plus six whitelisted
domain-write tools by default. The legacy `--enable-writes` /
`--allow-domain-writes` flags remain accepted but are no longer required.

- `query_types`
- `query_rules`
- `query_scope`
- `get_diagnostics`
- `explore_pdx_project` for a bounded live semantic graph with dependency edges and freshness
- `query_workspace_index`
- `query_localisation_index`
- `get_pdx_block`
- completion, document/workspace symbols, definition and reference lookup
- deep semantic queries for scripted effects/triggers, enums, static modifiers,
  variables, and entity info

Default domain writes are `write_localisation`, `typed_pdx_write`,
`candidate_transaction`, `convert_image_to_dds`, `convert_audio`, and
`deploy_mod_asset`. Existing path containment, locks, and validation prechecks still
apply; non-whitelisted writes remain unavailable. Re-run diagnostics after writes.

---

<a id="zh-cn"></a>

## 中文

CWTools MCP 是本扩展提供给外部 Agent 的 Paradox / Stellaris 语义工具入口。

### 默认模式：插件内 Bridge

默认情况下，`cwtools-mcp` 是一个轻量 MCP 代理。它**不会**再启动第二个
`CWTools Server` 进程，而是连接当前已激活的 VS Code 兼容宿主内的 MCP
bridge，并复用该宿主中的：

- 已有 CWTools 语言客户端；
- 当前工作区根目录；
- IDE Problems 面板诊断；
- rules/cache/localisation/用户设置；
- 共享索引和 AI 只读工具。

这样可以降低内存占用，并让 MCP 诊断数量与 IDE 保持一致。

Bridge 模式会严格校验项目身份，但不要求把项目路径写死到全局 MCP 设置里。默认情况下，
代理会从 MCP roots、已知的按会话注入的环境变量或 MCP 进程 cwd 推断当前客户端工作区。
这个工作区必须与扩展 bridge 暴露的 `workspaceRoot` 一致。不一致时工具调用会返回
`bridge_unavailable`，不会静默使用另一个项目回答。`--workspace` 只保留给无法暴露
按项目 root 的客户端作为可选覆盖项。

项目激活时，扩展会把下面两个文件写入当前宿主自己的 `globalStorage/mcp/`
目录：

```text
cwtools-mcp.cjs
bridge-manifest.json
```

外部 Agent 应运行同一个宿主复制出来的 `cwtools-mcp.cjs`。代理会读取同目录的
`bridge-manifest.json`。这条主路径不依赖宿主目录名：VS Code、Cursor、
VSCodium、Antigravity，以及其他兼容 VS Code 扩展 API 的宿主都可以使用。

### 快速接入

请使用实际运行扩展的兼容宿主自己的 `globalStorage` 路径。下面的
`<host-globalStorage>` 代表该宿主下
`foreverskywalker.foreverskywalker-stellaris-cwtools` 全局存储目录所在位置。

#### Codex

```sh
codex mcp add cwtools -- node "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs" --stdio
```

#### Claude Code

```sh
claude mcp add cwtools --scope user -- node "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs" --stdio
```

#### Antigravity

Antigravity 从 `~/.gemini/config/mcp_config.json` 读取 MCP 服务器。添加下面这个
server 条目：

```json
{
  "mcpServers": {
    "cwtools": {
      "command": "node",
      "args": [
        "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs",
        "--stdio"
      ]
    }
  }
}
```

也可以用下面的 Node 一行命令合并进已有配置，不会覆盖其他 MCP server：

```sh
node -e "const fs=require('fs'),os=require('os'),path=require('path');const p=path.join(os.homedir(),'.gemini','config','mcp_config.json');const s=process.argv[1];const cfg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};cfg.mcpServers={...(cfg.mcpServers||{}),cwtools:{command:'node',args:[s,'--stdio']}};fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(cfg,null,2)+'\n')" "<host-globalStorage>/foreverskywalker.foreverskywalker-stellaris-cwtools/mcp/cwtools-mcp.cjs"
```

如果兼容宿主未打开、工作区未激活、manifest 已失效，或客户端工作区与 bridge
工作区不一致，工具调用会返回 `bridge_unavailable` 和恢复说明。代理不会静默回退并启动单独的语言服务。

### 项目识别与能力模式

服务端分开判断项目是否支持和具体游戏身份。强证据包括 `descriptor.mod`、有效的
`.cwtools/project/profile.json`、游戏专属嵌套目录、已知 Workshop App ID 和经过验证的
游戏数据目录。通用内容目录必须至少有两个，并且包含真实 PDX 文件。祖先查找只接受
非递归强证据；子项目查找只接受唯一匹配，多个匹配返回 `project_ambiguous`。

非支持与歧义工作区返回空的 `tools/list` 和 `resources/list`，不启动 LSP，并拒绝
缓存调用。游戏无法确定但确认是 Mod 时，使用不带 Stellaris 规则/缓存的通用
`paradox` 模式；`--game` 可显式指定游戏。`--force-start` 允许无标记项目进入通用模式，
但不会伪造游戏，也不会从多个子项目中任选一个。

CWT-only 模式以 `cwt` 启动 LSP，只暴露 `get_diagnostics`、
`analyze_diagnostic_error`、`get_completion_at`、`document_symbols`、
`workspace_symbols`、`go_to_definition` 和 `find_references`。其他缓存工具调用返回
`tool_not_available_in_cwt_only`。

### 可选 Standalone 模式

只有在明确需要旧行为时才使用 standalone 模式：MCP 进程会自行启动一份 CWTools
语言服务器并构建独立诊断状态。

```sh
cwtools-mcp --standalone --workspace /path/to/mod --game stellaris --stdio
```

两种模式都支持 HTTP transport：

```sh
cwtools-mcp --http --host 127.0.0.1 --port 3000
cwtools-mcp --standalone --workspace /path/to/mod --http --host 127.0.0.1 --port 3000
```

### Standalone 的规则与原版缓存

下面这些参数只适用于 standalone 模式：

```sh
cwtools-mcp --standalone --workspace /path/to/mod --game stellaris --game-path "/path/to/Stellaris"
cwtools-mcp --standalone --workspace /path/to/mod --game stellaris --cache "/path/to/.cwtools"
cwtools-mcp --standalone --workspace /path/to/mod --game stellaris --rules "/path/to/rules/config"
```

如果 standalone 模式缺少 vanilla `.cwb` 缓存或 `--game-path`，原版 ID 可能缺失，
诊断也可能与 IDE 不一致。Bridge 模式通过复用当前扩展宿主的已加载状态来避免这个问题。

### 工具

MCP 入口默认提供生成的 CWTools 语义工具和六个白名单领域写入工具。
兼容参数 `--enable-writes` / `--allow-domain-writes` 仍可使用，但不再是启用前提。

- `query_types`
- `query_rules`
- `query_scope`
- `get_diagnostics`
- `explore_pdx_project`：返回带依赖边与 freshness 的有界 live 语义图
- `query_workspace_index`
- `query_localisation_index`
- `get_pdx_block`
- 补全、document/workspace symbols、定义和引用查询
- scripted effects/triggers、enums、static modifiers、variables、entity info 等深层语义查询

默认写入工具为 `write_localisation`、`typed_pdx_write`、`candidate_transaction`、
`convert_image_to_dds`、`convert_audio` 和 `deploy_mod_asset`。既有路径包含性、
锁和写入预检仍然生效，非白名单写入继续拒绝。写入后应重新调用诊断。
