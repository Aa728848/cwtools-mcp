// Backend capability handshake.
//
// `cwtools.ai.getHostCapabilities` is an internal command: it is answered before
// the game model loads, it is not part of any model-facing tool schema, and it
// exists so a host can prove it is talking to a compatible build before it
// spends seconds (or gigabytes) loading a project.

/** Protocol version this client speaks. Bump when the response shape changes. */
export const HOST_CAPABILITIES_PROTOCOL_VERSION = 1;

export interface HostCapabilities {
  protocolVersion: number;
  serverVersion: string;
  commands: string[];
}

export const BACKEND_INCOMPATIBLE_CODE = 'backend_incompatible';

export type HostCapabilitiesVerdict =
  | { ok: true; capabilities: HostCapabilities }
  | { ok: false; reason: 'legacy' | 'malformed' | 'incomplete' | 'protocol'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted handshake payload. Anything that is not a complete,
 * well-formed, protocol-matching record is a rejection with a precise reason so
 * the caller can report `backend_incompatible` and release the backend rather
 * than running against a server whose command table it cannot trust.
 */
export function parseHostCapabilities(raw: unknown): HostCapabilitiesVerdict {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'legacy', message: 'Backend did not answer cwtools.ai.getHostCapabilities.' };
  }
  if (raw.status === 'unavailable' || isRecord(raw.error)) {
    return {
      ok: false,
      reason: 'legacy',
      message: `Backend rejected the capability handshake: ${String((isRecord(raw.error) ? raw.error.message : undefined) ?? 'unavailable')}.`,
    };
  }
  const protocolVersion = raw.protocolVersion;
  const serverVersion = raw.serverVersion;
  const commands = raw.commands;
  if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion)) {
    return { ok: false, reason: 'malformed', message: 'Backend handshake is missing an integer protocolVersion.' };
  }
  if (typeof serverVersion !== 'string' || serverVersion.trim().length === 0) {
    return { ok: false, reason: 'malformed', message: 'Backend handshake is missing a serverVersion string.' };
  }
  if (!Array.isArray(commands) || commands.some(command => typeof command !== 'string')) {
    return { ok: false, reason: 'malformed', message: 'Backend handshake is missing a string[] commands table.' };
  }
  if (protocolVersion !== HOST_CAPABILITIES_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: 'protocol',
      message: `Backend speaks capability protocol ${protocolVersion}; this client requires ${HOST_CAPABILITIES_PROTOCOL_VERSION}.`,
    };
  }
  if (commands.length === 0) {
    return { ok: false, reason: 'incomplete', message: 'Backend handshake reported an empty command table.' };
  }
  return {
    ok: true,
    capabilities: { protocolVersion, serverVersion: serverVersion.trim(), commands: [...commands] },
  };
}

/**
 * Every LSP command this client's tool surface actually calls. Derived from the
 * cwtools-shared dispatcher call sites plus the Node diagnostics/revalidation
 * hosts, so a backend missing any one of them is rejected up front instead of
 * degrading a single tool into an empty answer at call time.
 *
 * `cwtools.ai.getHostCapabilities` is deliberately absent: it is the handshake
 * itself and never a model-facing tool.
 */
export const REQUIRED_BACKEND_COMMANDS: readonly string[] = [
  // Readiness, diagnostics and manual revalidation.
  'cwtools.ai.getValidationStatus',
  'cwtools.ai.getDiagnosticsFresh',
  'cwtools.ai.getAllDiagnostics',
  'cwtools.ai.revalidateFiles',
  // Completion, symbols and navigation.
  'cwtools.ai.getCompletionContext',
  'cwtools.ai.getScopeAtPosition',
  'cwtools.ai.queryDefinition',
  'cwtools.ai.queryDefinitionByName',
  'cwtools.ai.getEntityInfo',
  // Semantic model and project graph.
  'cwtools.ai.queryTypes',
  'cwtools.ai.exploreProject',
  'cwtools.ai.exploreInlineGraph',
  'cwtools.ai.analyzePdxFlow',
  'cwtools.ai.compareDefinitionWithVanilla',
  'cwtools.ai.parseFragment',
  'cwtools.ai.queryProjectKnowledgeDb',
  // Localisation.
  'cwtools.ai.queryLocalisationAudit',
  // Scripted types and enums.
  'cwtools.ai.queryScriptedEffects',
  'cwtools.ai.queryScriptedTriggers',
  'cwtools.ai.queryEnums',
  'cwtools.ai.queryStaticModifiers',
  'cwtools.ai.queryVariables',
  // Shader surface: all seven commands are individually exposed as tools.
  'cwtools.ai.shader.symbols',
  'cwtools.ai.shader.compileUnit',
  'cwtools.ai.shader.variants',
  'cwtools.ai.shader.callers',
  'cwtools.ai.shader.reachability',
  'cwtools.ai.shader.validate',
  'cwtools.ai.shader.compareVanilla',
];

/**
 * Check a validated capability set against the commands this client requires.
 * A backend that is merely old is still rejected: the client cannot silently
 * degrade a semantic tool into an empty answer.
 */
export function checkRequiredCommands(
  capabilities: HostCapabilities,
  required: readonly string[] = REQUIRED_BACKEND_COMMANDS,
): HostCapabilitiesVerdict {
  const present = new Set(capabilities.commands);
  const missing = required.filter(command => !present.has(command));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'incomplete',
      message: `Backend is missing required commands: ${missing.join(', ')}.`,
    };
  }
  return { ok: true, capabilities };
}
