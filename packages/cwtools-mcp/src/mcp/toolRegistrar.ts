import { listMcpToolSchemas, type McpToolSchema } from 'cwtools-shared';

export function listRegisteredTools(options?: { includeWrites?: boolean; cwtOnly?: boolean }): McpToolSchema[] {
  return listMcpToolSchemas(options);
}
