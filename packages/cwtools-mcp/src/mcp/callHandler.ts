// Compatibility re-export: the transport-neutral call handler moved to
// `cwtools-shared` so hosts without an MCP dependency can route tools.
export { bindToolCallHandler, createToolCallHandler } from 'cwtools-shared';
export type { SharedToolHandler, ToolCallContext } from 'cwtools-shared';
