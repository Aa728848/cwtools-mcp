import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import {
  type DirectoryEntry,
  type DiagnosticRecord,
  type DiagnosticsHost,
  type DiagnosticsQueryResult,
  type FilesystemHost,
  type HostServices,
  type IndexHost,
  type IndexQueryResult,
  type LocalisationIndexEntry,
  type LocalisationIndexQuery,
  createUnavailableLspHost,
  throwIfAborted,
  type LspHost,
  MCP_WRITE_TOOL_NAMES,
  resolveWorkspacePath,
  type VanillaCacheStatus,
  vanillaCacheFileName,
  type WorkspaceIndexEntry,
  type WorkspaceIndexQuery,
} from 'cwtools-shared';
import { createLspProcessHost, pathToFileUri, resolveRulesCacheRoot, type LspProcessHost } from './lspProcessHost';
import type { LspHost as InjectedLspHost } from 'cwtools-shared';
import { detectGameInstall } from './gameInstall';
import { detectProjectSupport } from './projectDetect';
import { applyDiagnosticIgnoreList, honouredIgnoredDiagnostics } from './projectSettings';
import { RevalidationCoordinator } from './revalidation';
import { detectExtensionCacheDir, detectExtensionRulesDir } from './vscodeCache';

// Transport-agnostic host configuration. Deliberately excludes stdio/http/MCP
// transport fields: any consumer (the MCP server, an editor integration, a CLI)
// supplies its own transport and only describes the workspace and backend here.
export interface CwtoolsNodeHostOptions {
  workspaceRoot: string;
  game?: string;
  serverPath?: string;
  serverArgs?: string[];
  // Vanilla install/data dir, forwarded to `cache.<game>` so the server can
  // build (or locate) the vanilla cache. Without it, results are mod-only.
  gamePath?: string;
  // Pre-built cache dir (overrides the default rules-cache root), so the server
  // loads an existing `.cwb` instead of rebuilding — e.g. globalStorage.
  cachePath?: string;
  // Explicit CWT rules *directory* overriding auto-detection (a .zip is rejected).
  rulesPath?: string;
  // Diagnostic noise controls: error codes and file names to suppress, plus how
  // localisation diagnostics are filtered. Vanilla errors are always off.
  errorIgnoreCodes?: readonly string[];
  errorIgnoreFiles?: readonly string[];
  localisationDiagnosticFilter?: 'off' | 'problems' | 'all';
  enableWrites: boolean;
  allowedTools: string[];
  forceStart: boolean;
  // Budget for spawning the backend and completing its capability handshake.
  // Separate from any per-request timeout; omit to use the host default.
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /**
   * Apply the workspace's own diagnostic ignore list (`.vscode/settings.json`
   * `stellarisLanguageServices.ai.ignoredDiagnostics`). Defaults to true for backwards
   * compatibility; an agent-facing host should pass false, because a workspace can
   * otherwise hide errors from the model by committing that file.
   */
  honorWorkspaceIgnoreList?: boolean;
  /** Reuse an already-running native host instead of spawning another process. */
  lspHost?: InjectedLspHost;
  readyAtMs?: number;
  debug?: boolean;
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export function createNodeHostServices(config: CwtoolsNodeHostOptions): HostServices {
  const requestedWorkspaceRoot = path.resolve(config.workspaceRoot);
  const support = detectProjectSupport(requestedWorkspaceRoot, { game: config.game, gamePath: config.gamePath });
  const workspaceRoot = path.resolve(support.supported ? support.matchedAt ?? requestedWorkspaceRoot : requestedWorkspaceRoot);
  const enabled = support.supported || config.forceStart;
  const projectKind = support.supported ? support.kind : config.forceStart ? 'mod' : support.kind;
  const game = support.kind === 'cwt-only'
    ? 'cwt'
    : config.game ?? support.gameId ?? 'paradox';
  // A caller that leaves the game path empty gets the vanilla data the same way the
  // VS Code extension does: from the Steam libraries on this machine.
  const gamePath = config.gamePath
    ?? (game === 'paradox' || game === 'cwt' ? undefined : detectGameInstall(game));
  const allowlist = config.allowedTools.length > 0
    ? new Set(config.allowedTools)
    : new Set<string>(MCP_WRITE_TOOL_NAMES);
  const filesystem = new NodeFilesystemHost(workspaceRoot, config.enableWrites);
  // Generic and CWT-only hosts never borrow Stellaris rules/cache implicitly.
  const autoCache = config.cachePath ?? detectExtensionCacheDir(game);
  const detectedRulesPath = detectExtensionRulesDir(autoCache, game);
  const rulesConfigDirs = uniqueStrings([config.rulesPath, detectedRulesPath].filter((item): item is string => !!item));
  const lspProcess: LspProcessHost | undefined = enabled && !config.lspHost
    ? createLspProcessHost({
        workspaceRoot,
        game,
        serverPath: config.serverPath,
        ...(config.serverArgs === undefined ? {} : { serverArgs: config.serverArgs }),
        cachePath: autoCache,
        gamePath: game === 'paradox' || game === 'cwt' ? undefined : gamePath,
        bundledRulesPath: config.rulesPath,
        ...(config.errorIgnoreCodes === undefined ? {} : { errorIgnoreCodes: config.errorIgnoreCodes }),
        ...(config.errorIgnoreFiles === undefined ? {} : { errorIgnoreFiles: config.errorIgnoreFiles }),
        ...(config.localisationDiagnosticFilter === undefined ? {} : { localisationDiagnosticFilter: config.localisationDiagnosticFilter }),
        ...(config.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: config.startupTimeoutMs }),
        ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
        ...(config.debug === undefined ? {} : { debug: config.debug }),
      })
    : undefined;
  const lsp: LspHost = enabled
    ? config.lspHost ?? lspProcess ?? createUnavailableLspHost('Workspace is not a recognised Paradox mod; CWTools is disabled here.')
    : createUnavailableLspHost('Workspace is not a recognised Paradox mod; CWTools is disabled here.');
  const report = (message: string): void => {
    if (config.logger) config.logger('info', message);
    else console.error(`[cwtools-node] info: ${message}`);
  };
  if (!enabled) {
    report(`tool calls will be rejected (no language server) — ${support.reason} (pass --force-start to override)`);
  } else if (!support.supported) {
    report(`--force-start set; starting despite: ${support.reason}`);
  } else if (support.matchedAt && support.matchedAt !== requestedWorkspaceRoot) {
    report(`mod detected at ${support.matchedAt} (workspace = ${workspaceRoot})`);
  }
  if (enabled && !config.cachePath && autoCache) {
    report(`auto-detected VS Code extension cache at ${autoCache}`);
  }
  if (enabled && !config.gamePath && gamePath) {
    report(`auto-detected ${game} install at ${gamePath}`);
  }
  // Surface the resolved workspace so it's clear which mod is analysed.
  report(`workspace = ${workspaceRoot}${config.workspaceRoot === process.cwd() ? ' (inherited cwd)' : ''}`);
  return {
    workspaceRoot,
    readonlyMode: !config.enableWrites,
    writesEnabled: config.enableWrites,
    allowedWriteTools: allowlist,
    projectSupported: enabled,
    projectSupportReason: support.reason,
    projectKind,
    projectGameId: game,
    projectEvidence: [...support.markers],
    projectCandidates: support.candidates ? [...support.candidates] : undefined,
    lsp,
    diagnostics: new LspDiagnosticsHost(
      lsp,
      workspaceRoot,
      config.honorWorkspaceIgnoreList !== false,
      enabled ? new RevalidationCoordinator(lsp, workspaceRoot, () => config.readyAtMs ?? lspProcess?.readyAtMs) : undefined,
    ),
    filesystem,
    indexing: new ThinNodeIndexHost(workspaceRoot),
    rules: {
      gameId: game,
      configDirs: rulesConfigDirs,
      async readTextFile(filePath) {
        if (!fssync.existsSync(filePath)) return { content: '', hasBom: false, exists: false };
        const content = await fs.readFile(filePath, 'utf8');
        return { content, hasBom: content.charCodeAt(0) === 0xfeff, exists: true };
      },
      async listCwtFiles(root, options) {
        const limit = Math.max(1, Math.min(options?.limit ?? 1000, 5000));
        const results: string[] = [];
        await walk(root, async filePath => {
          if (results.length >= limit) return;
          if (filePath.toLowerCase().endsWith('.cwt')) results.push(filePath);
        });
        return results;
      },
    },
    vanillaCache: game === 'cwt'
      ? undefined
      : probeVanillaCache(workspaceRoot, { game, gamePath, cachePath: autoCache, workspaceRoot }),
    now: () => Date.now(),
    log: (level, message, data) => {
      if (level === 'debug' && !config.debug) return;
      if (config.logger) {
        config.logger(level, message, data);
        return;
      }
      const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
      console.error(`[cwtools-node] ${level}: ${message}${suffix}`);
    },
    dispose: () => {
      if (config.lspHost && 'dispose' in config.lspHost && typeof config.lspHost.dispose === 'function') {
        config.lspHost.dispose();
      } else {
        lspProcess?.dispose();
      }
    },
  };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(value);
  }
  return results;
}

// Resolve vanilla-cache availability up front: a pre-built <game>.cwb under the
// rules-cache root means vanilla data loads; a valid --game-path means the server
// can build it; otherwise results are mod-only. Mirrors GameLoader.getCachedFiles
// (cache file lives at the rules-cache root) and Program.fs cache.<game> handling.
function probeVanillaCache(
  workspaceRoot: string,
  config: Pick<CwtoolsNodeHostOptions, 'game' | 'gamePath' | 'cachePath' | 'workspaceRoot'>,
): VanillaCacheStatus {
  const cacheFileName = vanillaCacheFileName(config.game);
  const rulesCacheRoot = resolveRulesCacheRoot({ cachePath: config.cachePath, workspaceRoot });
  const cacheFile = cacheFileName ? path.join(rulesCacheRoot, cacheFileName) : undefined;
  const cacheExists = !!cacheFile && fssync.existsSync(cacheFile);
  const gamePathValid = !!cacheFileName && !!config.gamePath && fssync.existsSync(config.gamePath);
  if (cacheExists) {
    return { available: true, source: 'mod_plus_vanilla', cacheFile, reason: 'Loaded a pre-built vanilla cache.' };
  }
  if (gamePathValid) {
    return {
      available: true,
      source: 'mod_plus_vanilla',
      cacheFile,
      gamePath: config.gamePath,
      reason: 'No pre-built cache; the server will build one from --game-path on first load (slow).',
    };
  }
  return {
    available: false,
    source: 'mod_only',
    cacheFile,
    reason: 'No vanilla cache and no --game-path/--cache; results reflect mod files only.',
  };
}

class LspDiagnosticsHost implements DiagnosticsHost {
  constructor(
    private readonly lsp: LspHost,
    private readonly workspaceRoot: string,
    private readonly honorWorkspaceIgnoreList: boolean,
    private readonly revalidation?: RevalidationCoordinator,
  ) {}

  async getDiagnostics(
    filter: { file?: string; severity?: string; limit?: number } = {},
    context?: { signal?: AbortSignal },
  ): Promise<DiagnosticsQueryResult> {
    throwIfAborted(context?.signal);
    if (this.revalidation) {
      const absFile = filter.file
        ? resolveWorkspacePath(this.workspaceRoot, filter.file).resolvedPath ?? undefined
        : undefined;
      await this.revalidation.ensureFresh(absFile, context?.signal);
    }
    return this.applyIgnoreList(await this.queryDiagnostics(filter, context?.signal));
  }

  private applyIgnoreList(result: DiagnosticsQueryResult): DiagnosticsQueryResult {
    if (!result.ok || result.diagnostics.length === 0) return result;
    return applyDiagnosticIgnoreList(result, honouredIgnoredDiagnostics(this.workspaceRoot, this.honorWorkspaceIgnoreList));
  }

  private async queryDiagnostics(
    filter: { file?: string; severity?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<DiagnosticsQueryResult> {
    const file = filter.file;
    if (file) {
      const resolution = resolveWorkspacePath(this.workspaceRoot, file);
      const filePath = resolution.resolvedPath ?? file;
      // A symbol name or a path fragment is not a file: report that instead of
      // answering "stale, no diagnostics", which reads as "nothing found".
      if (!resolution.ok || !resolution.resolvedPath || !fssync.existsSync(filePath)) {
        return {
          ok: false,
          status: 'unavailable',
          diagnostics: [],
          error: {
            code: 'file_not_found',
            message: `No file at '${filePath}'. Pass an absolute path or a workspace-relative path; omit 'file' for whole-workspace diagnostics.`,
          },
        };
      }
      const value = await this.lsp.executeCommand<unknown>(
        'cwtools.ai.getDiagnosticsFresh',
        [pathToFileUri(filePath)],
        { timeoutMs: 20_000, ...(signal ? { signal } : {}) },
      );
      if (value === null || value === undefined) return pendingDiagnostics();
      return normalizeDiagnosticsFresh(asRecord(value));
    }

    // Whole-workspace: aggregate cached per-file diagnostics from the server. The
    // server populated these for every file during load; getValidationStatus alone
    // only reports freshness, never the diagnostics themselves.
    const severity = filter.severity === 'information' ? 'info' : filter.severity ?? 'all';
    const limit = typeof filter.limit === 'number' ? filter.limit : 1000;
    const value = await this.lsp.executeCommand<unknown>(
      'cwtools.ai.getAllDiagnostics',
      [severity, limit],
      { timeoutMs: 30_000, ...(signal ? { signal } : {}) },
    );
    if (value === null || value === undefined) return pendingDiagnostics();
    const raw = asRecord(value);
    if (raw.ok === false || raw.status === 'unavailable') {
      return unavailableDiagnostics(raw);
    }
    const freshness = normalizeFreshnessValue(raw.freshness);
    return {
      ok: true,
      status: freshness,
      diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics.map(normalizeDiagnosticRecord) : [],
      totalCount: numberOrUndefined(raw.totalCount),
      errorCount: numberOrUndefined(raw.errorCount),
      warningCount: numberOrUndefined(raw.warningCount),
      truncated: raw.truncated === true,
      freshness: {
        value: freshness,
        pendingKinds: asStringArray(raw.pendingGlobalKinds),
        epoch: numberOrUndefined(raw.epoch),
      },
    };
  }
}

function pendingDiagnostics(): DiagnosticsQueryResult {
  return {
    ok: true,
    status: 'pending',
    diagnostics: [],
    freshness: { value: 'pending', pendingKinds: ['game_model'] },
  };
}

function normalizeFreshnessValue(value: unknown): DiagnosticsQueryResult['status'] {
  return value === 'fresh' || value === 'pending' || value === 'stale' || value === 'unavailable'
    ? value
    : 'fresh';
}

function normalizeDiagnosticsFresh(raw: Record<string, unknown>): DiagnosticsQueryResult {
  if (raw.ok === false || raw.status === 'unavailable') {
    return unavailableDiagnostics(raw);
  }
  const freshness = String(raw.freshness ?? 'unavailable') as DiagnosticsQueryResult['status'];
  return {
    ok: true,
    status: freshness,
    diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics.map(normalizeDiagnosticRecord) : [],
    freshness: {
      value: freshness,
      pendingKinds: asStringArray(raw.pendingGlobalKinds),
      validatedVersion: numberOrUndefined(raw.validatedVersion),
      epoch: numberOrUndefined(raw.epoch),
      updatedAt: numberOrUndefined(raw.updatedAtUnixMs),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {
        ok: false,
        status: 'unavailable',
        error: {
          code: 'lsp_no_response',
          message: 'LSP returned no diagnostics response.',
        },
      };
}

function unavailableDiagnostics(raw: Record<string, unknown>): DiagnosticsQueryResult {
  const error = raw.error && typeof raw.error === 'object' ? raw.error as Record<string, unknown> : {};
  return {
    ok: false,
    status: 'unavailable',
    diagnostics: [],
    error: {
      code: String(error.code ?? 'lsp_unavailable'),
      message: String(error.message ?? 'Diagnostics are unavailable.'),
    },
  };
}

function normalizeDiagnosticRecord(value: unknown): DiagnosticRecord {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const severity = String(record.severity ?? 'information');
  return {
    file: typeof record.file === 'string' ? record.file : undefined,
    line: numberOrUndefined(record.line),
    column: numberOrUndefined(record.column),
    severity: severity === 'error' || severity === 'warning' || severity === 'hint' ? severity : 'information',
    code: typeof record.code === 'string' ? record.code : undefined,
    message: String(record.message ?? ''),
    source: typeof record.source === 'string' ? record.source : 'cwtools',
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)) : [];
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

class NodeFilesystemHost implements FilesystemHost {
  constructor(private readonly workspaceRoot: string, private readonly writesEnabled: boolean) {}

  async readTextFile(filePath: string) {
    const resolved = this.resolve(filePath);
    if (!fssync.existsSync(resolved)) {
      return { content: '', hasBom: false, exists: false };
    }
    const content = await fs.readFile(resolved, 'utf8');
    return {
      content,
      hasBom: content.charCodeAt(0) === 0xfeff,
      exists: true,
    };
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    if (!this.writesEnabled) {
      throw new Error('writes_disabled');
    }
    const resolved = this.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
  }

  async list(dirPath: string): Promise<DirectoryEntry[]> {
    const resolved = this.resolve(dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    return entries.map(entry => {
      const fullPath = path.join(resolved, entry.name);
      const stat = fssync.existsSync(fullPath) ? fssync.statSync(fullPath) : undefined;
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: stat?.isFile() ? stat.size : undefined,
      };
    });
  }

  async glob(pattern: string, options?: { limit?: number }): Promise<string[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? 500, 5000));
    const suffix = pattern.startsWith('**/*') ? pattern.slice(4) : pattern;
    const results: string[] = [];
    await walk(this.workspaceRoot, async filePath => {
      if (results.length >= limit) return;
      if (!suffix || filePath.replace(/\\/g, '/').endsWith(suffix.replace(/\\/g, '/'))) {
        results.push(path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/'));
      }
    });
    return results;
  }

  private resolve(filePath: string): string {
    const resolution = resolveWorkspacePath(this.workspaceRoot, filePath);
    if (!resolution.ok || !resolution.resolvedPath) {
      throw new Error(`Path '${filePath}' is outside the workspace root.`);
    }
    return resolution.resolvedPath;
  }
}

class ThinNodeIndexHost implements IndexHost {
  constructor(private readonly workspaceRoot: string) {}

  async queryWorkspace(query: WorkspaceIndexQuery): Promise<IndexQueryResult<WorkspaceIndexEntry>> {
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    const entries: WorkspaceIndexEntry[] = [];
    await walk(this.workspaceRoot, async filePath => {
      if (entries.length >= limit) return;
      const rel = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
      if (!isWorkspaceIndexFile(rel)) return;
      if (query.directory && !rel.toLowerCase().includes(query.directory.toLowerCase())) return;
      const content = await fs.readFile(filePath, 'utf8').catch(() => '');
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && entries.length < limit; index++) {
        const symbol = parseSymbol(lines[index] ?? '', rel);
        if (!symbol) continue;
        if (!matchesName(symbol.name, query.name, query)) continue;
        if (query.kind && symbol.kind !== query.kind) continue;
        if (query.category && symbol.category !== query.category) continue;
        if (query.source && symbol.source !== query.source) continue;
        entries.push({
          ...symbol,
          file: rel,
          line: index,
          origin: 'workspace',
          updatedAt: fssync.statSync(filePath).mtimeMs,
        });
      }
    });
    return {
      status: 'ready',
      totalCount: entries.length,
      entries,
      indexedSymbolNames: entries.length,
      indexUpdatedAt: Date.now(),
      _hint: 'Phase 0 thin Node index only returns lightweight workspace symbols; LSP/index commands remain the Phase 1 source of truth.',
    };
  }

  async queryLocalisation(query: LocalisationIndexQuery): Promise<IndexQueryResult<LocalisationIndexEntry>> {
    const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
    const entries: LocalisationIndexEntry[] = [];
    await walk(this.workspaceRoot, async filePath => {
      if (entries.length >= limit) return;
      const rel = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
      if (!isLocalisationFile(rel)) return;
      const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
      const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const lines = content.split(/\r?\n/);
      let language = '';
      for (let index = 0; index < lines.length && entries.length < limit; index++) {
        const line = lines[index] ?? '';
        const header = line.match(/^\s*(l_[a-z_]+):/i);
        if (header?.[1]) language = header[1];
        const match = line.match(/^\s*([\w.-]+):\d*\s*"([^"]*)"/);
        if (!match?.[1]) continue;
        if (query.language && query.language !== language) continue;
        if (!matchesLocalisationKey(match[1], query)) continue;
        entries.push({
          key: match[1],
          value: match[2] ?? '',
          file: rel,
          line: index,
          language,
        });
      }
    });
    return {
      status: 'ready',
      totalCount: entries.length,
      entries,
      indexUpdatedAt: Date.now(),
      _hint: 'Phase 0 thin Node localisation index scans workspace YML files only.',
    };
  }
}

async function walk(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  if (!fssync.existsSync(root)) return;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.cwtools') continue;
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, visit);
    } else {
      await visit(fullPath);
    }
  }
}

function isWorkspaceIndexFile(relativePath: string): boolean {
  return /\.(txt|gfx|asset|gui)$/i.test(relativePath);
}

function isLocalisationFile(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  return /\.yml$/.test(normalized)
    && (normalized.startsWith('localisation/')
      || normalized.startsWith('localisation_synced/')
      || normalized.startsWith('localization/'));
}

function parseSymbol(line: string, relativePath: string): Omit<WorkspaceIndexEntry, 'file' | 'line' | 'origin'> | null {
  const namespace = line.match(/^\s*namespace\s*=\s*"?([\w.:-]+)"?/);
  if (namespace?.[1]) {
    return { name: namespace[1], kind: 'namespace', source: 'script', category: 'event' };
  }
  const id = line.match(/^\s*id\s*=\s*"?([\w.:-]+)"?/);
  if (id?.[1]) {
    return { name: id[1], kind: 'event', source: 'script', category: 'event' };
  }
  const topLevel = line.match(/^([@\w][\w.:-]*)\s*=/);
  if (topLevel?.[1]) {
    const source = relativePath.endsWith('.gui') ? 'gui' : relativePath.endsWith('.gfx') || relativePath.endsWith('.asset') ? 'asset' : 'script';
    return { name: topLevel[1], kind: 'symbol', source, category: source === 'script' ? 'script' : source };
  }
  const sprite = line.match(/\bname\s*=\s*"?(GFX_[\w.:-]+)"?/);
  if (sprite?.[1]) {
    return { name: sprite[1], kind: 'sprite', source: 'asset', category: 'asset' };
  }
  return null;
}

function matchesName(name: string, queryName: string | undefined, query: WorkspaceIndexQuery): boolean {
  if (!queryName) return true;
  const needle = queryName.toLowerCase();
  const haystack = name.toLowerCase();
  if (query.exact) return haystack === needle;
  if (query.prefix) return haystack.startsWith(needle);
  return haystack.includes(needle);
}

function matchesLocalisationKey(key: string, query: LocalisationIndexQuery): boolean {
  if (!query.key) return true;
  const haystack = query.caseSensitive ? key : key.toLowerCase();
  const needle = query.caseSensitive ? query.key : query.key.toLowerCase();
  if (query.prefix) return haystack.startsWith(needle);
  if (query.contains) return haystack.includes(needle);
  return haystack === needle || haystack.includes(needle);
}
