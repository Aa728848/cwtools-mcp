import type { SharedToolResult } from 'cwtools-shared';

// MCP-specific adapter. The transport-neutral handler lives in
// `cwtools-shared` (tools/callHandler) and is re-exported here for compatibility.
export { createToolCallHandler, bindToolCallHandler } from 'cwtools-shared';
export type { SharedToolHandler, ToolCallContext } from 'cwtools-shared';

export function toMcpCallToolResult(result: SharedToolResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [
      {
        type: 'text',
        text: `${JSON.stringify(result, null, 2)}\n`,
      },
    ],
    isError: !result.ok,
  };
}
