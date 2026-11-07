export const MCP_READONLY_TOOL_NAMES = [
  'query_types',
  'query_rules',
  'query_cwt_schema',
  'search_rule_capabilities',
  'explain_scope',
  'parse_pdx_fragment',
  'query_scope',
  'get_diagnostics',
  'analyze_diagnostic_error',
  'query_project_profile',
  'query_project_knowledge',
  'query_workspace_index',
  'explore_pdx_project',
  'query_inline_instantiation',
  'analyze_pdx_flow',
  'compare_definition_with_vanilla',
  'query_targeting_weight',
  'query_localisation_index',
  'get_pdx_block',
  'get_completion_at',
  'document_symbols',
  'workspace_symbols',
  'go_to_definition',
  'find_references',
  'query_scripted_effects',
  'query_scripted_triggers',
  'query_enums',
  'query_static_modifiers',
  'query_variables',
  'get_entity_info',
  'query_shader_symbol',
  'query_shader_compile_unit',
  'query_shader_platform_variants',
  'query_shader_callers',
  'explain_shader_reachability',
  'validate_shader',
  'compare_shader_with_vanilla',
  'get_ide_context',
  'open_in_visual_editor',
] as const;

export const MCP_WRITE_TOOL_NAMES = [
  'write_localisation',
  'typed_pdx_write',
  'candidate_transaction',
  'convert_image_to_dds',
  'convert_audio',
  'deploy_mod_asset',
] as const;

export const MCP_TOOL_NAMES = MCP_READONLY_TOOL_NAMES;

export const MCP_ALL_TOOL_NAMES = [
  ...MCP_READONLY_TOOL_NAMES,
  ...MCP_WRITE_TOOL_NAMES,
] as const;

export type McpToolName = typeof MCP_ALL_TOOL_NAMES[number];

export function isMcpToolName(value: string, options?: { includeWrites?: boolean }): value is McpToolName {
  if ((MCP_READONLY_TOOL_NAMES as readonly string[]).includes(value)) return true;
  if (options?.includeWrites && (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(value)) return true;
  return false;
}

export function isMcpWriteToolName(value: string): value is typeof MCP_WRITE_TOOL_NAMES[number] {
  return (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(value);
}
