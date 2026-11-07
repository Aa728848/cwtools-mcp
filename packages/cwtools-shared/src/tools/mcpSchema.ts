import { GENERATED_MCP_TOOLS } from '../generated/mcpTools';
import { isMcpWriteToolName } from './names';
import type { GeneratedMcpTool, McpToolSchema } from './schema';

export function getGeneratedMcpTools(): readonly GeneratedMcpTool[] {
  return GENERATED_MCP_TOOLS;
}

export function listMcpToolSchemas(options?: { includeWrites?: boolean }): McpToolSchema[] {
  const includeWrites = options?.includeWrites === true;
  return GENERATED_MCP_TOOLS
    .filter(entry => includeWrites || !isMcpWriteToolName(entry.tool.name))
    .map(entry => ({ ...entry.tool }));
}

export function getMcpToolSchema(name: string): McpToolSchema | undefined {
  return GENERATED_MCP_TOOLS.find(entry => entry.tool.name === name)?.tool;
}

export function getMcpToolRegistryMetadata(name: string): GeneratedMcpTool['registry'] | undefined {
  return GENERATED_MCP_TOOLS.find(entry => entry.registry.name === name)?.registry;
}
