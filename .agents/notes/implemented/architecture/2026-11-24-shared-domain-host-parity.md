# Agent Note: 共享领域工具目录、项目初始化与 Standalone 写入

Status: implemented

## Decision

- `cwtools-shared/src/tools/catalog.ts` 是 58 个领域工具的自有事实源，不再由 cwtools-vscode 的 Agent definitions 生成。
- `HostServices.capabilities` 同时约束 schema 披露和调用；IDE、GUI capture、Archetype、诊断设置、项目初始化和领域写入按真实宿主能力过滤。
- `initialize_project` 在 shared/project 内实现确定性 profile 与 LSP SQLite 导出，Bridge/Standalone/DSH 共用。真实模型 readiness、single-flight、取消和失败 manifest 均为契约。
- typed PDX、candidate transaction、媒体转换与资产部署在 Standalone 有真实实现；候选提交带锁、校验、漂移检查与回滚，外部命令不拼 shell。
- NativeBridgeIdeHost 为 DSH 活跃编辑器提供三个明确白名单操作，不引入 MCP SDK 或任意 RPC 转发。

## Consequences

- shared 121 项、node 77 项、mcp 24 项契约通过，三包构建通过。
- 真实 Standalone 初始化在 Stellaris fixture 上完成 V4/V7 产物与查询；知识库 110,747,648 字节，完整导出。
- 初始化的旧清理仅按文件名删除；不得恢复递归删除。
