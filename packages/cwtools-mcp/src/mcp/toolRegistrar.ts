import { listMcpToolSchemas, type McpToolSchema, type ToolSurfaceOptions } from 'cwtools-shared';

export function listRegisteredTools(options?: ToolSurfaceOptions): McpToolSchema[] {
  return listMcpToolSchemas(options);
}
