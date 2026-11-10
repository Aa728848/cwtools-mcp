import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import { throwIfAborted } from '../host/lsp';
import { analyzeDiagnosticKnowledge } from '../knowledge/diagnosticRouting';
import {
  explainScopeWithHost,
  queryCwtSchemaWithHost,
  queryRulesWithHost,
  searchRuleCapabilitiesWithHost,
} from '../knowledge/rules';
import { queryProjectProfileWithHost } from '../project/profile';
import { queryProjectKnowledgeWithHost } from '../project/knowledge';
import { writeLocalisationWithHost } from '../safety/localisation';
import { getPdxBlockWithHost } from './pdxBlock';
import { executeTargetingWeightQuery } from './targetingWeights';
import { toolUnavailable, type SharedToolResult } from './schema';
import {
  documentSymbolsWithHost,
  getCompletionAtWithHost,
  queryDefinitionByNameWithHost,
  queryDefinitionWithHost,
  queryReferencesWithHost,
  workspaceSymbolsWithHost,
} from './symbols';

/** Per-call context threaded from the transport (cancellation, and future knobs). */
export interface SharedToolContext {
  signal?: AbortSignal;
}

export type SharedToolDispatcher = (
  host: HostServices,
  name: string,
  args: Record<string, unknown>,
  context?: SharedToolContext,
) => Promise<SharedToolResult>;

function invalidArguments(message: string): SharedToolResult {
  return {
    ok: false,
    status: 'error',
    source: 'cwtools-shared',
    error: { code: 'invalid_arguments', message },
  };
}

function errorMessageOf(record: Record<string, unknown>): string {
  const error = record.error;
  if (typeof error === 'string' && error.trim()) return error;
  const nested = asRecord(error);
  if (typeof nested.message === 'string' && nested.message.trim()) return nested.message;
  if (typeof record.message === 'string' && record.message.trim()) return record.message;
  return 'CWTools LSP command reported a failure.';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function executeLspTool(
  host: HostServices,
  command: string,
  args: unknown[],
  unavailableNextStep: string,
  signal?: AbortSignal,
): Promise<SharedToolResult> {
  // Cancellation must not be laundered into `unavailable`: the caller asked to
  // stop, so the abort error propagates untouched.
  throwIfAborted(signal);
  const result = await host.lsp.executeCommand(command, args, signal ? { signal } : undefined);
  const record = asRecord(result);
  const errorRecord = asRecord(record.error);
  const unavailable = record.status === 'unavailable' || errorRecord.code === 'lsp_unavailable';
  // A command that answered `ok: false` (unknown symbol, unsupported argument) is a
  // failure, not an empty success: wrapping it in `ok: true` made callers report
  // "found nothing" for "could not look".
  const failed = !unavailable && record.ok === false;
  return {
    ok: !unavailable && !failed,
    status: unavailable ? 'unavailable' : failed ? 'error' : 'ready',
    source: 'cwtools-lsp',
    data: result,
    error: unavailable
      ? {
          code: String(errorRecord.code ?? 'lsp_unavailable'),
          message: String(errorRecord.message ?? 'LSP command is unavailable.'),
        }
      : failed
        ? {
            code: String(errorRecord.code ?? 'lsp_command_failed'),
            message: errorMessageOf(record),
          }
        : undefined,
    nextSteps: unavailable ? [unavailableNextStep] : undefined,
  };
}

export const defaultSharedToolDispatcher: SharedToolDispatcher = async (host, name, rawArgs, context) => {
  const args = asRecord(rawArgs);
  const signal = context?.signal;
  const lspTool = (command: string, args: unknown[], unavailableNextStep: string) =>
    executeLspTool(host, command, args, unavailableNextStep, signal);
  throwIfAborted(signal);
  switch (name) {
    case 'query_project_profile':
      return queryProjectProfileWithHost(host, args);

    case 'query_project_knowledge':
      return queryProjectKnowledgeWithHost(host, args);

    case 'query_workspace_index': {
      if (!host.indexing) {
        return toolUnavailable(name, 'Workspace index is not available in this host.', [
          'Wire an LSP index command or a thin Node index before using this tool for semantic evidence.',
        ]);
      }
      const data = await host.indexing.queryWorkspace(args);
      const status: SharedToolResult['status'] = data.status === 'ready'
        ? 'ready'
        : data.status === 'partial'
          ? 'partial'
          : data.status === 'error'
            ? 'error'
            : data.status === 'unavailable'
              ? 'unavailable'
              : 'loading';
      return {
        ok: true,
        status,
        source: 'cwtools-index',
        data,
      };
    }

    case 'explore_pdx_project': {
      if (args.exact !== undefined && typeof args.exact !== 'boolean') {
        return invalidArguments('exact must be a boolean; pass the identifier in query.');
      }
      if (args.exact === true && (typeof args.query !== 'string' || args.query.trim() === '')) {
        return invalidArguments('exact requires a non-empty query; omit exact to browse by typeName or file.');
      }
      return lspTool(
        'cwtools.ai.exploreProject',
        [
          typeof args.query === 'string' ? args.query : '',
          typeof args.file === 'string' && args.file ? toFileUri(args.file, host.workspaceRoot) : '',
          typeof args.typeName === 'string' ? args.typeName : '',
          args.exact === true,
          args.depth ?? 1,
          args.maxNodes ?? 30,
          args.maxEdges ?? 80,
          args.includeMetadata !== false,
        ],
        'Start the CWTools LSP process and wait for the game model to load before exploring the semantic graph.',
      );
    }

    case 'analyze_pdx_flow': {
      const file = typeof args.file === 'string' ? args.file.trim() : '';
      const definitionId = typeof args.definitionId === 'string' ? args.definitionId.trim() : '';
      if (!file && !definitionId) {
        return {
          ok: false,
          status: 'error',
          source: 'cwtools-shared',
          error: {
            code: 'invalid_arguments',
            message: 'analyze_pdx_flow requires a file or a definitionId.',
          },
        };
      }
      return lspTool(
        'cwtools.ai.analyzePdxFlow',
        [{
          ...(file ? { file } : {}),
          ...(definitionId ? { definitionId } : {}),
          ...(typeof args.entityType === 'string' && args.entityType.trim() ? { entityType: args.entityType.trim() } : {}),
          limit: Math.max(1, Math.min(Number(args.limit ?? 100) || 100, 500)),
        }],
        'Start the CWTools LSP process and wait for the game model to load before analyzing flow cost and gameplay relations.',
      );
    }

    case 'compare_definition_with_vanilla': {
      if (typeof args.entityType !== 'string' || typeof args.symbolId !== 'string' || !args.entityType.trim() || !args.symbolId.trim()) {
        return {
          ok: false,
          status: 'error',
          source: 'cwtools-shared',
          error: {
            code: 'invalid_arguments',
            message: 'compare_definition_with_vanilla requires entityType and symbolId.',
          },
        };
      }
      return lspTool(
        'cwtools.ai.compareDefinitionWithVanilla',
        [args.entityType.trim(), args.symbolId.trim()],
        'Start the CWTools LSP process and wait for the game model to load before comparing the definition with vanilla.',
      );
    }

    case 'query_inline_instantiation': {
      const template = typeof args.template === 'string' ? args.template.trim() : '';
      const file = typeof args.file === 'string' ? args.file.trim() : '';
      if (!template && !file) {
        return {
          ok: false,
          status: 'error',
          source: 'cwtools-shared',
          error: {
            code: 'invalid_arguments',
            message: 'query_inline_instantiation requires a template path or a caller file (optionally with line).',
          },
        };
      }
      return lspTool(
        'cwtools.ai.exploreInlineGraph',
        [{
          ...(template ? { template } : {}),
          ...(file ? { file } : {}),
          ...(Number.isInteger(args.line) ? { line: Number(args.line) } : {}),
          limit: Math.max(1, Math.min(Number(args.limit ?? 50) || 50, 200)),
        }],
        'Start the CWTools LSP process and wait for the game model to load before resolving the inline template instantiation.',
      );
    }

    case 'query_targeting_weight': {
      // Pure computation: no host, no I/O, and no backend to wait for. The shared
      // implementation is the single source of truth for the formula, so the MCP
      // surface, the in-extension agent and the panel produce identical numbers
      // for the same inputs.
      const data = executeTargetingWeightQuery(args);
      const failure = typeof data.error === 'string' ? data.error : undefined;
      return {
        ok: failure === undefined,
        status: failure === undefined ? 'ready' : 'error',
        source: 'cwtools-shared',
        data,
        error: failure === undefined ? undefined : { code: 'invalid_arguments', message: failure },
      };
    }

    case 'query_localisation_index': {
      if (!host.indexing) {
        return toolUnavailable(name, 'Localisation index is not available in this host.', [
          'Wire an LSP index command or a thin Node index before using this tool for localisation evidence.',
        ]);
      }
      const data = await host.indexing.queryLocalisation(args);
      const semanticAudit = args.auditMode === true
        ? await lspTool(
            'cwtools.ai.queryLocalisationAudit',
            [{
              ...(typeof args.key === 'string' ? { key: args.key } : {}),
              prefix: args.prefix === true,
              contains: args.contains === true,
              caseSensitive: args.caseSensitive === true,
              limit: Math.max(1, Math.min(Number(args.limit ?? 100) || 100, 500)),
            }],
            'Start the CWTools LSP process and wait for localisation validation before requesting auditMode.',
          )
        : undefined;
      return {
        ok: true,
        status: 'ready',
        source: 'cwtools-index',
        data: semanticAudit ? { ...data, semanticAudit } : data,
      };
    }

    case 'get_diagnostics':
      {
        const diagnostics = await host.diagnostics.getDiagnostics(args, signal ? { signal } : undefined);
        const suppressed = diagnostics.suppressedCount ?? 0;
        return {
          ok: diagnostics.ok,
          status: diagnostics.status === 'unavailable' ? 'unavailable' : diagnostics.status === 'stale' ? 'stale' : diagnostics.status === 'pending' ? 'loading' : 'ready',
          source: 'cwtools-diagnostics',
          data: diagnostics,
          error: diagnostics.error,
          // An empty page is not an empty project: say so when the workspace ignore
          // list removed entries, and point at the missing backend when it answered
          // "unavailable" instead of leaving a bare error behind.
          warnings: suppressed > 0
            ? [`${suppressed} diagnostic(s) on this page were hidden by the workspace ignore list (stellarisLanguageServices.ai.ignoredDiagnostics); they still count in totalCount.`]
            : undefined,
          nextSteps: diagnostics.ok
            ? undefined
            : ['Check that the CWTools backend is running (extension active, or a standalone server), then retry get_diagnostics.'],
        };
      }

    case 'analyze_diagnostic_error':
      return {
        ok: true,
        status: 'ready',
        source: 'cwtools-knowledge',
        data: analyzeDiagnosticKnowledge({
          code: typeof args.code === 'string' ? args.code : undefined,
          message: typeof args.message === 'string' ? args.message : undefined,
        }),
      };

    case 'write_localisation':
      return writeLocalisationWithHost(host, {
        filePath: String(args.filePath ?? args.file ?? ''),
        language: typeof args.language === 'string' ? args.language : undefined,
        entries: Array.isArray(args.entries) ? args.entries as never : [],
      });

    case 'get_completion_at':
      return getCompletionAtWithHost(host, {
        file: String(args.file ?? ''),
        line: Number(args.line ?? 0),
        column: Number(args.column ?? 0),
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });

    case 'document_symbols':
      return documentSymbolsWithHost(host, {
        file: String(args.file ?? ''),
      });

    case 'workspace_symbols':
      return workspaceSymbolsWithHost(host, {
        query: String(args.query ?? ''),
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });

    case 'go_to_definition':
      return typeof args.symbolName === 'string' && args.symbolName.trim()
        ? queryDefinitionByNameWithHost(host, { symbolName: args.symbolName })
        : queryDefinitionWithHost(host, {
            file: String(args.file ?? ''),
            line: Number(args.line ?? 0),
            column: Number(args.column ?? 0),
          });

    case 'find_references':
      return queryReferencesWithHost(host, {
        identifier: typeof args.identifier === 'string' ? args.identifier : undefined,
        file: typeof args.file === 'string' ? args.file : undefined,
        line: typeof args.line === 'number' ? args.line : undefined,
        column: typeof args.column === 'number' ? args.column : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });

    case 'query_scope':
      return lspTool(
        'cwtools.ai.getScopeAtPosition',
        [toFileUri(String(args.file ?? ''), host.workspaceRoot), args.line, args.column],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_types':
      return lspTool(
        'cwtools.ai.queryTypes',
        [args.typeName, args.filter ?? '', args.limit ?? 30, args.vanilla === true],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_rules':
      return queryRulesWithHost(host, {
        category: String(args.category ?? 'trigger') as never,
        name: typeof args.name === 'string' ? args.name : undefined,
        scope: typeof args.scope === 'string' ? args.scope : undefined,
      });

    case 'query_cwt_schema':
      return queryCwtSchemaWithHost(host, {
        target: typeof args.target === 'string' ? args.target : undefined,
        file: typeof args.file === 'string' ? args.file : undefined,
        directory: typeof args.directory === 'string' ? args.directory : undefined,
        name: typeof args.name === 'string' ? args.name : undefined,
        includeContent: args.includeContent === true,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });

    case 'search_rule_capabilities':
      return searchRuleCapabilitiesWithHost(host, {
        intent: typeof args.intent === 'string' ? args.intent : undefined,
        category: typeof args.category === 'string' ? args.category as never : undefined,
        currentScope: typeof args.currentScope === 'string' ? args.currentScope : undefined,
        desiredPushScope: typeof args.desiredPushScope === 'string' ? args.desiredPushScope : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });

    case 'explain_scope':
      return explainScopeWithHost(host, {
        scope: String(args.scope ?? ''),
      });

    case 'parse_pdx_fragment':
      return lspTool(
        'cwtools.ai.parseFragment',
        [String(args.code ?? '')],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_scripted_effects':
      return lspTool(
        'cwtools.ai.queryScriptedEffects',
        [args.filter ?? '', args.limit ?? 50],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_scripted_triggers':
      return lspTool(
        'cwtools.ai.queryScriptedTriggers',
        [args.filter ?? '', args.limit ?? 50],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_enums':
      return lspTool(
        'cwtools.ai.queryEnums',
        [args.enumName ?? '', args.limit ?? 500],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_static_modifiers':
      return lspTool(
        'cwtools.ai.queryStaticModifiers',
        [args.filter ?? '', args.limit ?? 300],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_variables':
      return lspTool(
        'cwtools.ai.queryVariables',
        [args.filter ?? ''],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'get_entity_info':
      return lspTool(
        'cwtools.ai.getEntityInfo',
        [toFileUri(String(args.file ?? ''), host.workspaceRoot)],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'get_pdx_block':
      return getPdxBlockWithHost(host, {
        file: String(args.file ?? ''),
        symbol: String(args.symbol ?? ''),
      });

    // Shader knowledge tools: each LSP command takes a single JSON record
    // argument and returns { ok, ... } / { ok: false, status: 'error', ... }.
    case 'query_shader_symbol':
      return lspTool(
        'cwtools.ai.shader.symbols',
        [shaderRecord({
          filter: typeof args.filter === 'string' ? args.filter : undefined,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          cursor: typeof args.cursor === 'number' ? args.cursor : undefined,
        })],
        'Start the CWTools LSP process and wait for the shader model to load before querying shader symbols.',
      );

    case 'query_shader_compile_unit':
      return lspTool(
        'cwtools.ai.shader.compileUnit',
        [{ uri: toFileUri(String(args.file ?? ''), host.workspaceRoot) }],
        'Start the CWTools LSP process and wait for the shader model to load before resolving compile units.',
      );

    case 'query_shader_platform_variants':
      return lspTool(
        'cwtools.ai.shader.variants',
        [{ uri: toFileUri(String(args.file ?? ''), host.workspaceRoot) }],
        'Start the CWTools LSP process and wait for the shader model to load before comparing shader platform variants.',
      );

    case 'query_shader_callers':
      return lspTool(
        'cwtools.ai.shader.callers',
        [shaderRecord({
          effectName: String(args.effectName ?? ''),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        })],
        'Start the CWTools LSP process and wait for the shader model to load before querying Effect callers.',
      );

    case 'explain_shader_reachability':
      return lspTool(
        'cwtools.ai.shader.reachability',
        [typeof args.effectName === 'string' && args.effectName
          ? { effectName: args.effectName }
          : shaderRecord({
              uri: toFileUri(String(args.file ?? ''), host.workspaceRoot),
              limit: typeof args.limit === 'number' ? args.limit : undefined,
              cursor: typeof args.cursor === 'number' ? args.cursor : undefined,
            })],
        'Start the CWTools LSP process and wait for the shader model to load before explaining Effect reachability.',
      );

    case 'validate_shader':
      return lspTool(
        'cwtools.ai.shader.validate',
        [{ uri: toFileUri(String(args.file ?? ''), host.workspaceRoot) }],
        'Start the CWTools LSP process and wait for the shader model to load before validating shader files.',
      );

    case 'compare_shader_with_vanilla':
      return lspTool(
        'cwtools.ai.shader.compareVanilla',
        [typeof args.effectName === 'string' && args.effectName
          ? { effectName: args.effectName }
          : { uri: toFileUri(String(args.file ?? ''), host.workspaceRoot) }],
        'Start the CWTools LSP process and wait for the shader model to load before comparing with vanilla.',
      );

    case 'get_ide_context':
    case 'open_in_visual_editor':
      return toolUnavailable(
        name,
        `${name} requires the active VS Code extension bridge (default mode without --standalone).`,
        ['Open the project in VS Code / Cursor / Antigravity with the CWTools extension active and connect via bridge mode.'],
      );

    case 'typed_pdx_write':
    case 'candidate_transaction':
    case 'convert_image_to_dds':
    case 'convert_audio':
    case 'deploy_mod_asset':
      return toolUnavailable(
        name,
        `${name} requires the active VS Code extension bridge started with --allow-domain-writes (or --enable-writes).`,
        ['Connect to the active VS Code extension bridge with --allow-domain-writes enabled.'],
      );

    default:
      return {
        ok: false,
        status: 'error',
        source: 'cwtools-shared',
        error: {
          code: 'unknown_tool',
          message: `Unknown MCP tool: ${name}`,
        },
      };
  }
};

function toFileUri(filePath: string, workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot, filePath).replace(/\\/g, '/');
  const withLeadingSlash = resolved.startsWith('/') ? resolved : `/${resolved}`;
  return `file://${encodeURI(withLeadingSlash).replace(/#/g, '%23')}`;
}

/** Drop undefined fields so the LSP command record only carries provided args. */
function shaderRecord(fields: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = value;
  }
  return record;
}