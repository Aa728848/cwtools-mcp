import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import type { SharedToolResult } from '../tools/schema';

export interface QueryProjectKnowledgeArgs {
  intent?: string;
  domains?: string[];
  identifiers?: string[];
  entityTypes?: string[];
  includeProjectPatterns?: boolean;
  includeVanillaArchetypes?: boolean;
  includeTopology?: boolean;
  includeUnresolved?: boolean;
  includeEventGraph?: boolean;
  limit?: number;
}

export const PROJECT_KNOWLEDGE_RELATIVE_DIR = path.join('.cwtools', 'project', 'knowledge');
export const CURRENT_KNOWLEDGE_SCHEMA_VERSION = 7;
export const PROJECT_KNOWLEDGE_DATABASE_FILE = 'knowledge.sqlite';
export const PROJECT_KNOWLEDGE_MANIFEST_FILE = 'manifest.json';

export function getProjectKnowledgeManifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, KNOWLEDGE_DIR, PROJECT_KNOWLEDGE_MANIFEST_FILE);
}

export async function readProjectKnowledgeManifestWithHost(host: HostServices): Promise<Record<string, unknown> | undefined> {
  return readJson(host, getProjectKnowledgeManifestPath(host.workspaceRoot));
}

const KNOWLEDGE_DIR = PROJECT_KNOWLEDGE_RELATIVE_DIR;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function readJson(host: HostServices, filePath: string): Promise<Record<string, unknown> | undefined> {
  const read = await host.filesystem.readTextFile(filePath);
  if (!read.exists) return undefined;
  try {
    return asRecord(JSON.parse(read.content));
  } catch {
    return undefined;
  }
}

export async function queryProjectKnowledgeWithHost(
  host: HostServices,
  args: QueryProjectKnowledgeArgs = {},
): Promise<SharedToolResult> {
  const root = path.join(host.workspaceRoot, KNOWLEDGE_DIR);
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = await readJson(host, manifestPath);

  if (!manifest) {
    return {
      ok: false,
      status: 'unavailable',
      source: 'cwtools-project-knowledge',
      error: { code: 'knowledge_missing', message: 'Project knowledge pack is missing.' },
      data: {
        status: 'missing',
        manifestPath,
        domains: [],
        evidence: [],
        unresolved: [],
        _hint: 'Call initialize_project and wait for the project knowledge export to complete.',
      },
    };
  }

  const database = asRecord(manifest.database);
  const foundSchemaVersion = Number(database.schemaVersion ?? manifest.schemaVersion) || 0;
  if (Number(manifest.schemaVersion) !== CURRENT_KNOWLEDGE_SCHEMA_VERSION
    || foundSchemaVersion !== CURRENT_KNOWLEDGE_SCHEMA_VERSION) {
    return {
      ok: false,
      status: 'stale',
      source: 'cwtools-project-knowledge-sqlite',
      error: {
        code: 'knowledge_schema_obsolete',
        message: `Project knowledge schema V${foundSchemaVersion} is obsolete. Rebuild it with the current V${CURRENT_KNOWLEDGE_SCHEMA_VERSION} extension.`,
      },
      data: {
        status: 'stale',
        manifestPath,
        rebuildRequired: true,
        foundSchemaVersion,
        currentSchemaVersion: CURRENT_KNOWLEDGE_SCHEMA_VERSION,
        staleReasons: ['schema_version_obsolete'],
        _hint: 'Call initialize_project in full mode to rebuild obsolete knowledge. Old database schemas are not queried.',
      },
    };
  }

  {
    const relativeDatabasePath = typeof database.path === 'string' && database.path.trim()
      ? database.path
      : 'knowledge.sqlite';
    const databasePath = path.resolve(root, relativeDatabasePath);
    const relative = path.relative(root, databasePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return {
        ok: false,
        status: 'error',
        source: 'cwtools-project-knowledge-sqlite',
        error: { code: 'invalid_database_path', message: 'Project knowledge database path escapes the knowledge directory.' },
      };
    }
    const result = asRecord(await host.lsp.executeCommand(
      'cwtools.ai.queryProjectKnowledgeDb',
      [{ databasePath, ...args, includeEventGraph: args.includeEventGraph !== false }],
      { timeoutMs: 30_000 },
    ));
    if (result.ok !== true) {
      return {
        ok: false,
        status: 'error',
        source: 'cwtools-project-knowledge-sqlite',
        error: {
          code: 'knowledge_query_failed',
          message: typeof result.error === 'string' ? result.error : 'Project knowledge SQLite query failed.',
        },
        data: { manifestPath, databasePath },
      };
    }
    const manifestStatus = String(manifest.status ?? 'stale');
    const staleReasons = stringArray(manifest.staleReasons);
    const ready = String(result.status ?? manifestStatus) === 'ready' && manifestStatus === 'ready' && staleReasons.length === 0;
    const partial = staleReasons.length === 0
      && (String(result.status ?? manifestStatus) === 'partial' || manifestStatus === 'partial');
    return {
      ok: true,
      status: ready ? 'ready' : partial ? 'partial' : 'stale',
      source: 'cwtools-project-knowledge-sqlite',
      data: {
        ...result,
        status: ready ? 'ready' : partial ? 'partial' : 'stale',
        manifestPath,
        staleReasons,
      },
    };
  }

}
