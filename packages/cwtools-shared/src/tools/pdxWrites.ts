import { createHash, randomUUID } from 'crypto';
import * as path from 'path';
import type { DiagnosticRecord } from '../host/diagnostics';
import type { FilesystemHost } from '../host/filesystem';
import type { HostServices } from '../host/hostServices';
import { throwIfAborted } from '../host/lsp';
import { isPathInsideOrEqual, normalizeWorkspaceRoot } from '../safety/paths';
import { ensureToolWriteAllowed } from '../safety/writes';
import type { SharedToolResult } from './schema';
import { buildTypedPdxCandidate, type TypedPdxCandidate } from './pdxWriteCore';

/**
 * Transport-neutral typed PDXScript writes plus the candidate transaction that
 * serialises them, so the MCP server and the VS Code agent share one contract.
 *
 * A candidate is built in memory, staged in a transaction, validated against the
 * host language server, and only then committed; every commit is lock-serialised
 * and rolled back when the post-write diagnostics regress. Workspace containment
 * is re-checked on the resolved path, so a staged file can never escape it.
 */

export interface DomainWriteContext {
  signal?: AbortSignal;
}

export interface CandidateTransactionArgs {
  action: 'begin' | 'status' | 'validate' | 'commit' | 'discard';
  transactionId?: string;
  validationPassed?: boolean;
}

export interface TypedPdxWriteResult {
  success: boolean;
  mode: 'preview' | 'stage';
  transactionId?: string;
  candidate?: TypedPdxCandidate;
  message?: string;
  error?: string;
}

export interface OverlayValidationFile {
  uri: string;
  ok: boolean;
  contentHash?: string;
  diagnostics: Array<{ code: string; severity: string; message: string; line: number; column: number }>;
  error?: string;
}

export interface OverlayValidation {
  validationLevel?: string;
  limitations?: string[];
  files: OverlayValidationFile[];
}

export interface CandidateTransactionResult {
  success: boolean;
  action: string;
  transactionId?: string;
  state?: string;
  files: string[];
  bytes: number;
  commit?: {
    committed: boolean;
    state: string;
    files: string[];
    rollback: { attempted: boolean; succeeded: boolean; paths: string[]; errors: Array<{ path: string; error: string }> };
  };
  diagnosticDeltas?: Record<string, DiagnosticDelta>;
  overlayValidation?: OverlayValidation;
  infrastructureError?: string;
  error?: string;
}

export interface DiagnosticSnapshotEntry {
  code: string;
  severity: string;
  message: string;
  line: number;
  column: number;
}

export interface DiagnosticDelta {
  comparable: boolean;
  added: DiagnosticSnapshotEntry[];
  removed: DiagnosticSnapshotEntry[];
}

const SOURCE = 'cwtools-domain-writes';
const MAX_FILE_CHARS = 2_000_000;
const MAX_CANDIDATE_FILES = 100;
const MAX_CANDIDATE_BYTES = 5 * 1024 * 1024;
const VALIDATION_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 30_000;
const FRESHNESS_TIMEOUT_MS = 8_000;
const FRESHNESS_POLL_MS = 100;
const DIAGNOSTIC_LIMIT = 2000;
function asRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortLike(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function toFileUri(filePath: string): string {
  const slashed = path.resolve(filePath).replace(/\\/g, '/');
  const prefixed = slashed.startsWith('/') ? slashed : '/' + slashed;
  return 'file://' + encodeURI(prefixed).replace(/#/g, '%23');
}

function invalidArguments(message: string): SharedToolResult {
  return { ok: false, status: 'error', source: SOURCE, error: { code: 'invalid_arguments', message } };
}

function failure(code: string, message: string): SharedToolResult {
  return { ok: false, status: 'error', source: SOURCE, error: { code, message } };
}

function success<T>(data: T): SharedToolResult<T> {
  return { ok: true, status: 'success', source: SOURCE, data };
}

/** Resolve a caller-supplied path inside the workspace, rejecting traversal. */
function resolveInsideWorkspace(host: HostServices, inputPath: unknown): { ok: true; resolvedPath: string; relativePath: string } | { ok: false; message: string } {
  const trimmed = typeof inputPath === 'string' ? inputPath.trim() : '';
  if (!trimmed) return { ok: false, message: 'A file path is required.' };
  const root = normalizeWorkspaceRoot(host.workspaceRoot);
  const resolved = path.resolve(root, trimmed);
  if (!isPathInsideOrEqual(root, resolved)) {
    return { ok: false, message: "Path '" + trimmed + "' is outside the workspace root." };
  }
  return { ok: true, resolvedPath: resolved, relativePath: path.relative(root, resolved).replace(/\\/g, '/') };
}

async function readDiskText(host: HostServices, filePath: string): Promise<string> {
  const read = await host.filesystem.readTextFile(filePath);
  if (!read.exists) return '';
  return read.content.charCodeAt(0) === 0xfeff ? read.content.slice(1) : read.content;
}

// ─── per-host serialisation and transaction state ──────────────────────────

type TransactionState = 'active' | 'validated' | 'committed' | 'discarded';

interface StagedEntry {
  path: string;
  content: string;
  contentHash: string;
  bytes: number;
  baseHash?: string;
}

interface RollbackReport {
  attempted: boolean;
  succeeded: boolean;
  paths: string[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Serialises commits per host. Sorted lock keys are used so two transactions on
 * the same files cannot deadlock by acquiring them in different orders.
 */
class WriteLockQueue {
  private tail: Promise<void> = Promise.resolve();
  private held = new Set<string>();

  static key(filePath: string): string {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
  }

  async run<T>(keys: readonly string[], timeoutMs: number, work: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const deadline = Date.now() + timeoutMs;
    while (ordered.some(key => this.held.has(key))) {
      if (Date.now() > deadline) throw new Error('Candidate commit timed out waiting for file locks.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    for (const key of ordered) this.held.add(key);
    try {
      return await work();
    } finally {
      for (const key of ordered) this.held.delete(key);
      release();
    }
  }
}

/** One queue and one live transaction per host, mirroring the single candidate overlay. */
const hostLockQueues = new WeakMap<HostServices, WriteLockQueue>();
const hostTransactions = new WeakMap<HostServices, CandidateTransaction>();

function lockQueueFor(host: HostServices): WriteLockQueue {
  let queue = hostLockQueues.get(host);
  if (!queue) { queue = new WriteLockQueue(); hostLockQueues.set(host, queue); }
  return queue;
}

class CandidateTransaction {
  private _state: TransactionState = 'discarded';
  private _id?: string;
  private readonly staged = new Map<string, StagedEntry>();
  private readonly original = new Map<string, { content: string; existed: boolean }>();
  private validatedOk = false;
  private stagedBytes = 0;

  get state(): TransactionState { return this._state; }
  get id(): string | undefined { return this._id; }
  get bytes(): number { return this.stagedBytes; }
  get canValidate(): boolean { return this._state === 'active'; }
  get files(): StagedEntry[] { return [...this.staged.values()].sort((a, b) => a.path.localeCompare(b.path)); }
  get paths(): string[] { return this.files.map(file => file.path); }

  begin(): string {
    if (this._state === 'active' || this._state === 'validated') throw new Error('A transaction is already active');
    this.staged.clear();
    this.original.clear();
    this.stagedBytes = 0;
    this.validatedOk = false;
    this._id = randomUUID();
    this._state = 'active';
    return this._id;
  }

  stage(filePath: string, content: string, baseHash?: string): StagedEntry {
    if (this._state !== 'active') throw new Error('Cannot stage a transaction in ' + this._state + ' state');
    const bytes = Buffer.byteLength(content, 'utf8');
    const previous = this.staged.get(filePath);
    const nextBytes = this.stagedBytes - (previous?.bytes ?? 0) + bytes;
    if (!previous && this.staged.size >= MAX_CANDIDATE_FILES) throw new Error('Transaction file limit exceeded');
    if (nextBytes > MAX_CANDIDATE_BYTES) throw new Error('Transaction byte limit exceeded');
    if (baseHash !== undefined && !/^[a-f0-9]{64}$/i.test(baseHash)) throw new Error('baseHash must be a SHA-256 hex digest');
    const entry: StagedEntry = { path: filePath, content, contentHash: sha256Text(content), bytes, baseHash: previous?.baseHash ?? baseHash };
    this.staged.set(filePath, entry);
    this.stagedBytes = nextBytes;
    return entry;
  }

  fingerprint(): string {
    return sha256Text(this.files.map(file => file.path + '|' + file.contentHash).join('|'));
  }

  validate(ok: boolean): void {
    if (this._state !== 'active') throw new Error('Cannot validate a transaction in ' + this._state + ' state');
    this.validatedOk = ok;
    this._state = 'validated';
  }

  discard(): void {
    if (this._state === 'committed' || this._state === 'discarded') return;
    this.staged.clear();
    this.original.clear();
    this.stagedBytes = 0;
    this.validatedOk = false;
    this._state = 'discarded';
  }

  settle(state: TransactionState): void {
    this._state = state;
  }

  async commit(
    host: HostServices,
    baselines: ReadonlyMap<string, { snapshot: DiagnosticSnapshotEntry[]; epoch: number }>,
    deltas: Record<string, DiagnosticDelta>,
    signal?: AbortSignal,
  ): Promise<{ committed: boolean; state: TransactionState; files: string[]; rollback: RollbackReport; error?: string }> {
    const files = this.files;
    const paths = files.map(file => file.path);
    const noRollback: RollbackReport = { attempted: false, succeeded: true, paths: [], errors: [] };
    if (this._state !== 'validated') throw new Error('Transaction must be validated before commit');
    // An empty transaction is a no-op, not a drift risk: post-commit freshness
    // would compare a file with its own baseline and could never succeed.
    if (files.length === 0) {
      this._state = 'committed';
      return { committed: true, state: this._state, files: paths, rollback: noRollback };
    }
    if (!this.validatedOk) {
      this._state = 'discarded';
      return { committed: false, state: this._state, files: paths, rollback: noRollback, error: 'Validation failed before commit' };
    }
    const written: StagedEntry[] = [];
    try {
      for (const file of files) {
        throwIfAborted(signal);
        const current = await readDiskText(host, file.path);
        if (file.baseHash !== undefined && sha256Text(current) !== file.baseHash) {
          const drift = 'External disk drift detected: ' + file.path;
          this._state = 'discarded';
          return { committed: false, state: this._state, files: paths, rollback: noRollback, error: drift };
        }
        this.original.set(file.path, { content: current, existed: current.length > 0 || file.baseHash !== undefined });
      }
      for (const file of files) {
        throwIfAborted(signal);
        // Record before writing: a partially written file must still roll back.
        written.push(file);
        await host.filesystem.writeTextFile(file.path, file.content);
      }
      const validation = await this.validateOnDisk(host, files, baselines, deltas, signal);
      if (!validation.ok) {
        const rollback = await this.rollback(host, written);
        this._state = rollback.succeeded ? 'discarded' : 'active';
        return { committed: false, state: this._state, files: paths, rollback, error: validation.error };
      }
      this._state = 'committed';
      return { committed: true, state: this._state, files: paths, rollback: noRollback };
    } catch (error) {
      const rollback = await this.rollback(host, written);
      this._state = rollback.succeeded ? 'discarded' : 'active';
      if (isAbortLike(error)) throw error;
      return { committed: false, state: this._state, files: paths, rollback, error: errorText(error) };
    }
  }

  private async rollback(host: HostServices, written: readonly StagedEntry[]): Promise<RollbackReport> {
    const errors: Array<{ path: string; error: string }> = [];
    for (const file of [...written].reverse()) {
      try {
        const original = this.original.get(file.path);
        if (original?.existed === false) {
          // Only the file this transaction created is removed, never a directory.
          const deletable = host.filesystem as FilesystemHost & { deleteFile?: (target: string) => Promise<void> };
          if (deletable.deleteFile) await deletable.deleteFile(file.path);
          else await host.filesystem.writeTextFile(file.path, '');
        } else {
          await host.filesystem.writeTextFile(file.path, original?.content ?? '');
        }
      } catch (error) {
        errors.push({ path: file.path, error: errorText(error) });
      }
    }
    return { attempted: written.length > 0, succeeded: errors.length === 0, paths: written.map(file => file.path), errors };
  }

  private async validateOnDisk(
    host: HostServices,
    files: readonly StagedEntry[],
    baselines: ReadonlyMap<string, { snapshot: DiagnosticSnapshotEntry[]; epoch: number }>,
    deltas: Record<string, DiagnosticDelta>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    await requestRevalidate(host, files.map(file => file.path), signal);
    let ok = true;
    let error: string | undefined;
    for (const file of files) {
      const baseline = baselines.get(file.path) ?? { snapshot: [], epoch: 0 };
      const current = await waitForFreshDiagnostics(host, file.path, baseline.epoch, signal);
      const delta = diffSnapshots(baseline.snapshot, current.snapshot, current.fresh);
      deltas[file.path] = delta;
      if (!delta.comparable || delta.added.some(entry => entry.severity === 'error')) {
        ok = false;
        error ??= 'Candidate commit introduced errors or diagnostics were not fresh.';
      }
    }
    return { ok, error };
  }
}

function activeTransaction(host: HostServices): CandidateTransaction | undefined {
  const transaction = hostTransactions.get(host);
  return transaction && (transaction.state === 'active' || transaction.state === 'validated') ? transaction : undefined;
}

function transactionFor(host: HostServices): CandidateTransaction {
  let transaction = hostTransactions.get(host);
  if (!transaction) { transaction = new CandidateTransaction(); hostTransactions.set(host, transaction); }
  return transaction;
}
// ─── diagnostics and overlay validation ────────────────────────────────────

function snapshotDiagnostics(entries: readonly DiagnosticRecord[]): DiagnosticSnapshotEntry[] {
  return entries.map(entry => ({
    code: entry.code ?? '',
    severity: entry.severity,
    message: entry.message,
    line: entry.line ?? 0,
    column: entry.column ?? 0,
  }));
}

function diagnosticKey(entry: DiagnosticSnapshotEntry): string {
  return [entry.code, entry.severity, entry.line, entry.column, entry.message].join('\u0000');
}

function diffSnapshots(
  baseline: readonly DiagnosticSnapshotEntry[],
  current: readonly DiagnosticSnapshotEntry[],
  comparable: boolean,
): DiagnosticDelta {
  const before = new Set(baseline.map(diagnosticKey));
  const after = new Set(current.map(diagnosticKey));
  return {
    comparable,
    added: current.filter(entry => !before.has(diagnosticKey(entry))),
    removed: baseline.filter(entry => !after.has(diagnosticKey(entry))),
  };
}

function epochOf(result: { freshness?: { epoch?: number } }): number {
  return result.freshness?.epoch ?? 0;
}

async function waitForFreshDiagnostics(
  host: HostServices,
  filePath: string,
  baselineEpoch: number,
  signal?: AbortSignal,
): Promise<{ snapshot: DiagnosticSnapshotEntry[]; fresh: boolean }> {
  const deadline = Date.now() + FRESHNESS_TIMEOUT_MS;
  let current = await host.diagnostics.getDiagnostics({ file: filePath, limit: DIAGNOSTIC_LIMIT }, signal ? { signal } : undefined);
  while ((current.status !== 'fresh' || epochOf(current) <= baselineEpoch) && Date.now() < deadline) {
    throwIfAborted(signal);
    await new Promise(resolve => setTimeout(resolve, FRESHNESS_POLL_MS));
    current = await host.diagnostics.getDiagnostics({ file: filePath, limit: DIAGNOSTIC_LIMIT }, signal ? { signal } : undefined);
  }
  return {
    snapshot: snapshotDiagnostics(current.diagnostics),
    fresh: current.status === 'fresh' && epochOf(current) > baselineEpoch,
  };
}

async function requestRevalidate(host: HostServices, files: readonly string[], signal?: AbortSignal): Promise<void> {
  if (files.length === 0) return;
  // Revalidation is best-effort: the freshness wait below decides the outcome.
  await host.lsp.executeCommand('cwtools.ai.revalidateFiles', [files.map(toFileUri)], signal ? { signal } : undefined)
    .catch(() => undefined);
}

async function validateOverlayOnHost(
  host: HostServices,
  files: readonly StagedEntry[],
  signal?: AbortSignal,
): Promise<OverlayValidation | { infrastructureError: string }> {
  if (files.length > MAX_CANDIDATE_FILES) return { infrastructureError: 'Overlay validation request exceeds the file limit.' };
  // A local controller carries both the caller's abort and the request timeout,
  // so a hung backend cannot strand the transaction.
  const controller = new AbortController();
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  let response: unknown;
  try {
    response = await host.lsp.executeCommand(
      'cwtools.ai.validateOverlay',
      [{ files: files.map(file => ({ uri: toFileUri(file.path), content: file.content, baseHash: file.baseHash })) }],
      { signal: controller.signal },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return { infrastructureError: isAbortLike(error) ? 'Overlay validation timed out after 15 seconds.' : errorText(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
  const record = asRecordValue(response);
  if (record.status === 'unavailable' || asRecordValue(record.error).code === 'lsp_unavailable') {
    return { infrastructureError: 'Overlay validation is not available in this host.' };
  }
  if (record.ok !== true || !Array.isArray(record.files)) {
    return { infrastructureError: typeof record.error === 'string' ? record.error : 'Overlay validation returned an invalid response.' };
  }
  if (record.files.length !== files.length) {
    return { infrastructureError: 'Overlay validation returned ' + record.files.length + ' file result(s) for ' + files.length + ' candidate(s).' };
  }
  const requestedByUri = new Map(files.map(file => [toFileUri(file.path), file]));
  const returned = new Set<string>();
  const normalized: OverlayValidationFile[] = [];
  for (const item of record.files as unknown[]) {
    const entry = asRecordValue(item);
    const uri = typeof entry.uri === 'string' ? entry.uri : undefined;
    if (!uri || !requestedByUri.has(uri) || returned.has(uri)) {
      return { infrastructureError: 'Overlay validation returned an unknown, missing, or duplicate URI: ' + (uri ?? '<missing>') + '.' };
    }
    returned.add(uri);
    if (!Array.isArray(entry.diagnostics)) return { infrastructureError: 'Overlay validation omitted diagnostics for ' + uri + '.' };
    const diagnostics: DiagnosticSnapshotEntry[] = [];
    for (const raw of entry.diagnostics as unknown[]) {
      const diagnostic = asRecordValue(raw);
      if (diagnostic.severity !== 'error' && diagnostic.severity !== 'warning' && diagnostic.severity !== 'info' && diagnostic.severity !== 'hint') {
        return { infrastructureError: 'Overlay validation returned an unknown diagnostic severity for ' + uri + '.' };
      }
      diagnostics.push({
        code: typeof diagnostic.code === 'string' ? diagnostic.code : '',
        severity: diagnostic.severity,
        message: typeof diagnostic.message === 'string' ? diagnostic.message : '',
        line: typeof diagnostic.line === 'number' ? diagnostic.line : 0,
        column: typeof diagnostic.column === 'number' ? diagnostic.column : 0,
      });
    }
    normalized.push({
      uri,
      ok: entry.ok === true,
      contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : undefined,
      diagnostics,
      error: typeof entry.error === 'string' ? entry.error : undefined,
    });
  }
  if (returned.size !== requestedByUri.size) return { infrastructureError: 'Overlay validation did not cover every candidate file.' };
  return {
    validationLevel: typeof record.validationLevel === 'string' ? record.validationLevel : undefined,
    limitations: Array.isArray(record.limitations)
      ? (record.limitations as unknown[]).filter((value): value is string => typeof value === 'string')
      : undefined,
    files: normalized,
  };
}

// ─── typed_pdx_write ───────────────────────────────────────────────────────

export const TYPED_PDX_WRITE_FIELDS = ['filePath', 'operation', 'expectedHash', 'mode', 'transactionId'] as const;

export async function typedPdxWriteWithHost(
  host: HostServices,
  args: Record<string, unknown>,
  context?: DomainWriteContext,
): Promise<SharedToolResult<TypedPdxWriteResult>> {
  const denied = ensureToolWriteAllowed(host, 'typed_pdx_write');
  if (denied) return denied as SharedToolResult<TypedPdxWriteResult>;
  throwIfAborted(context?.signal);
  const extra = Object.keys(args).filter(key => !(TYPED_PDX_WRITE_FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) return invalidArguments('typed_pdx_write contains unsupported field(s): ' + extra.join(', ')) as SharedToolResult<TypedPdxWriteResult>;
  const operation = asRecordValue(args.operation);
  if (Object.keys(operation).length === 0) return invalidArguments('typed_pdx_write requires an operation record.') as SharedToolResult<TypedPdxWriteResult>;
  const mode = args.mode === undefined ? 'preview' : args.mode;
  if (mode !== 'preview' && mode !== 'stage') return invalidArguments('mode must be "preview" or "stage".') as SharedToolResult<TypedPdxWriteResult>;
  if (args.expectedHash !== undefined && (typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(args.expectedHash))) {
    return invalidArguments('expectedHash must be a SHA-256 hex digest.') as SharedToolResult<TypedPdxWriteResult>;
  }
  const resolution = resolveInsideWorkspace(host, args.filePath);
  if (!resolution.ok) return failure('outside_workspace', resolution.message) as SharedToolResult<TypedPdxWriteResult>;
  if (!resolution.resolvedPath.toLowerCase().endsWith('.txt')) {
    return invalidArguments('typed_pdx_write only supports .txt files.') as SharedToolResult<TypedPdxWriteResult>;
  }

  let text: string;
  try {
    const read = await host.filesystem.readTextFile(resolution.resolvedPath);
    if (!read.exists) {
      // The operation vocabulary edits an existing document; it never invents one.
      return failure('file_not_found', 'typed_pdx_write edits an existing .txt file and never creates one: ' + resolution.relativePath) as SharedToolResult<TypedPdxWriteResult>;
    }
    if (read.content.length > MAX_FILE_CHARS) return failure('file_oversized', 'File exceeds the ' + MAX_FILE_CHARS + ' character bound.') as SharedToolResult<TypedPdxWriteResult>;
    text = read.content.charCodeAt(0) === 0xfeff ? read.content.slice(1) : read.content;
  } catch (error) {
    return failure('read_failed', errorText(error)) as SharedToolResult<TypedPdxWriteResult>;
  }

  let candidate: TypedPdxCandidate;
  try {
    candidate = buildTypedPdxCandidate(
      resolution.resolvedPath,
      text,
      operation,
      typeof args.expectedHash === 'string' ? args.expectedHash : undefined,
    );
  } catch (error) {
    return invalidArguments(errorText(error)) as SharedToolResult<TypedPdxWriteResult>;
  }

  if (mode === 'preview') {
    return success<TypedPdxWriteResult>({ success: true, mode: 'preview', candidate }) as SharedToolResult<TypedPdxWriteResult>;
  }

  const transaction = activeTransaction(host);
  if (!transaction) {
    return failure('transaction_inactive', 'Candidate transaction is not active; call candidate_transaction with action "begin" first.') as SharedToolResult<TypedPdxWriteResult>;
  }
  if (typeof args.transactionId !== 'string' || args.transactionId !== transaction.id) {
    return failure('transaction_mismatch', 'transactionId does not match the active candidate transaction (' + (transaction.id ?? 'none') + ').') as SharedToolResult<TypedPdxWriteResult>;
  }
  if (!transaction.canValidate) {
    return failure('transaction_inactive', 'Candidate transaction is not active.') as SharedToolResult<TypedPdxWriteResult>;
  }
  try {
    transaction.stage(resolution.resolvedPath, candidate.content, candidate.beforeHash);
  } catch (error) {
    return failure('stage_failed', errorText(error)) as SharedToolResult<TypedPdxWriteResult>;
  }
  return success<TypedPdxWriteResult>({
    success: true,
    mode: 'stage',
    transactionId: transaction.id,
    candidate,
    message: candidate.summary,
  }) as SharedToolResult<TypedPdxWriteResult>;
}
// ─── candidate_transaction ─────────────────────────────────────────────────

export const CANDIDATE_TRANSACTION_FIELDS = ['action', 'transactionId', 'validationPassed'] as const;

export async function candidateTransactionWithHost(
  host: HostServices,
  args: Record<string, unknown>,
  context?: DomainWriteContext,
): Promise<SharedToolResult<CandidateTransactionResult>> {
  const denied = ensureToolWriteAllowed(host, 'candidate_transaction');
  if (denied) return denied as SharedToolResult<CandidateTransactionResult>;
  throwIfAborted(context?.signal);
  const extra = Object.keys(args).filter(key => !(CANDIDATE_TRANSACTION_FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) return invalidArguments('candidate_transaction contains unsupported field(s): ' + extra.join(', ')) as SharedToolResult<CandidateTransactionResult>;
  const action = args.action;
  if (action !== 'begin' && action !== 'status' && action !== 'validate' && action !== 'commit' && action !== 'discard') {
    return invalidArguments('action must be one of begin, status, validate, commit, discard.') as SharedToolResult<CandidateTransactionResult>;
  }

  const transaction = transactionFor(host);
  const result = (data: CandidateTransactionResult, ok: boolean): SharedToolResult<CandidateTransactionResult> => ({
    ok,
    status: ok ? 'success' : 'error',
    source: SOURCE,
    data,
    error: ok ? undefined : { code: 'commit_failed', message: data.error ?? 'Candidate commit failed.' },
  });
  const stateShape = () => ({
    success: true,
    action,
    transactionId: transaction.id,
    state: transaction.state,
    files: transaction.paths,
    bytes: transaction.bytes,
  });

  if (action === 'begin') {
    if (transaction.state === 'active' || transaction.state === 'validated') {
      return failure('transaction_active', 'A candidate transaction is already active (' + (transaction.id ?? '<unknown>') + ').') as SharedToolResult<CandidateTransactionResult>;
    }
    const id = transaction.begin();
    return result({ success: true, action, transactionId: id, state: transaction.state, files: [], bytes: 0 }, true);
  }

  if (transaction.state === 'discarded' || transaction.state === 'committed') {
    // Status/discard stay answerable after the fact; mutating actions need a new begin.
    if (action === 'status' || action === 'discard') {
      return result({ ...stateShape(), success: action === 'status' }, action === 'status');
    }
    return failure('transaction_inactive', 'No active candidate transaction; call candidate_transaction with action "begin" first.') as SharedToolResult<CandidateTransactionResult>;
  }

  if (typeof args.transactionId === 'string' && args.transactionId !== transaction.id) {
    return failure('transaction_mismatch', 'transactionId does not match the active candidate transaction (' + (transaction.id ?? 'none') + ').') as SharedToolResult<CandidateTransactionResult>;
  }

  if (action === 'status') return result(stateShape(), true);

  if (action === 'discard') {
    transaction.discard();
    return result({ ...stateShape(), files: [], bytes: 0 }, true);
  }

  if (action === 'validate') {
    if (!transaction.canValidate) {
      return failure('transaction_inactive', 'Candidate transaction is not active.') as SharedToolResult<CandidateTransactionResult>;
    }
    if (transaction.files.length === 0) {
      // Nothing staged: validation is vacuously satisfied and the detached
      // validator would reject an empty batch, stranding the transaction.
      transaction.validate(true);
      return result({ ...stateShape(), files: [], bytes: 0 }, true);
    }
    if (args.validationPassed === false) {
      transaction.validate(false);
      return result({ ...stateShape(), success: false, error: 'Caller-reported semantic validation failure.' }, true);
    }
    const overlay = await validateOverlayOnHost(host, transaction.files, context?.signal);
    if ('infrastructureError' in overlay) {
      // The candidates were never judged: report the cause and keep the
      // transaction active so the caller can retry or discard it.
      return result({
        ...stateShape(),
        success: false,
        infrastructureError: overlay.infrastructureError,
        error: 'Candidate overlay validation could not run: ' + overlay.infrastructureError,
      }, false);
    }
    const invalid = overlay.files.find(file =>
      file.ok !== true
      || file.contentHash !== transaction.files.find(candidate => toFileUri(candidate.path) === file.uri)?.contentHash
      || (file.diagnostics ?? []).some(diagnostic => diagnostic.severity === 'error'));
    transaction.validate(!invalid);
    return result({
      ...stateShape(),
      success: !invalid,
      validationOk: !invalid,
      overlayValidation: overlay,
      error: invalid ? invalid.error ?? 'Overlay validation rejected ' + (invalid.uri ?? 'a candidate file') + '.' : undefined,
    } as CandidateTransactionResult, !invalid);
  }

  // action === 'commit'
  if (transaction.state !== 'validated') {
    return failure('transaction_not_validated', 'Candidate transaction must be validated before commit.') as SharedToolResult<CandidateTransactionResult>;
  }
  const files = transaction.files;
  const baselines = new Map<string, { snapshot: DiagnosticSnapshotEntry[]; epoch: number }>();
  for (const file of files) {
    const baseline = await host.diagnostics.getDiagnostics({ file: file.path, limit: DIAGNOSTIC_LIMIT }, context?.signal ? { signal: context.signal } : undefined);
    baselines.set(file.path, { snapshot: snapshotDiagnostics(baseline.diagnostics), epoch: epochOf(baseline) });
  }
  const diagnosticDeltas: Record<string, DiagnosticDelta> = {};
  let commit: Awaited<ReturnType<CandidateTransaction['commit']>>;
  try {
    commit = await lockQueueFor(host).run(
      files.map(file => WriteLockQueue.key(file.path)),
      LOCK_TIMEOUT_MS,
      () => transaction.commit(host, baselines, diagnosticDeltas, context?.signal),
    );
  } catch (error) {
    if (isAbortLike(error)) throw error;
    return failure('commit_failed', errorText(error)) as SharedToolResult<CandidateTransactionResult>;
  }
  if (commit.state === 'committed' || commit.state === 'discarded') transaction.settle(commit.state);
  return result({
    success: commit.committed,
    action,
    transactionId: transaction.id,
    state: transaction.state,
    files: commit.files,
    bytes: transaction.bytes,
    commit: { committed: commit.committed, state: commit.state, files: commit.files, rollback: commit.rollback },
    diagnosticDeltas,
    error: commit.error,
  }, commit.committed);
}