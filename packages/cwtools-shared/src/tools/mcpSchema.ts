import { GENERATED_MCP_TOOLS } from '../generated/mcpTools';
import { isMcpToolName, isMcpWriteToolName, type McpToolName } from './names';
import type { GeneratedMcpTool, McpToolSchema } from './schema';

export function getGeneratedMcpTools(): readonly GeneratedMcpTool[] {
  return GENERATED_MCP_TOOLS;
}

export function listMcpToolSchemas(options?: { includeWrites?: boolean; cwtOnly?: boolean }): McpToolSchema[] {
  const includeWrites = options?.includeWrites !== false;
  const cwtOnly = options?.cwtOnly === true;
  return GENERATED_MCP_TOOLS
    .filter(entry => (includeWrites || !isMcpWriteToolName(entry.tool.name))
      && (!cwtOnly || entry.registry.mcpSupportsCwtOnly))
    .map(entry => ({ ...entry.tool }));
}

export function isMcpToolAvailable(
  value: string,
  options?: { includeWrites?: boolean; cwtOnly?: boolean },
): value is McpToolName {
  if (!isMcpToolName(value, options)) return false;
  if (!options?.cwtOnly) return true;
  return GENERATED_MCP_TOOLS.find(entry => entry.tool.name === value)?.registry.mcpSupportsCwtOnly === true;
}

export function getMcpToolSchema(name: string): McpToolSchema | undefined {
  return GENERATED_MCP_TOOLS.find(entry => entry.tool.name === name)?.tool;
}

export function getMcpToolRegistryMetadata(name: string): GeneratedMcpTool['registry'] | undefined {
  return GENERATED_MCP_TOOLS.find(entry => entry.registry.name === name)?.registry;
}
