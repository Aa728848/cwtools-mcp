import { listMcpToolSchemas, type McpToolSchema } from 'cwtools-shared';

export function listRegisteredTools(options?: { includeWrites?: boolean }): McpToolSchema[] {
  return listMcpToolSchemas(options);
}
