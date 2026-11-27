import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import { throwIfAborted } from '../host/lsp';
import type { SharedToolResult } from '../tools/schema';
import { buildProjectProfile, writeProjectProfile, mergeDeepCompatibilityEvidence } from './profileBuilder';
import { getProjectProfilePath, type ProjectProfile } from './profile';
import { CURRENT_KNOWLEDGE_SCHEMA_VERSION, PROJECT_KNOWLEDGE_RELATIVE_DIR } from './knowledge';
import { getWorkspaceDetectionProfiles } from '../generated/workspaceDetectionProfiles';

export interface InitializeProjectArgs {
  mode?: 'full' | 'incremental';
  changedFiles?: string[];
  domains?: string[];
}

interface KnowledgeSnapshot {
  ok: boolean;
  status: 'ready' | 'partial' | 'stale' | 'loading' | 'unavailable' | 'error';
  schemaVersion?: number;
  capabilityVersions?: Record<string, number>;
  capabilityStatus?: Record<string, 'ready' | 'unavailable'>;
  game?: string;
  generatedAtUnixMs?: number;
  graphVersion?: number;
  completeExport?: boolean;
  projectRoots?: string[];
  generationMode?: 'full' | 'incremental' | 'unchanged';
  counts?: Record<string, number>;
  domains?: Array<Record<string, unknown>>;
  definitionStacks?: Array<Record<string, unknown>>;
  unresolved?: Array<Record<string, unknown>>;
  freshness?: Record<string, unknown>;
  baseline?: Record<string, unknown>;
  coverage?: Record<string, unknown>;
  warnings?: string[];
  error?: string;
}

const CAPABILITY_VERSIONS = Object.freeze({
  inlineGraph: 3,
  stateFlow: 3,
  overrideResolution: 2,
  interfaceGraph: 2,
  localisationAudit: 3,
  pdxFlow: 4,
});
const inFlight = new Map<string, Promise<SharedToolResult>>();
const RELEVANT_EXTENSIONS = new Set(['.txt', '.gfx', '.asset', '.gui', '.yml', '.cwt', '.mod', '.shader', '.fxh']);
const EXCLUDED_DIRECTORIES = new Set(['.git', '.cwtools', 'node_modules', 'release', 'artifacts', 'dist', 'out']);
const OBSOLETE_FILES = ['snapshot.json', 'topology.json', 'definition-stacks.json', 'override-map.json', 'unresolved.json'];

function keyFor(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeStringList(value: unknown, max: number, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string')) {
    throw new Error(field + ' must be a string array with at most ' + max + ' entries');
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))].sort();
}

function normalizeArgs(args: InitializeProjectArgs): Required<InitializeProjectArgs> {
  const mode = args.mode ?? 'full';
  if (mode !== 'full' && mode !== 'incremental') throw new Error('mode must be full or incremental');
  const changedFiles = normalizeStringList(args.changedFiles, 500, 'changedFiles') ?? [];
  for (const file of changedFiles) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('changedFiles must be workspace-relative paths without ..');
  }
  return { mode, changedFiles, domains: normalizeStringList(args.domains, 64, 'domains') ?? [] };
}

function hashParts(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function collectProjectFacts(root: string, maxFiles = 10000): string[] {
  const facts: string[] = [];
  const stack = [root];
  while (stack.length > 0 && facts.length < maxFiles) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (facts.length >= maxFiles) break;
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(fullPath); continue; }
      if (!entry.isFile() || !RELEVANT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const stat = fs.statSync(fullPath);
        facts.push(path.relative(root, fullPath).replace(/\\/g, '/') + ':' + stat.size + ':' + stat.mtimeMs);
      } catch { /* concurrent disappearance */ }
    }
  }
  return facts.sort();
}

function pathFact(target: string | undefined): string {
  if (!target) return 'missing';
  try {
    const stat = fs.statSync(target);
    return path.resolve(target) + ':' + stat.size + ':' + stat.mtimeMs;
  } catch { return path.resolve(target) + ':missing'; }
}

function rulesFingerprint(host: HostServices, graphVersion?: number): string {
  return hashParts([
    host.projectGameId ?? 'paradox',
    ...(host.rules?.configDirs ?? []).map(pathFact),
    String(graphVersion ?? ''),
  ]);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    try { fs.rmSync(filePath, { force: true }); } catch { /* ignored */ }
    fs.renameSync(temporary, filePath);
  }
}

function instructionsTemplate(): string {
  return [
    '# CWTools Project Instructions',
    '',
    '<!-- User-owned. initialize_project creates this file only when missing and never rewrites it.',
    'Machine-generated facts live in .cwtools/project/profile.json and .cwtools/project/knowledge/. -->',
    '',
    '## Project Instructions',
    '',
    '<!-- Add stable project conventions, naming rules, and validation requirements here. -->',
    '',
  ].join('\n');
}

function manifestPaths(root: string) {
  const knowledgeRoot = path.join(root, PROJECT_KNOWLEDGE_RELATIVE_DIR);
  return {
    knowledgeRoot,
    databasePath: path.join(knowledgeRoot, 'knowledge.sqlite'),
    manifestPath: path.join(knowledgeRoot, 'manifest.json'),
  };
}

function baseManifest(host: HostServices, profile: ProjectProfile, snapshot?: KnowledgeSnapshot) {
  const paths = manifestPaths(host.workspaceRoot);
  const projectRoots = snapshot?.projectRoots?.length ? snapshot.projectRoots : [host.workspaceRoot];
  return {
    schemaVersion: CURRENT_KNOWLEDGE_SCHEMA_VERSION,
    capabilityVersions: { ...CAPABILITY_VERSIONS, ...(snapshot?.capabilityVersions ?? {}) },
    capabilityStatus: Object.fromEntries(Object.keys(CAPABILITY_VERSIONS).map(key => [
      key,
      snapshot?.capabilityStatus?.[key] === 'ready' ? 'ready' : 'unavailable',
    ])),
    generatedAt: new Date(snapshot?.generatedAtUnixMs ?? Date.now()).toISOString(),
    generationMode: snapshot?.generationMode ?? 'full',
    status: snapshot?.status ?? 'unavailable',
    game: snapshot?.game || profile.game.id,
    graphVersion: snapshot?.graphVersion,
    completeExport: snapshot?.completeExport === true,
    projectRoots,
    domains: Array.isArray(snapshot?.domains)
      ? snapshot.domains.map(item => typeof item.id === 'string' ? item.id : '').filter(Boolean).sort()
      : [],
    counts: snapshot?.counts ?? {},
    fingerprints: {
      project: hashParts(projectRoots.sort().flatMap(root => [path.resolve(root), ...collectProjectFacts(root)])),
      vanilla: hashParts([pathFact(host.vanillaCache?.gamePath), pathFact(host.vanillaCache?.cacheFile)]),
      rules: rulesFingerprint(host, snapshot?.graphVersion),
    },
    freshness: snapshot?.freshness,
    baseline: snapshot?.baseline,
    coverage: snapshot?.coverage,
    warnings: snapshot?.warnings ?? [],
    staleReasons: [] as string[],
    artifacts: [] as string[],
    database: { path: 'knowledge.sqlite', format: 'sqlite', schemaVersion: CURRENT_KNOWLEDGE_SCHEMA_VERSION },
    _paths: paths,
  };
}

function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Operation cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForKnowledgeModel(host: HostServices, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const status = asRecord(await host.lsp.executeCommand('cwtools.ai.getValidationStatus', [], { timeoutMs: 10_000, ...(signal ? { signal } : {}) }));
    const loading = asRecord(status.loading);
    const lastError = loading.lastError ?? asRecord(status.runtime).lastError;
    if (lastError) throw new Error('CWTools model load failed: ' + String(lastError));
    if (status.modelReadyForKnowledgeExport === true && loading.phase === 'ready') return;
    await waitForRetry(500, signal);
  }
  throw new Error('Timed out waiting for the CWTools game model to finish loading.');
}

async function exportKnowledge(host: HostServices, profile: ProjectProfile, args: Required<InitializeProjectArgs>, signal?: AbortSignal): Promise<KnowledgeSnapshot> {
  await waitForKnowledgeModel(host, signal);
  const paths = manifestPaths(host.workspaceRoot);
  fs.mkdirSync(paths.knowledgeRoot, { recursive: true });
  let lastError: Error | undefined;
  for (const delay of [0, 2000, 5000]) {
    throwIfAborted(signal);
    if (delay > 0) await waitForRetry(delay, signal);
    const raw = await host.lsp.executeCommand('cwtools.ai.exportProjectKnowledge', [{
      domains: args.domains,
      changedFiles: args.changedFiles,
      maxDefinitions: 100000,
      maxTopologyFiles: 1200,
      maxEdges: 8000,
      archetypesPerDomain: 8,
      completeExport: true,
      requireReady: true,
      databasePath: paths.databasePath,
      workspaceRoot: path.resolve(host.workspaceRoot),
      vanillaRoot: host.vanillaCache?.gamePath,
      generationMode: args.mode,
    }], { timeoutMs: 600000, ...(signal ? { signal } : {}) });
    if (raw === null || raw === undefined) throw new Error('CWTools exportProjectKnowledge returned no response.');
    const snapshot = asRecord(raw) as unknown as KnowledgeSnapshot;
    if (snapshot.ok === true) return snapshot;
    lastError = new Error(snapshot.error || 'CWTools project knowledge export failed.');
    if (snapshot.status !== 'loading' && snapshot.status !== 'stale') break;
  }
  throw lastError ?? new Error('CWTools project knowledge export is unavailable.');
}

async function performInitialization(host: HostServices, rawArgs: InitializeProjectArgs, signal?: AbortSignal): Promise<SharedToolResult> {
  const args = normalizeArgs(rawArgs);
  const profile = buildProjectProfile(host.workspaceRoot);
  const hostGame = host.projectGameId;
  if (hostGame && !['paradox', 'unknown', 'cwt'].includes(hostGame) && profile.game.id !== hostGame) {
    const known = getWorkspaceDetectionProfiles().find(candidate => candidate.id === hostGame);
    profile.game = {
      id: hostGame,
      displayName: known?.displayName ?? hostGame,
      confidence: 'high',
      evidence: ['The active host explicitly selected this game.'],
    };
  }
  const profilePath = getProjectProfilePath(host.workspaceRoot);
  const instructionsPath = path.join(host.workspaceRoot, 'CWTOOLS.md');
  const instructionsCreated = !fs.existsSync(instructionsPath);
  if (instructionsCreated) fs.writeFileSync(instructionsPath, instructionsTemplate(), 'utf8');
  const paths = manifestPaths(host.workspaceRoot);
  try {
    const snapshot = await exportKnowledge(host, profile, args, signal);
    if (Number(snapshot.schemaVersion) !== CURRENT_KNOWLEDGE_SCHEMA_VERSION) {
      throw new Error('Obsolete project knowledge schema V' + Number(snapshot.schemaVersion || 0) + '; expected V' + CURRENT_KNOWLEDGE_SCHEMA_VERSION + '.');
    }
    if (!fs.existsSync(paths.databasePath)) throw new Error('CWTools reported success but knowledge.sqlite was not created.');
    if (snapshot.generationMode === 'unchanged' && fs.existsSync(profilePath) && fs.existsSync(paths.manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8')) as ReturnType<typeof baseManifest>;
      return {
        ok: true,
        status: snapshot.status === 'partial' ? 'partial' : 'ready',
        source: 'cwtools-project-init',
        data: { profilePath, instructionsPath, instructionsCreated, databasePath: paths.databasePath, manifestPath: paths.manifestPath, manifest },
        warnings: snapshot.warnings,
      };
    }
    mergeDeepCompatibilityEvidence(profile, snapshot);
    const manifest = baseManifest(host, profile, snapshot);
    manifest.artifacts = ['knowledge.sqlite'];
    profile.freshness = {
      knowledgeStatus: snapshot.status === 'ready' || snapshot.status === 'partial' ? snapshot.status : 'unavailable',
      knowledgeGeneratedAt: manifest.generatedAt,
      staleReasons: [],
    };
    writeProjectProfile(host.workspaceRoot, profile);
    writeJsonAtomic(paths.manifestPath, manifest);
    for (const name of OBSOLETE_FILES) {
      try { fs.rmSync(path.join(paths.knowledgeRoot, name), { force: true }); } catch { /* ignored */ }
    }
    return {
      ok: true,
      status: snapshot.status === 'partial' ? 'partial' : 'ready',
      source: 'cwtools-project-init',
      data: { profilePath, instructionsPath, instructionsCreated, databasePath: paths.databasePath, manifestPath: paths.manifestPath, manifest },
      warnings: snapshot.warnings,
    };
  } catch (error) {
    throwIfAborted(signal);
    const message = error instanceof Error ? error.message : String(error);
    writeProjectProfile(host.workspaceRoot, profile);
    const manifest = baseManifest(host, profile);
    manifest.status = 'unavailable';
    manifest.warnings = [message];
    manifest.staleReasons = ['lsp_export_unavailable'];
    writeJsonAtomic(paths.manifestPath, manifest);
    return {
      ok: false,
      status: 'unavailable',
      source: 'cwtools-project-init',
      data: { profilePath, instructionsPath, instructionsCreated, databasePath: paths.databasePath, manifestPath: paths.manifestPath, manifest },
      error: { code: 'project_knowledge_export_unavailable', message },
      nextSteps: ['Wait for the CWTools game model to become ready, then retry initialize_project.'],
    };
  }
}

/** Initialize the current host workspace; concurrent calls share one bounded export. */
export async function initializeProjectWithHost(
  host: HostServices,
  rawArgs: InitializeProjectArgs = {},
  context?: { signal?: AbortSignal },
): Promise<SharedToolResult> {
  if (host.projectKind === 'cwt-only') {
    return {
      ok: false,
      status: 'unavailable',
      source: 'cwtools-project-init',
      error: { code: 'tool_not_available_in_cwt_only', message: 'Project knowledge initialization requires a full Paradox game model.' },
    };
  }
  const key = keyFor(host.workspaceRoot);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = performInitialization(host, rawArgs, context?.signal).finally(() => { inFlight.delete(key); });
  inFlight.set(key, pending);
  return pending;
}
