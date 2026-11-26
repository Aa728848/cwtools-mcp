import path from 'path';
import type { HostServices } from '../host/hostServices';
import { throwIfAborted } from '../host/lsp';
import { resolveWorkspacePath } from '../safety/paths';
import { sha256Text } from './pdxWriteCore';
import {
  candidateTransactionWithHost,
  stageTextCandidateWithHost,
  textCandidateWithHost,
  type DomainWriteContext,
} from './pdxWrites';
import type { SharedToolResult } from './schema';
import {
  applyShipDesignOperation,
  parseShipDesignDocument,
  ShipDesignEditError,
  type ShipDesignOperation,
} from '../editors/shipDesign';
import { parseStaticGalaxy } from '../editors/staticGalaxyParser';
import {
  buildStaticGalaxyEdits,
  StaticGalaxyEditError,
  type StaticGalaxyEditRequest,
} from '../editors/staticGalaxyEditBuilder';

/**
 * Candidate write-back helpers for the DSH-native Ship Design and Static Galaxy
 * editors.
 *
 * These compose the pure, shared edit builders (ship design + static galaxy)
 * with the existing bounded candidate transaction in ./pdxWrites: every write
 * is staged as a hashed candidate, chained to the parsed base hash, and only
 * committed through the validated transaction (sorted multi-file locks,
 * exclusivity, rollback). Nothing here writes the browser or the disk directly.
 *
 * The pure builders never run in a browser write path; a browser client calls
 * these through the Host adapter, which owns the actual commit.
 */

const SOURCE = 'cwtools-shared';
const DRAFT_ACTIONS = new Set(['begin', 'apply', 'validate', 'commit', 'discard', 'status']);

export interface ShipDesignDraftData {
  success: boolean;
  action: string;
  transactionId?: string;
  filePath?: string;
  baseHash?: string;
  contentHash?: string;
  designs?: ReturnType<typeof parseShipDesignDocument>['designs'];
  diagnostics?: ReturnType<typeof parseShipDesignDocument>['diagnostics'];
  hasSyntaxErrors?: boolean;
  summary?: string;
  result?: unknown;
  error?: string;
}

export interface StaticGalaxyDraftData {
  success: boolean;
  action: string;
  transactionId?: string;
  filePath?: string;
  baseHash?: string;
  contentHash?: string;
  summary?: string;
  result?: unknown;
  error?: string;
}

function failure<T>(code: string, message: string): SharedToolResult<T> {
  return { ok: false, status: 'error', source: SOURCE, error: { code, message } };
}
function success<T>(data: T): SharedToolResult<T> {
  return { ok: true, status: 'ready', source: SOURCE, data };
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve a workspace-contained .txt path or return a typed failure. */
function resolveTxt(
  host: HostServices,
  input: unknown,
): { resolvedPath: string; relativePath: string } | { code: string; message: string } {
  if (typeof input !== 'string') return { code: 'invalid_arguments', message: 'filePath is required.' };
  const resolved = resolveWorkspacePath(host.workspaceRoot, input);
  if (!resolved.ok || resolved.resolvedPath === undefined || resolved.relativePath === undefined) {
    return { code: 'invalid_path', message: 'A workspace-contained path is required.' };
  }
  if (path.extname(resolved.resolvedPath).toLowerCase() !== '.txt') {
    return { code: 'invalid_path', message: 'Only .txt PDX files are supported.' };
  }
  return { resolvedPath: resolved.resolvedPath, relativePath: resolved.relativePath };
}

/** Existing candidate for a file, or undefined when no transaction covers it. */
function requireCandidate(host: HostServices, resolvedPath: string) {
  const candidate = textCandidateWithHost(host, resolvedPath);
  if (candidate === undefined) {
    throw new Error('No active candidate contains this file; call action "begin" first.');
  }
  return candidate;
}

// ─── Ship Design ─────────────────────────────────────────────────────────────

const SHIP_FIELDS = new Set(['action', 'filePath', 'transactionId', 'operation', 'validationPassed']);

/**
 * Bounded Ship Design draft over the shared validated candidate transaction.
 * begin: parse the file and stage it unchanged (hash baseline).
 * apply: run the pure ship-design operation against the staged candidate, then
 *        stage the result chained to the base hash (stale edits are rejected).
 * validate/commit/discard/status: delegated to the shared candidate transaction.
 */
export async function shipDesignDraftWithHost(
  host: HostServices,
  args: Record<string, unknown>,
  context?: DomainWriteContext,
): Promise<SharedToolResult<ShipDesignDraftData>> {
  throwIfAborted(context?.signal);
  const extra = Object.keys(args).filter(key => !SHIP_FIELDS.has(key));
  if (extra.length > 0) return failure('invalid_arguments', 'Unsupported field(s): ' + extra.join(', '));
  const action = args.action;
  if (typeof action !== 'string' || !DRAFT_ACTIONS.has(action)) {
    return failure('invalid_arguments', 'Unknown ship_design_draft action.');
  }

  if (action === 'validate' || action === 'commit' || action === 'discard' || action === 'status') {
    const delegated = await candidateTransactionWithHost(host, {
      action,
      ...(typeof args.transactionId === 'string' ? { transactionId: args.transactionId } : {}),
      ...(typeof args.validationPassed === 'boolean' ? { validationPassed: args.validationPassed } : {}),
    }, context, 'ship_design_draft');
    return delegated as SharedToolResult<ShipDesignDraftData>;
  }

  const resolved = resolveTxt(host, args.filePath);
  if ('code' in resolved) return failure(resolved.code, resolved.message);

  if (action === 'begin') {
    const begun = await candidateTransactionWithHost(host, { action: 'begin' }, context, 'ship_design_draft');
    if (!begun.ok) return begun as SharedToolResult<ShipDesignDraftData>;
    try {
      const file = await host.filesystem.readTextFile(resolved.resolvedPath);
      if (!file.exists) throw new Error('Ship design file does not exist.');
      const content = file.content.charCodeAt(0) === 0xfeff ? file.content.slice(1) : file.content;
      const baseHash = sha256Text(content);
      const staged = stageTextCandidateWithHost(host, resolved.resolvedPath, content, baseHash, 'ship_design_draft');
      const parsed = parseShipDesignDocument(content);
      return success({
        success: true,
        action,
        transactionId: staged.transactionId,
        filePath: resolved.relativePath,
        baseHash,
        contentHash: staged.contentHash,
        designs: parsed.designs,
        diagnostics: parsed.diagnostics,
        hasSyntaxErrors: parsed.hasSyntaxErrors,
      });
    } catch (error) {
      await candidateTransactionWithHost(host, { action: 'discard' }, context, 'ship_design_draft');
      return failure('draft_failed', errorText(error));
    }
  }

  // action === 'apply'
  try {
    if (args.operation === undefined || typeof args.operation !== 'object' || args.operation === null) {
      throw new Error('operation must be a ShipDesignOperation object.');
    }
    const candidate = requireCandidate(host, resolved.resolvedPath);
    let next: string;
    let summary: string;
    try {
      const result = applyShipDesignOperation(candidate.content, args.operation as ShipDesignOperation);
      next = result.text;
      summary = 'applied ' + (args.operation as { kind?: string }).kind;
    } catch (error) {
      if (error instanceof ShipDesignEditError) return failure(error.code, error.message);
      throw error;
    }
    const staged = stageTextCandidateWithHost(host, resolved.resolvedPath, next, candidate.baseHash, 'ship_design_draft');
    const parsed = parseShipDesignDocument(next);
    return success({
      success: true,
      action,
      transactionId: staged.transactionId,
      filePath: resolved.relativePath,
      baseHash: candidate.baseHash,
      contentHash: staged.contentHash,
      designs: parsed.designs,
      diagnostics: parsed.diagnostics,
      hasSyntaxErrors: parsed.hasSyntaxErrors,
      summary,
    });
  } catch (error) {
    return failure('draft_failed', errorText(error));
  }
}

// ─── Static Galaxy ───────────────────────────────────────────────────────────

const GALAXY_FIELDS = new Set(['action', 'filePath', 'transactionId', 'request', 'validationPassed']);

function applyReplacements(
  text: string,
  replacements: ReturnType<typeof buildStaticGalaxyEdits>['replacements'],
): string {
  let out = text;
  // buildStaticGalaxyEdits returns replacements sorted back-to-front by start,
  // so applying them in order never shifts an earlier span.
  for (const replacement of replacements) {
    out = out.slice(0, replacement.span.start) + replacement.text + out.slice(replacement.span.end);
  }
  return out;
}

/**
 * Bounded Static Galaxy draft over the shared validated candidate transaction.
 * begin: parse scenarios and stage the file unchanged (hash baseline).
 * apply: run the pure galaxy edit request against the staged candidate and stage
 *        the result chained to the base hash (stale spans are rejected).
 * validate/commit/discard/status: delegated to the shared candidate transaction.
 */
export async function staticGalaxyDraftWithHost(
  host: HostServices,
  args: Record<string, unknown>,
  context?: DomainWriteContext,
): Promise<SharedToolResult<StaticGalaxyDraftData>> {
  throwIfAborted(context?.signal);
  const extra = Object.keys(args).filter(key => !GALAXY_FIELDS.has(key));
  if (extra.length > 0) return failure('invalid_arguments', 'Unsupported field(s): ' + extra.join(', '));
  const action = args.action;
  if (typeof action !== 'string' || !DRAFT_ACTIONS.has(action)) {
    return failure('invalid_arguments', 'Unknown static_galaxy_draft action.');
  }

  if (action === 'validate' || action === 'commit' || action === 'discard' || action === 'status') {
    const delegated = await candidateTransactionWithHost(host, {
      action,
      ...(typeof args.transactionId === 'string' ? { transactionId: args.transactionId } : {}),
      ...(typeof args.validationPassed === 'boolean' ? { validationPassed: args.validationPassed } : {}),
    }, context, 'static_galaxy_draft');
    return delegated as SharedToolResult<StaticGalaxyDraftData>;
  }

  const resolved = resolveTxt(host, args.filePath);
  if ('code' in resolved) return failure(resolved.code, resolved.message);

  if (action === 'begin') {
    const begun = await candidateTransactionWithHost(host, { action: 'begin' }, context, 'static_galaxy_draft');
    if (!begun.ok) return begun as SharedToolResult<StaticGalaxyDraftData>;
    try {
      const file = await host.filesystem.readTextFile(resolved.resolvedPath);
      if (!file.exists) throw new Error('Static galaxy scenario file does not exist.');
      const content = file.content.charCodeAt(0) === 0xfeff ? file.content.slice(1) : file.content;
      const baseHash = sha256Text(content);
      const staged = stageTextCandidateWithHost(host, resolved.resolvedPath, content, baseHash, 'static_galaxy_draft');
      return success({
        success: true,
        action,
        transactionId: staged.transactionId,
        filePath: resolved.relativePath,
        baseHash,
        contentHash: staged.contentHash,
      });
    } catch (error) {
      await candidateTransactionWithHost(host, { action: 'discard' }, context, 'static_galaxy_draft');
      return failure('draft_failed', errorText(error));
    }
  }

  // action === 'apply'
  try {
    if (args.request === undefined || typeof args.request !== 'object' || args.request === null) {
      throw new Error('request must be a StaticGalaxyEditRequest object.');
    }
    const candidate = requireCandidate(host, resolved.resolvedPath);
    const parsed = parseStaticGalaxy(candidate.content);
    if (!parsed.ok) {
      return failure('parse_failed', parsed.error ?? 'The candidate no longer parses as a static galaxy scenario.');
    }
    let next: string;
    let summary: string;
    try {
      const built = buildStaticGalaxyEdits(args.request as StaticGalaxyEditRequest, {
        text: candidate.content,
        scenarios: parsed.scenarios,
      });
      next = applyReplacements(candidate.content, built.replacements);
      summary = built.summary;
    } catch (error) {
      if (error instanceof StaticGalaxyEditError) return failure(error.code, error.message);
      throw error;
    }
    const staged = stageTextCandidateWithHost(host, resolved.resolvedPath, next, candidate.baseHash, 'static_galaxy_draft');
    return success({
      success: true,
      action,
      transactionId: staged.transactionId,
      filePath: resolved.relativePath,
      baseHash: candidate.baseHash,
      contentHash: staged.contentHash,
      summary,
    });
  } catch (error) {
    return failure('draft_failed', errorText(error));
  }
}