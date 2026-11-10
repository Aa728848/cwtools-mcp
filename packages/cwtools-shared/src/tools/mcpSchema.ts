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

/**
 * Transport-neutral aliases.
 *
 * The schema surface is consumed by hosts that have nothing to do with MCP (the
 * Node host, an editor integration, an external agent runtime). Those callers ask
 * for "CWTools tools", not "MCP tools", so the neutral names are the preferred
 * spelling and the MCP-prefixed functions above remain for compatibility.
 */
export const listCwtoolsToolSchemas = listMcpToolSchemas;

export function isCwtoolsToolAvailable(
  value: string,
  options?: { includeWrites?: boolean; cwtOnly?: boolean },
): value is McpToolName {
  return isMcpToolAvailable(value, options);
}

export function getCwtoolsToolSchema(name: string): McpToolSchema | undefined {
  return getMcpToolSchema(name);
}

export function getMcpToolSchema(name: string): McpToolSchema | undefined {
  return GENERATED_MCP_TOOLS.find(entry => entry.tool.name === name)?.tool;
}

export function getMcpToolRegistryMetadata(name: string): GeneratedMcpTool['registry'] | undefined {
  return GENERATED_MCP_TOOLS.find(entry => entry.registry.name === name)?.registry;
}
