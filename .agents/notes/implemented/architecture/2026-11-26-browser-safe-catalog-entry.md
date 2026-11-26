# Agent Note: cwtools-shared 提供浏览器安全的 catalog 子路径入口

Status: implemented

## Problem

`dsh-cwtools@0.3.0` 的设置页在浏览器里渲染工具目录，只用到 `listMcpToolSchemas`、`getMcpToolRegistryMetadata` 与 `isMcpWriteToolName`，却从包根导入。包根 re-export 了 `generated/workspaceGameDetection`、`project/*`、`safety/paths`、`tools/archetype*` 等 Host 模块，它们在求值时就 `require("fs"|"path"|"crypto"|"url"|"os")`。打包器把它们整体内联进浏览器产物，DSH 客户端模块表没有 Node 内置模块，插件 factory 在注册设置分区之前抛错（dsh-cwtool issue #1）。

## Decision

- 新增 `src/catalog.ts`，以 `cwtools-shared/catalog` 子路径发布：只 re-export `tools/mcpSchema`、`tools/names` 与若干纯类型。运行时导入图只有 `tools/catalog`（生成目录数据）、`tools/mcpSchema`、`tools/names`。
- `package.json` 增加 `exports`：`.`、`./catalog`、`./package.json`。包根行为不变；其余 `dist/*` 深层路径不再可导入，避免消费者绑定内部目录结构。因此版本从 `0.4.0` 升到 `0.5.0`。
- `catalogEntry.contract.test.ts` 静态遍历入口的运行时导入图（跳过 `import type`/`export type`），断言没有任何非相对导入、文件集合恰为上述四个，并断言子路径导出与包根是同一批函数。往入口加入 Host 模块会让测试失败。
- `cwtools-node@0.3.1` 与 `cwtools-mcp@0.5.1` 只把精确依赖对齐到 `cwtools-shared@0.5.0`，使下游安装时不会出现两份 shared。

## Alternatives considered

- **消费者深层导入 `dist/tools/mcpSchema.js`。** 能立即解阻，但把消费者绑在内部目录布局上，且 shared 无法表达哪些路径是浏览器安全的承诺。
- **把 Host 模块从包根移走或拆成独立包。** 对现有 Node 消费者是破坏性改动，收益只在浏览器场景，不值得。
- **在 `exports` 中保留 `./dist/*` 通配。** 兼容性更好，但仓库内与已知下游都没有深层导入，保留通配会继续默许绑定内部结构。

## Consequences

- 浏览器/UI 消费者使用 `cwtools-shared/catalog`；Node 宿主继续使用包根。
- 使用 `moduleResolution: node`（node10）的 TypeScript 消费者看不到子路径类型；需要该入口的消费者应使用 `node16`/`nodenext`/`bundler`。
- 新增到入口的导出必须同样不触达 Node 内置模块与 Host 模块，契约测试兜底。
