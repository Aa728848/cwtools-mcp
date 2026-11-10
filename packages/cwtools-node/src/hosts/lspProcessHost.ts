import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { watch, type FSWatcher } from 'chokidar';
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type CancellationToken,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import {
  BACKEND_INCOMPATIBLE_CODE,
  checkRequiredCommands,
  createAbortError,
  isAbortError,
  parseHostCapabilities,
  throwIfAborted,
  type HostCapabilities,
  type LspCommandOptions,
  type LspHost,
} from 'cwtools-shared';
import { detectExtensionServerPath, detectExtensionRulesDir } from './vscodeCache';
import { resolveLocalisationLanguages, resolveGeneratedStrings, resolveExperimental } from './projectSettings';

export interface LspProcessHostOptions {
  workspaceRoot: string;
  game?: string;
  serverPath?: string;
  // Arguments passed to the backend executable. Required when the backend is not a
  // native binary but a script run through a runtime (`node server.js`,
  // `dotnet CWTools.dll`); defaults to no arguments.
  serverArgs?: string[];
  rulesCache?: string;
  // Deadline for spawning the child and completing initialize + the capability
  // handshake. Kept separate from a request timeout: startup pays process launch
  // and protocol negotiation, a request only pays its own round trip.
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  // Verbose backend logging. Defaults to CWTOOLS_MCP_DEBUG so existing setups
  // keep working; hosts that configure logging can set it explicitly.
  debug?: boolean;
  // Pre-built cache dir holding <game>.cwb; overrides the default rules-cache
  // root so the server loads it instead of rebuilding.
  cachePath?: string;
  // Vanilla install/data dir, forwarded to `cache.<game>` so the server can
  // build/locate the vanilla cache (otherwise vanilla data is absent).
  gamePath?: string;
  bundledRulesPath?: string;
}

// The rules-cache root (also where the server reads/writes <game>.cwb). Kept as a
// shared helper so the vanilla-cache probe resolves the exact same location.
export function resolveRulesCacheRoot(options: { rulesCache?: string; cachePath?: string; workspaceRoot: string }): string {
  return options.rulesCache ?? options.cachePath ?? path.join(options.workspaceRoot, '.cwtools', 'rules-cache');
}

// Default budget for spawn + initialize + capability handshake. Kept generous: a
// cold start pays process launch, and a slow disk can dominate.
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

interface LspErrorResult {
  ok: false;
  status: 'unavailable';
  error: {
    code: 'lsp_unavailable';
    message: string;
  };
}

/**
 * Raised when the backend answered the capability handshake but is not a build
 * this client can drive. The LSP child has already been released when this is
 * thrown, so callers only need to surface the reason.
 */
export class BackendIncompatibleError extends Error {
  readonly code = BACKEND_INCOMPATIBLE_CODE;
  constructor(
    readonly reason: 'legacy' | 'malformed' | 'incomplete' | 'protocol',
    message: string,
  ) {
    super(`CWTools backend is incompatible (${reason}): ${message}`);
    this.name = 'BackendIncompatibleError';
  }
}

export class LspProcessHost implements LspHost {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private startPromise?: Promise<void>;
  private startError?: string;
  // Epoch (ms) when the server finished loading/initial validation. Files modified
  // after this are candidates for on-demand revalidation.
  private startedAtMs?: number;
  // Capabilities proven by the startup handshake; undefined until it succeeds.
  private capabilities?: HostCapabilities;
  // Set once the handshake rejected the backend. The child was already released,
  // so no later call may spawn a replacement: every attempt reports this reason.
  private incompatible?: BackendIncompatibleError;
  private fileWatcher?: FSWatcher;
  private watcherFlushTimer?: NodeJS.Timeout;
  private readonly pendingWatchedChanges = new Map<string, 1 | 2 | 3>();
  // Bumped on every dispose(). Asynchronous work captures the generation it began
  // under and refuses to install a watcher, record an exit, or overwrite state once
  // it no longer matches: a disposed host can never be resurrected by a late start.
  private generation = 0;
  private get debugEnabled(): boolean {
    return this.options.debug === true || !!process.env.CWTOOLS_MCP_DEBUG;
  }

  constructor(private readonly options: LspProcessHostOptions) {}

  get readyAtMs(): number | undefined {
    return this.startedAtMs;
  }

  /** Capability record answered by the backend, once the handshake succeeded. */
  get backendCapabilities(): HostCapabilities | undefined {
    return this.capabilities;
  }

  async executeCommand<T = unknown>(command: string, args: unknown[] = [], options?: LspCommandOptions): Promise<T> {
    try {
      await this.ensureStarted(options?.signal);
      const result = await this.raceRequest(
        'workspace/executeCommand',
        { command, arguments: args },
        options?.timeoutMs ?? this.options.requestTimeoutMs ?? 20_000,
        `LSP command ${command} timed out`,
        options?.signal,
      );
      return result as T;
    } catch (error) {
      // A cancelled call is not a missing backend. Rethrow so callers see the
      // abort instead of an `unavailable` result they might retry forever.
      if (isAbortError(error)) throw error;
      if (error instanceof BackendIncompatibleError) return this.incompatibleResult(error) as T;
      return this.unavailable(error instanceof Error ? error.message : String(error)) as T;
    }
  }

  async sendRequest<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 20_000,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      await this.ensureStarted(signal);
      return await this.raceRequest(method, params, timeoutMs, `LSP request ${method} timed out`, signal) as T;
    } catch (error) {
      if (isAbortError(error)) throw error;
      // Generic requests report incompatibility exactly like executeCommand, so a
      // caller cannot get a different failure shape from the navigation tools.
      if (error instanceof BackendIncompatibleError) return this.incompatibleResult(error) as T;
      return this.unavailable(error instanceof Error ? error.message : String(error)) as T;
    }
  }

  async request<T = unknown>(method: string, params?: unknown, options?: LspCommandOptions): Promise<T> {
    return this.sendRequest(method, params, options?.timeoutMs, options?.signal);
  }

  dispose(): void {
    const proc = this.process;
    const connection = this.connection;
    // Null fields first so a second dispose() (e.g. from the process 'exit'
    // safety net) is a no-op and never double-kills.
    this.connection = undefined;
    this.process = undefined;
    this.startPromise = undefined;
    this.generation += 1;
    this.stopFileWatcher();
    try {
      connection?.dispose();
    } catch {
      // ignore disposal failures
    }
    // Kill only the child WE spawned. On its stdin closing the F# server also
    // self-exits on EOF, but an explicit kill is the hard guarantee.
    try {
      proc?.kill();
    } catch {
      // process may already be gone
    }
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.incompatible) throw this.incompatible;
    if (this.connection && !this.startError) return;
    if (!this.startPromise) {
      // The startup budget belongs to the host options, not to whichever request
      // happened to trigger startup first.
      const generation = this.generation;
      this.startPromise = this.start(generation, signal).catch(error => {
        // A failed or cancelled start must not be cached as a permanently settled
        // promise: a later call may legitimately try again.
        if (this.generation === generation) this.startPromise = undefined;
        throw error;
      });
    }
    await this.startPromise;
    if (this.startError) throw new Error(this.startError);
  }

  private async start(generation: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.startInternal(generation, signal);
    } catch (error) {
      // Startup owns its partial process even when the caller never disposes explicitly.
      if (this.generation === generation) this.dispose();
      throw error;
    }
  }

  private async startInternal(generation: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const startupTimeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const stale = (): boolean => this.generation !== generation;
    const serverPath = this.options.serverPath ?? resolveDefaultServerPath();
    if (!serverPath || !fs.existsSync(serverPath)) {
      this.startError = `CWTools server binary was not found. Checked: ${serverPath ?? '(none)'}`;
      throw new Error(this.startError);
    }

    this.process = spawn(serverPath, this.options.serverArgs ?? [], {
      cwd: this.options.workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process.stderr.on('data', chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (text.trim()) {
        process.stderr.write(`[cwtools-lsp] ${text}`);
      }
    });
    this.process.on('exit', (code, exitSignal) => {
      // A child we deliberately released (dispose/abort) must not be recorded as a
      // startup failure of a newer generation.
      if (stale()) return;
      this.startError = `CWTools LSP exited with code ${code ?? 'null'} signal ${exitSignal ?? 'null'}`;
      this.connection = undefined;
      this.stopFileWatcher();
    });

    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin),
    );
    this.connection.listen();

    // Forward server log/diagnostics to stderr when debug logging is on, so
    // load/cache problems are visible (the server logs via window/logMessage).
    if (this.debugEnabled) {
      this.connection.onNotification('window/logMessage', (p: { message?: string } = {}) => {
        if (p.message) process.stderr.write(`[cwtools-lsp] ${String(p.message).slice(0, 240)}\n`);
      });
    }

    const rootUri = pathToFileUri(this.options.workspaceRoot);
    const game = this.options.game ?? 'paradox';
    const rulesCacheRoot = resolveRulesCacheRoot(this.options);
    const rulesFolder = game === 'paradox' || game === 'cwt'
      ? ''
      : this.options.bundledRulesPath ?? resolveBundledRulesPath(game, rulesCacheRoot);
    if (!rulesFolder) {
      process.stderr.write('[cwtools-node] warning: no CWT rules found — install the VS Code extension or pass --rules <dir>; validation will be limited\n');
    }
    await this.raceRequest('initialize', {
      processId: process.pid,
      rootPath: this.options.workspaceRoot,
      rootUri,
      workspaceFolders: [
        {
          uri: rootUri,
          name: path.basename(this.options.workspaceRoot),
        },
      ],
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
        },
        textDocument: {
          synchronization: {
            didSave: true,
          },
        },
      },
      initializationOptions: {
        language: game,
        uiLanguage: 'en',
        isVanillaFolder: false,
        rulesCache: rulesCacheRoot,
        bundledRulesPath: rulesFolder ?? '',
        rules_version: 'manual',
        defaultRepoPath: '',
        repoPath: '',
        diagnosticLogging: false,
      },
      trace: 'off',
    }, startupTimeoutMs, 'CWTools LSP initialize timed out', signal);

    // Handshake immediately after the initialize response and BEFORE
    // `initialized` / `workspace/didChangeConfiguration`: the configuration
    // notification is what makes the server start loading the game model, so
    // rejecting an incompatible backend here means the load never begins.
    await this.handshake(startupTimeoutMs, signal, stale);

    throwIfAborted(signal);
    if (stale()) throw createAbortError('Operation was aborted.');

    void this.connection.sendNotification('initialized', {});
    const loc = resolveLocalisationLanguages(this.options.workspaceRoot);
    process.stderr.write(`[cwtools-node] info: localisation languages = [${loc.languages.join(', ')}] (${loc.source})\n`);
    void this.connection.sendNotification('workspace/didChangeConfiguration', {
      settings: {
        cwtools: buildCwtoolsConfiguration(game, this.options.gamePath, rulesFolder ?? '', {
          languages: loc.languages,
          generatedStrings: resolveGeneratedStrings(this.options.workspaceRoot),
        }, resolveExperimental(this.options.workspaceRoot)),
      },
    });
    await this.waitForExecuteCommandsReady(Math.min(startupTimeoutMs, 20_000), signal, stale);
    // Aborting during startup must not leave anything alive behind, and a call
    // that finished after dispose() must not resurrect a watcher.
    throwIfAborted(signal);
    if (stale()) throw createAbortError('Operation was aborted.');
    this.startFileWatcher();
    this.startedAtMs = Date.now();
  }

  private async handshake(
    timeoutMs: number,
    signal?: AbortSignal,
    stale: () => boolean = () => false,
  ): Promise<void> {
    const raw = await this.raceRequest(
      'workspace/executeCommand',
      { command: 'cwtools.ai.getHostCapabilities', arguments: [] },
      timeoutMs,
      'CWTools capability handshake timed out',
      signal,
    ).catch(error => {
      // A cancelled handshake propagates; only a backend that answers badly is
      // turned into a legacy verdict.
      if (isAbortError(error)) throw error;
      return { status: 'unavailable', error: { message: String(error) } };
    });
    const verdict = parseHostCapabilities(raw);
    const checked = verdict.ok ? checkRequiredCommands(verdict.capabilities) : verdict;
    if (checked.ok) {
      this.capabilities = checked.capabilities;
      return;
    }
    // Release the incompatible backend before reporting: no half-working server,
    // and no respawn on the next call. When a newer generation owns the host this
    // start is already obsolete and must not clobber it.
    const incompatibility = new BackendIncompatibleError(checked.reason, checked.message);
    if (!stale()) {
      this.dispose();
      this.incompatible = incompatibility;
      this.startError = incompatibility.message;
    }
    throw incompatibility;
  }

  private startFileWatcher(): void {
    if (this.fileWatcher) return;
    const watcher = watch(this.options.workspaceRoot, {
      ignoreInitial: true,
      ignored: [/(^|[\\/])(?:node_modules|\.(?!\.)[^\\/]+)(?:[\\/]|$)/],
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    watcher.on('add', filePath => this.queueWatchedFileChange(filePath, 1));
    watcher.on('change', filePath => this.queueWatchedFileChange(filePath, 2));
    watcher.on('unlink', filePath => this.queueWatchedFileChange(filePath, 3));
    watcher.on('error', error => {
      if (this.debugEnabled) {
        process.stderr.write(`[cwtools-node] file watcher error: ${String(error)}\n`);
      }
    });
    this.fileWatcher = watcher;
  }

  private stopFileWatcher(): void {
    if (this.watcherFlushTimer) clearTimeout(this.watcherFlushTimer);
    this.watcherFlushTimer = undefined;
    this.pendingWatchedChanges.clear();
    const watcher = this.fileWatcher;
    this.fileWatcher = undefined;
    void watcher?.close();
  }

  private queueWatchedFileChange(filePath: string, type: 1 | 2 | 3): void {
    if (!isLspWatchedFile(this.options.workspaceRoot, filePath, this.options.game)) return;
    const resolved = path.resolve(filePath);
    const previous = this.pendingWatchedChanges.get(resolved);
    // Preserve a create over its following content-change event; deletion always wins.
    const nextType = type === 3 ? 3 : previous === 1 ? 1 : type;
    this.pendingWatchedChanges.set(resolved, nextType);
    if (this.watcherFlushTimer) clearTimeout(this.watcherFlushTimer);
    this.watcherFlushTimer = setTimeout(() => this.flushWatchedFileChanges(), 100);
  }

  private flushWatchedFileChanges(): void {
    this.watcherFlushTimer = undefined;
    const connection = this.connection;
    if (!connection || this.pendingWatchedChanges.size === 0) return;
    const changes = Array.from(this.pendingWatchedChanges, ([filePath, type]) => ({ filePath, type }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath))
      .map(({ filePath, type }) => ({
        uri: pathToFileUri(filePath),
        type,
      }));
    this.pendingWatchedChanges.clear();
    void connection.sendNotification('workspace/didChangeWatchedFiles', { changes });
  }

  // A rejected handshake is a distinct failure: the caller must not treat it as a
  // transient "start the server" condition and retry.
  private incompatibleResult(error: BackendIncompatibleError): unknown {
    return {
      ok: false,
      status: 'unavailable',
      error: {
        code: BACKEND_INCOMPATIBLE_CODE,
        reason: error.reason,
        message: error.message,
      },
    };
  }

  private unavailable(message: string): LspErrorResult {
    return {
      ok: false,
      status: 'unavailable',
      error: {
        code: 'lsp_unavailable',
        message,
      },
    };
  }

  // Issue a JSON-RPC request that is actually cancellable: the AbortSignal is
  // linked to a vscode-jsonrpc CancellationTokenSource, so aborting sends a
  // `$/cancelRequest` to the backend and releases its work — racing the promise
  // alone would leave the server computing a result nobody reads. The deadline and
  // the abort listener are both released in the finally block.
  private async raceRequest(
    method: string,
    params: unknown,
    timeoutMs: number,
    timeoutMessage: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const connection = this.connection;
    if (!connection) throw new Error('CWTools LSP connection is not established.');

    const cancellation = new CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let settled = false;
    const request = connection.sendRequest(method, params, cancellation.token as CancellationToken);
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          settled = true;
          // Same reasoning as abort: stop the backend work we gave up waiting for.
          cancellation.cancel();
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      });
      const aborted = new Promise<never>((_, reject) => {
        if (!signal) return;
        onAbort = () => {
          settled = true;
          cancellation.cancel();
          reject(createAbortError(
            signal.reason instanceof Error ? signal.reason.message : 'Operation was aborted.',
          ));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([request, timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      if (settled) {
        // Cancelled or timed out: stop the backend and swallow the late response.
        cancellation.cancel();
        void request.catch(() => undefined);
      }
      cancellation.dispose();
    }
  }

  // Poll until the command surface answers. Abort- and generation-aware: a host
  // disposed (or an AbortSignal fired) mid-poll stops here instead of continuing
  // to touch a connection that may already be gone.
  private async waitForExecuteCommandsReady(
    timeoutMs: number,
    signal?: AbortSignal,
    stale: () => boolean = () => false,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      throwIfAborted(signal);
      if (stale()) throw createAbortError('Operation was aborted.');
      const result = await this.raceRequest(
        'workspace/executeCommand',
        { command: 'cwtools.ai.getValidationStatus', arguments: [] },
        Math.max(1, Math.min(5_000, timeoutMs)),
        'CWTools readiness probe timed out',
        signal,
      ).catch(error => {
        if (isAbortError(error) || error instanceof BackendIncompatibleError) throw error;
        return null;
      });
      if (result && typeof result === 'object') return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

function buildCwtoolsConfiguration(
  game: string,
  gamePath: string | undefined,
  rulesFolder: string,
  localisation: { languages: string[]; generatedStrings: string },
  experimental: boolean,
): Record<string, unknown> {
  // `cache.<game>` is the vanilla install/data dir (the server reads vanilla data
  // from here and serializes the .cwb cache). Empty string => no vanilla data.
  const vanillaDir = gamePath ?? '';
  return {
    localisation: {
      languages: localisation.languages,
      generated_strings: localisation.generatedStrings,
    },
    errors: {
      vanilla: false,
      ignore: [],
      ignorefiles: [],
    },
    // On by default: enables incremental scripted-type refresh so revalidating a
    // scripted_trigger/effect/value patches the type index fast instead of a full reload.
    experimental,
    debug_mode: false,
    ignore_patterns: [],
    trace: {
      server: 'off',
    },
    cache: {
      stellaris: '',
      hoi4: '',
      eu4: '',
      ck2: '',
      imperator: '',
      vic2: '',
      ck3: '',
      vic3: '',
      eu5: '',
      [game]: vanillaDir,
    },
    rules_folder: rulesFolder,
    showInlineText: false,
    maxFileSize: 2,
    diagnostics: {
      deferDynamicParameterDiagnostics: true,
      dynamicPreflightTimeoutMs: 250,
      dynamicPreflightMaxEntities: 300,
      dynamicDeferDelayMs: 800,
    },
  };
}

export function createLspProcessHost(options: LspProcessHostOptions): LspProcessHost {
  return new LspProcessHost(options);
}

export function resolveDefaultServerPath(): string | undefined {
  const platform = os.platform();
  const executable = platform === 'win32'
    ? path.join('win-x64', 'CWTools Server.exe')
    : platform === 'darwin'
      ? path.join('osx-x64', 'CWTools Server')
      : path.join('linux-x64', 'CWTools Server');

  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  // Prefer the server inside the installed VS Code extension so a user with no dev
  // checkout still gets a working server; fall back to dev-build locations.
  const installed = detectExtensionServerPath();
  const candidates = [
    ...(installed ? [installed] : []),
    path.join(process.cwd(), 'release', 'bin', 'server', executable),
    path.join(process.cwd(), 'bin', 'server', executable),
    path.join(repoRoot, 'release', 'bin', 'server', executable),
    path.join(repoRoot, 'bin', 'server', executable),
    path.join(repoRoot, 'src', 'Main', 'output', platform === 'win32' ? 'CWTools Server.exe' : 'CWTools Server'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

// Resolve a rules *directory* the server can load. Priority: the rules the
// installed extension pulled into globalStorage, then a dev checkout. No bundled
// .zip and no extraction — the only zip-free sources. Returns undefined when none
// is found (the caller warns; --rules is the explicit override).
function resolveBundledRulesPath(game: string, cacheDir?: string): string | undefined {
  const extracted = detectExtensionRulesDir(cacheDir, game);
  if (extracted) return extracted;
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const candidates = [
    path.join(process.cwd(), 'release', 'rules', game, 'config'),
    path.join(process.cwd(), 'submodules', `cwtools-${game}-config`, 'config'),
    game === 'stellaris' ? path.join(process.cwd(), 'submodules', 'cwtools-stellaris-config', 'config') : '',
    path.join(repoRoot, 'release', 'rules', game, 'config'),
    path.join(repoRoot, 'submodules', `cwtools-${game}-config`, 'config'),
    game === 'stellaris' ? path.join(repoRoot, 'submodules', 'cwtools-stellaris-config', 'config') : '',
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

export function pathToFileUri(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  const withLeadingSlash = resolved.startsWith('/') ? resolved : `/${resolved}`;
  return `file://${encodeURI(withLeadingSlash).replace(/#/g, '%23')}`;
}

const LSP_WATCHED_EXTENSIONS = new Set([
  '.txt', '.gui', '.yml', '.csv', '.gfx', '.asset', '.cwt', '.entity', '.shader', '.fxh',
]);

export function isLspWatchedFile(workspaceRoot: string, filePath: string, game?: string): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(filePath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const segments = relative.split(/[\\/]+/).map(segment => segment.toLowerCase());
  if (segments.some(segment => segment === 'node_modules'
    || (segment.startsWith('.') && !segment.startsWith('..')))) return false;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.csv' && game && game.toLowerCase() !== 'ck2') return false;
  return LSP_WATCHED_EXTENSIONS.has(extension);
}