import { GENERATED_MCP_TOOLS } from './catalog';
import { isMcpToolName, isMcpWriteToolName, type McpToolName } from './names';
import type { GeneratedMcpTool, McpToolSchema } from './schema';
import type { CwtoolsHostCapability } from '../host/hostServices';

export interface ToolSurfaceOptions {
  includeWrites?: boolean;
  cwtOnly?: boolean;
  capabilities?: ReadonlySet<CwtoolsHostCapability>;
}

const TOOL_CAPABILITY_REQUIREMENTS: Readonly<Record<string, CwtoolsHostCapability>> = {
  initialize_project: 'project_init',
  typed_pdx_write: 'domain_writes',
  candidate_transaction: 'domain_writes',
  convert_image_to_dds: 'domain_writes',
  convert_audio: 'domain_writes',
  deploy_mod_asset: 'domain_writes',
  extract_archetype_slots: 'archetypes',
  instantiate_archetype: 'archetypes',
  get_ignored_diagnostics: 'diagnostic_settings',
  remove_ignored_diagnostic: 'diagnostic_settings',
  get_ide_context: 'ide_context',
  open_in_visual_editor: 'visual_editor',
  capture_gui_preview: 'gui_capture',
};

function supportsHostCapability(name: string, capabilities?: ReadonlySet<CwtoolsHostCapability>): boolean {
  const required = TOOL_CAPABILITY_REQUIREMENTS[name];
  return capabilities === undefined || required === undefined || capabilities.has(required);
}

export function getGeneratedMcpTools(): readonly GeneratedMcpTool[] {
  return GENERATED_MCP_TOOLS;
}

export function listMcpToolSchemas(options?: ToolSurfaceOptions): McpToolSchema[] {
  const includeWrites = options?.includeWrites !== false;
  const cwtOnly = options?.cwtOnly === true;
  return GENERATED_MCP_TOOLS
    .filter(entry => (includeWrites || !isMcpWriteToolName(entry.tool.name))
      && (!cwtOnly || entry.registry.mcpSupportsCwtOnly)
      && supportsHostCapability(entry.tool.name, options?.capabilities))
    .map(entry => ({ ...entry.tool }));
}

export function isMcpToolAvailable(
  value: string,
  options?: ToolSurfaceOptions,
): value is McpToolName {
  if (!isMcpToolName(value, options) || !supportsHostCapability(value, options?.capabilities)) return false;
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
  options?: ToolSurfaceOptions,
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