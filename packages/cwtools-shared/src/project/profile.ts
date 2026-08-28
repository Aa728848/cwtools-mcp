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
  schemaVersion: 4;
  generatedAt: string;
  workspaceRoot: string;
  workspaceKind: string;
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
  keyDirectories: Array<{
    key: string;
    path: string;
    exists: boolean;
    fileCount?: number;
  }>;
  localisation: {
    roots: string[];
    languages: string[];
    defaultLanguage?: string;
    encoding: string;
    encodingByLanguage?: Record<string, string>;
    sampleFiles: string[];
  };
  identifiers: Record<string, unknown>;
  routing: Record<string, unknown>;
  validation: Record<string, unknown>;
  freshness?: Record<string, unknown>;
  warnings?: string[];
  guidanceCards: Partial<Record<ProjectGuidanceCard, string>>;
  efficiencyHints: string[];
  [key: string]: unknown;
}

export const PROJECT_PROFILE_RELATIVE_PATH = path.join('.cwtools', 'project', 'profile.json');

export function getProjectProfilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, PROJECT_PROFILE_RELATIVE_PATH);
}

export function isProjectProfile(value: unknown): value is ProjectProfile {
  return !!value
    && typeof value === 'object'
    && (value as { schemaVersion?: unknown }).schemaVersion === 4
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
          _hint: 'Run /init in the VS Code extension or create .cwtools/project/profile.json, then retry.',
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
