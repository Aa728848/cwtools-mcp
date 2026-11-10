import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { HostServices, SharedToolDispatcher } from 'cwtools-shared';
import { listRegisteredTools } from './mcp/toolRegistrar';
import { createToolCallHandler, toMcpCallToolResult } from './mcp/toolHandlers';
import { listResources, readResource } from './mcp/resources';

// Server-level guidance surfaced to the model at connect time (MCP `instructions`).
// Tells a Paradox coding agent to ground every claim in these tools.
const FULL_SERVER_INSTRUCTIONS = [
  'CWTools provides semantic and whitelisted domain-write tools for Paradox mods. Ground every',
  'claim about the mod in these tools instead of memory — PDX identifiers and syntax',
  'are routinely hallucinated.',
  '',
  'Use it whenever working in a Paradox mod (common/, events/, localisation/, gfx/, …):',
  '- Start structural and dependency questions with explore_pdx_project. It returns a',
  '  bounded live CWTools semantic subgraph, file facts, provenance, and freshness.',
  '- Before using ANY game ID, verify it exists: query_types for typed entities;',
  '  query_scripted_effects / query_scripted_triggers / query_static_modifiers /',
  '  query_enums / query_variables for those kinds.',
  '- Check trigger/effect/scope-change/modifier syntax with query_rules; check the scope',
  '  valid at a position with query_scope.',
  '- Check common/event/interface/gfx schema shape with query_cwt_schema before writing',
  '  fields, block topology, or entity-path assumptions.',
  '- Before declaring code correct, review get_diagnostics (whole project). Honor the',
  '  readiness/freshness fields: if readiness.ready is false the project is still loading —',
  '  retry; an empty result then is not authoritative.',
  '- Navigate with go_to_definition / find_references /',
  '  document_symbols / workspace_symbols; read structured blocks with get_pdx_block',
  '  instead of reading whole files. get_entity_info gives a file\'s referenced types/vars.',
  '- Results carry vanillaCache metadata: if available is false, vanilla IDs are missing',
  '  and references to them may show as false errors.',
  '',
  'Use only the exposed whitelisted domain-write tools for writes, then re-check',
  'with get_diagnostics. Non-whitelisted writes remain unavailable.',
].join('\n');

function serverInstructions(host: HostServices): string {
  if (host.projectSupported === false) {
    return `CWTools is unavailable for this workspace: ${host.projectSupportReason ?? 'not a Paradox/CWT project.'}`;
  }
  if (host.projectKind === 'cwt-only') {
    return 'CWTools is running in CWT-only mode. Use the exposed document, navigation, and diagnostics tools for CWT rules; no game model is loaded.';
  }
  if (host.projectGameId === 'paradox') {
    return `${FULL_SERVER_INSTRUCTIONS}\n\nThe exact game is unknown. Generic Paradox mode is active; no game-specific rules or vanilla cache are assumed. Pass --game to enable a specific game model.`;
  }
  return FULL_SERVER_INSTRUCTIONS;
}

export function listServerTools(host: HostServices) {
  if (host.projectSupported === false || host.projectKind === 'unsupported' || host.projectKind === 'ambiguous') return [];
  return listRegisteredTools({
    includeWrites: host.writesEnabled === true && host.readonlyMode === false,
    cwtOnly: host.projectKind === 'cwt-only',
  });
}

export function createCwtoolsMcpServer(
  host: HostServices,
  options: { dispatcher?: SharedToolDispatcher } = {},
): Server {
  // Undefined => treat as supported (e.g. the in-extension host never sets it).
  const supported = host.projectSupported !== false;
  const server = new Server(
    {
      name: 'cwtools-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
      instructions: serverInstructions(host),
    },
  );
  const callTool = createToolCallHandler(host, options.dispatcher);

  // Unsupported projects disclose no schemas. Calls are still gated below for
  // clients holding a cached tool list from a previous workspace/session.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listServerTools(host) }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResources(host),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async request =>
    readResource(host, request.params.uri),
  );

  server.setRequestHandler(CallToolRequestSchema, async request => {
    // On an unsupported workspace, reject before dispatch so the language server
    // is never spawned (memory). The message is actionable: the resolved
    // workspace is almost always the cause when this fires on a real mod.
    if (!supported) {
      return toMcpCallToolResult({
        ok: false,
        status: 'denied',
        source: 'cwtools-mcp',
        error: {
          code: host.projectKind === 'ambiguous' ? 'project_ambiguous' : 'project_not_supported',
          message:
            `CWTools is disabled for this workspace (${host.workspaceRoot}): ${host.projectSupportReason ?? 'not a Paradox/CWT project.'} ` +
            'If this IS a mod, point the server at the mod root — set the working directory (or pass --workspace <mod>) — or pass --force-start to override.',
        },
      });
    }
    const args = request.params.arguments && typeof request.params.arguments === 'object'
      ? request.params.arguments as Record<string, unknown>
      : {};
    const result = await callTool(request.params.name, args);
    return toMcpCallToolResult(result);
  });

  return server;
}
