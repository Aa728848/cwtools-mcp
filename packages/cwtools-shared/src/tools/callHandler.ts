import type { HostServices } from '../host/hostServices';
import { throwIfAborted } from '../host/lsp';
import { annotateReadiness, LOAD_DEPENDENT_TOOLS, parseReadiness, type LspReadiness } from '../host/readiness';
import { annotateVanillaCache } from '../host/vanillaCache';
import { isMcpToolAvailable } from './mcpSchema';
import { defaultSharedToolDispatcher, type SharedToolContext, type SharedToolDispatcher } from './toolHandlers';
import type { SharedToolResult } from './schema';

// Transport-neutral tool entry point. Every consumer — MCP stdio/http, the
// extension bridge, a Node host running in-process, an editor integration —
// routes calls through this one function so the write policy, generic-mode
// warning, vanilla provenance and load-readiness annotations cannot drift
// between surfaces.
//
// Deliberately free of any MCP SDK type: `toMcpCallToolResult` stays in the MCP
// package, and this module depends only on the shared host + dispatcher.

/** Per-call context. `signal` cancels the underlying backend work. */
export type ToolCallContext = SharedToolContext;

export type SharedToolHandler = (
  name: string,
  args?: Record<string, unknown>,
  context?: ToolCallContext,
) => Promise<SharedToolResult>;

export const GENERIC_PARADOX_WARNING =
  'Generic Paradox mode: the exact game is unknown; no game-specific rules or vanilla data are assumed. Pass --game to select a game.';

export function createToolCallHandler(
  host: HostServices,
  dispatcher: SharedToolDispatcher = defaultSharedToolDispatcher,
): SharedToolHandler {
  // The game stays loaded once ready, so a successful probe is cached — but only
  // until a call reports the backend gone. A cached `ready` outliving the LSP is
  // why degraded calls kept advertising `readiness.ready: true`.
  let ready = false;
  const probeReadiness = async (context?: ToolCallContext, force = false): Promise<LspReadiness | undefined> => {
    if (ready && !force) return { ready: true };
    try {
      const status = await host.lsp.executeCommand('cwtools.ai.getValidationStatus', [], {
        timeoutMs: 8000,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      const verdict = parseReadiness(status);
      ready = verdict.ready;
      return verdict;
    } catch (error) {
      // A cancelled probe is not an absent backend: surface the abort instead of
      // reporting `lsp_unavailable`.
      throwIfAborted(context?.signal);
      throw error;
    }
  };

  return async (name, args = {}, context) => {
    throwIfAborted(context?.signal);
    const writesEnabled = host.writesEnabled === true && host.readonlyMode === false;
    const cwtOnly = host.projectKind === 'cwt-only';
    if (!isMcpToolAvailable(name, { includeWrites: writesEnabled, cwtOnly })) {
      return {
        ok: false,
        status: 'denied',
        source: 'cwtools-shared',
        error: {
          code: cwtOnly ? 'tool_not_available_in_cwt_only' : 'tool_not_available',
          message: cwtOnly
            ? `Tool '${name}' requires a full Paradox game model and is not available in a CWT-only workspace.`
            : `Tool '${name}' is not available under the current host write policy.`,
        },
      };
    }
    const result = await dispatcher(host, name, args, context);
    const withGenericWarning = host.projectGameId === 'paradox'
      ? {
          ...result,
          warnings: [...(result.warnings ?? []), GENERIC_PARADOX_WARNING],
        }
      : result;
    // Tag vanilla-dependent results with cache provenance so clients never read a
    // mod-only answer as complete.
    const withVanilla = annotateVanillaCache(name, withGenericWarning, host.vanillaCache);
    // For load-dependent tools, mark results produced before the game is ready as
    // `loading` so clients retry instead of trusting an empty answer.
    if (!LOAD_DEPENDENT_TOOLS.has(name)) return withVanilla;
    // Re-probe after a transport-shaped failure so a dead backend cannot keep
    // riding on a cached `ready` from an earlier call.
    const lostBackend = result.ok === false && result.status === 'unavailable';
    return annotateReadiness(name, withVanilla, await probeReadiness(context, lostBackend));
  };
}

/** Convenience wrapper for hosts that keep one handler per host instance. */
export function bindToolCallHandler(
  host: HostServices,
  dispatcher: SharedToolDispatcher = defaultSharedToolDispatcher,
): SharedToolHandler {
  return createToolCallHandler(host, dispatcher);
}
