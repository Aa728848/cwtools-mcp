import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import type { SharedToolResult } from '../tools/schema';

export type ProjectGuidanceCard =
  | 'implementation'
  | 'planning'
  | 'exploration'
  | 'review'
  | 'utility'
  | 'localisation'
  | 'assets'
  | 'coordination'
  | 'paradox_coordination';

export interface QueryProjectProfileArgs {
  section?: 'summary' | 'routing' | 'directories' | 'localisation' | 'identifiers' | 'validation' | 'compatibility' | 'guidanceCards' | 'all';
  guidance?: ProjectGuidanceCard;
}

export interface ProjectProfile {
  schemaVersion: typeof PROJECT_PROFILE_SCHEMA_VERSION;
  generatedAt: string;
  workspaceRoot: string;
  workspaceKind: 'paradox_mod' | 'extension_source' | 'mixed' | 'generic';
  projectName: string;
  game: {
    id: string;
    displayName: string;
    confidence: 'high' | 'medium' | 'low';
    evidence: string[];
  };
  modInfo?: {
    name?: string;
    version?: string;
    tags?: string[];
    supportedVersion?: string;
    remoteFileId?: string;
    dependencies?: string[];
  };
  compatibility?: {
    supportedVersion?: string;
    declaredDependencies: Array<{ name: string; source: string }>;
    possibleSoftDependencies: Array<{
      idOrPrefix: string;
      evidence: string;
      confidence: 'heuristic';
      sources?: Array<'placeholder' | 'ignored_diagnostic' | 'definition_stack' | 'unresolved_id'>;
      sampleIds?: string[];
    }>;
    dependencyRoots: Array<{ name: string; root?: string; status: 'resolved' | 'unresolved'; source: string }>;
    loadOrder: {
      source: 'descriptor_only' | 'launcher_or_lsp';
      confidence: 'partial' | 'active';
      orderedLayers: string[];
      warnings: string[];
    };
    coverage: {
      unresolvedIdInference: 'not_available' | 'available';
      truncated: boolean;
      evidenceSources?: string[];
      unavailableSources?: string[];
    };
  };
  keyDirectories: Array<{ key: string; path: string; exists: boolean; fileCount?: number }>;
  localisation: {
    roots: string[];
    languages: string[];
    defaultLanguage?: string;
    encoding: string;
    encodingByLanguage?: Record<string, string>;
    sampleFiles: string[];
  };
  identifiers: {
    namespaces: string[];
    namespaceDetails?: Array<{
      name: string;
      origin: 'workspace_owned' | 'vanilla_override' | 'compatibility' | 'external';
      files: string[];
      evidence: string;
    }>;
    variablePrefixes: string[];
    byType: Record<string, string[]>;
    byTypeCounts?: Record<string, number>;
  };
  routing: { preferredReadTools: string[]; avoidPatterns: string[] };
  validation: {
    lspReady: 'unknown' | 'ready' | 'not_ready';
    indexStatus: 'unknown' | 'ready' | 'partial' | 'indexing' | 'idle' | 'unavailable';
    vanillaCache: 'unknown' | 'configured' | 'missing';
    vanillaCacheEvidence?: string;
  };
  freshness?: {
    knowledgeStatus?: 'ready' | 'partial' | 'stale' | 'unavailable';
    knowledgeGeneratedAt?: string;
    staleReasons?: string[];
  };
  warnings?: string[];
  guidanceCards: Partial<Record<ProjectGuidanceCard, string>>;
  efficiencyHints: string[];
}

export const PROJECT_PROFILE_SCHEMA_VERSION = 4 as const;

export const PROJECT_PROFILE_RELATIVE_PATH = path.join('.cwtools', 'project', 'profile.json');

export function getProjectProfilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, PROJECT_PROFILE_RELATIVE_PATH);
}

export function isProjectProfile(value: unknown): value is ProjectProfile {
  return !!value
    && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === PROJECT_PROFILE_SCHEMA_VERSION
    && typeof (value as { projectName?: unknown }).projectName === 'string';
}

export function buildProfileSummary(profile: ProjectProfile): string {
  const dirs = profile.keyDirectories.filter(dir => dir.exists).map(dir => dir.path).slice(0, 8).join(', ') || 'none';
  const namespaces = Array.isArray(profile.identifiers.namespaces)
    ? profile.identifiers.namespaces.slice(0, 8).join(', ') || 'none'
    : 'none';
  const languages = profile.localisation.languages.join(', ') || 'unknown';
  const supportedVersion = typeof profile.modInfo?.supportedVersion === 'string' ? ` (${profile.modInfo.supportedVersion})` : '';
  return [
    `Project: ${profile.projectName}`,
    `Kind: ${profile.workspaceKind}`,
    `Game: ${profile.game.displayName}${supportedVersion}`,
    `Key dirs: ${dirs}`,
    `Namespaces: ${namespaces}`,
    `Localisation: ${languages} (${profile.localisation.encoding})`,
  ].join('\n');
}

export function getGuidanceCard(profile: ProjectProfile, guidance?: ProjectGuidanceCard): string | undefined {
  if (!guidance) return undefined;
  return profile.guidanceCards[guidance] ?? profile.guidanceCards.implementation;
}

export function selectProfileSection(profile: ProjectProfile, section: NonNullable<QueryProjectProfileArgs['section']>): unknown {
  switch (section) {
    case 'routing': return profile.routing;
    case 'directories': return profile.keyDirectories;
    case 'localisation': return profile.localisation;
    case 'identifiers': return profile.identifiers;
    case 'validation': return profile.validation;
    case 'compatibility': return {
      supportedVersion: profile.modInfo?.supportedVersion,
      remoteFileId: profile.modInfo?.remoteFileId,
      dependencies: profile.modInfo?.dependencies ?? [],
      vanillaCache: profile.validation?.vanillaCache,
      game: profile.game,
    };
    case 'guidanceCards': return profile.guidanceCards;
    case 'all': return profile;
    case 'summary':
    default:
      return {
        workspaceKind: profile.workspaceKind,
        projectName: profile.projectName,
        game: profile.game,
        supportedVersion: profile.modInfo?.supportedVersion,
        generatedAt: profile.generatedAt,
        freshness: profile.freshness,
        warnings: profile.warnings ?? [],
        efficiencyHints: profile.efficiencyHints,
      };
  }
}

export async function queryProjectProfileWithHost(
  host: HostServices,
  args: QueryProjectProfileArgs = {},
): Promise<SharedToolResult> {
  const profilePath = getProjectProfilePath(host.workspaceRoot);
  try {
    const read = await host.filesystem.readTextFile(profilePath);
    if (!read.exists) {
      return {
        ok: false,
        status: 'unavailable',
        source: 'cwtools-shared',
        error: {
          code: 'profile_missing',
          message: 'Project profile is missing.',
        },
        data: {
          status: 'missing',
          profilePath,
          _hint: 'Call initialize_project to generate .cwtools/project/profile.json, then retry.',
        },
      };
    }

    const parsed = JSON.parse(read.content) as unknown;
    if (!isProjectProfile(parsed)) {
      return {
        ok: false,
        status: 'error',
        source: 'cwtools-shared',
        error: {
          code: 'invalid_profile',
          message: 'Project profile exists but is not a valid schemaVersion 4 profile.',
        },
      };
    }

    const section = args.section ?? 'summary';
    return {
      ok: true,
      status: 'ready',
      source: 'cwtools-shared',
      data: {
        status: 'ready',
        profilePath,
        generatedAt: parsed.generatedAt,
        section,
        profile: section === 'all' ? parsed : undefined,
        summary: buildProfileSummary(parsed),
        data: selectProfileSection(parsed, section),
        guidanceCard: getGuidanceCard(parsed, args.guidance),
        _hint: 'Use section="routing", "localisation", "identifiers", or a targeted guidance card for focused context.',
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      source: 'cwtools-shared',
      error: {
        code: 'profile_error',
        message: error instanceof Error ? error.message : String(error),
      },
      data: {
        status: 'error',
        profilePath,
      },
    };
  }
}
