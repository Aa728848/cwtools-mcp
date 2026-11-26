/**
 * Browser-safe entry point, published as `cwtools-shared/catalog`.
 *
 * The package root re-exports Host modules (project detection, path safety,
 * archetype artifacts, ...) that require Node builtins such as `fs`, `path` and
 * `crypto` as soon as they load. A UI that only renders the tool catalog must
 * not pull those in, so this entry exposes the generated catalog, its registry
 * metadata and the read/write name tables, and nothing that touches Node.
 *
 * `src/test/catalogEntry.contract.test.ts` walks this module's runtime import
 * graph and fails if any external or Node builtin import becomes reachable.
 */
export * from './tools/mcpSchema';
export * from './tools/names';
export type { GeneratedMcpTool, JsonObject, McpToolSchema, ToolDefinition } from './tools/schema';
export type { ToolRegistryMetadata } from './tools/registry';
export type { CwtoolsHostCapability } from './host/hostServices';
