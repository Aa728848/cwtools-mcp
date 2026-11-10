import {
  analyzeDiagnosticKnowledge,
  getProjectProfilePath,
  queryGameKnowledge,
  queryWorkflowHints,
  type HostServices,
} from 'cwtools-shared';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const RESOURCE_URIS = [
  'cwtools://knowledge/game',
  'cwtools://knowledge/diagnostic-routing',
  'cwtools://knowledge/workflow-hints',
  'cwtools://project/profile',
  'cwtools://project/knowledge-manifest',
  'cwtools://skills/catalog',
] as const;

export function listResources(host?: HostServices) {
  const base = [
    {
      uri: 'cwtools://knowledge/game',
      name: 'CWTools game knowledge',
      description: 'Current-game semantic catalog summary and stable evidence-routing guidance.',
      mimeType: 'application/json',
    },
    {
      uri: 'cwtools://knowledge/diagnostic-routing',
      name: 'CWTools diagnostic routing',
      description: 'Structured diagnostic routing guidance and suggested tools.',
      mimeType: 'application/json',
    },
    {
      uri: 'cwtools://knowledge/workflow-hints',
      name: 'CWTools workflow hints',
      description: 'Reusable workflow hints for diagnostics, localisation, and entity lookup.',
      mimeType: 'application/json',
    },
    {
      uri: 'cwtools://project/profile',
      name: 'CWTools project profile',
      description: 'The generated .cwtools/project/profile.json if available.',
      mimeType: 'application/json',
    },
    {
      uri: 'cwtools://project/knowledge-manifest',
      name: 'CWTools project knowledge manifest',
      description: 'Freshness, domains, counts, and fingerprints for the /init-generated semantic knowledge pack.',
      mimeType: 'application/json',
    },
    {
      uri: 'cwtools://skills/catalog',
      name: 'CWTools Paradox skills catalog',
      description: 'Catalog of workspace and user Paradox modding skills exposed as cwtools://skills/<name> resources.',
      mimeType: 'application/json',
    },
  ];

  if (host?.projectSupported === false) return [];
  if (host?.projectKind === 'cwt-only') {
    return base.filter(resource => resource.uri === 'cwtools://knowledge/diagnostic-routing');
  }
  if (host?.workspaceRoot) {
    for (const skill of discoverSkills(host.workspaceRoot)) {
      base.push({
        uri: `cwtools://skills/${encodeURIComponent(skill.name)}`,
        name: `Paradox Skill: ${skill.name}`,
        description: skill.description || `Paradox modding skill ${skill.name}`,
        mimeType: 'text/markdown',
      });
    }
  }

  return base;
}

export async function readResource(host: HostServices, uri: string) {
  if (host.projectSupported === false
    || (host.projectKind === 'cwt-only' && uri !== 'cwtools://knowledge/diagnostic-routing')) {
    const code = host.projectKind === 'ambiguous'
      ? 'project_ambiguous'
      : host.projectSupported === false ? 'project_not_supported' : 'resource_not_available_in_cwt_only';
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: `${JSON.stringify({ status: 'error', error: { code, message: host.projectSupportReason ?? 'Resource is not available for this workspace.' } }, null, 2)}\n`,
      }],
    };
  }
  if (uri.startsWith('cwtools://skills/') && uri !== 'cwtools://skills/catalog') {
    const skillName = decodeURIComponent(uri.slice('cwtools://skills/'.length));
    const found = discoverSkills(host.workspaceRoot).find(entry => entry.name === skillName);
    if (found && fs.existsSync(found.filePath)) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: `${fs.readFileSync(found.filePath, 'utf8').trim()}\n`,
          },
        ],
      };
    }
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: `${JSON.stringify({
            status: 'error',
            error: { code: 'skill_not_found', message: `Unknown CWTools skill: ${skillName}` },
          }, null, 2)}\n`,
        },
      ],
    };
  }

  const data = await readResourceData(host, uri);
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: `${JSON.stringify(data, null, 2)}\n`,
      },
    ],
  };
}

interface DiscoveredSkill {
  name: string;
  description: string;
  source: 'project' | 'user';
  filePath: string;
}

function discoverSkills(workspaceRoot: string): DiscoveredSkill[] {
  const roots: Array<{ dir: string; source: 'project' | 'user' }> = [];
  if (workspaceRoot) {
    roots.push({ dir: path.join(workspaceRoot, '.agents', 'skills'), source: 'project' });
    roots.push({ dir: path.join(workspaceRoot, '.cwtools', 'skills'), source: 'project' });
  }
  const home = os.homedir();
  if (home) {
    roots.push({ dir: path.join(home, '.cwtools', 'skills'), source: 'user' });
  }

  const byName = new Map<string, DiscoveredSkill>();
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(root.dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      let raw = '';
      try {
        raw = fs.readFileSync(skillFile, 'utf8');
      } catch {
        continue;
      }
      const descMatch = raw.match(/^description\s*:\s*(.+)$/m);
      const description = descMatch ? descMatch[1]!.trim().replace(/^['"]|['"]$/g, '') : `Paradox skill ${entry.name}`;
      if (!byName.has(entry.name)) {
        byName.set(entry.name, {
          name: entry.name,
          description,
          source: root.source,
          filePath: skillFile,
        });
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readResourceData(host: HostServices, uri: string): Promise<unknown> {
  switch (uri) {
    case 'cwtools://knowledge/game': {
      const catalog = await host.lsp.executeCommand(
        'cwtools.ai.getSemanticCatalog',
        [[], []],
        { timeoutMs: 10_000 },
      ).catch(() => undefined);
      return queryGameKnowledge('paradox', catalog);
    }
    case 'cwtools://knowledge/diagnostic-routing':
      return {
        status: 'ready',
        routes: [
          analyzeDiagnosticKnowledge({ message: 'syntax error' }),
          analyzeDiagnosticKnowledge({ message: 'missing localisation key' }),
          analyzeDiagnosticKnowledge({ message: 'scope mismatch' }),
          analyzeDiagnosticKnowledge({ message: 'unknown' }),
        ],
      };
    case 'cwtools://knowledge/workflow-hints':
      return queryWorkflowHints();
    case 'cwtools://project/profile': {
      const profilePath = getProjectProfilePath(host.workspaceRoot);
      const read = await host.filesystem.readTextFile(profilePath);
      return read.exists
        ? JSON.parse(read.content)
        : {
            status: 'missing',
            profilePath,
            _hint: 'Run /init in the VS Code extension or create .cwtools/project/profile.json.',
          };
    }
    case 'cwtools://project/knowledge-manifest': {
      const manifestPath = path.join(host.workspaceRoot, '.cwtools', 'project', 'knowledge', 'manifest.json');
      const read = await host.filesystem.readTextFile(manifestPath);
      return read.exists
        ? JSON.parse(read.content)
        : {
            status: 'missing',
            manifestPath,
            _hint: 'Run /init in the VS Code extension and wait for the deep semantic phase.',
          };
    }
    case 'cwtools://skills/catalog': {
      const skills = discoverSkills(host.workspaceRoot);
      return {
        status: 'ready',
        count: skills.length,
        skills: skills.map(skill => ({
          name: skill.name,
          description: skill.description,
          source: skill.source,
          uri: `cwtools://skills/${encodeURIComponent(skill.name)}`,
        })),
      };
    }
    default:
      return {
        status: 'error',
        error: {
          code: 'resource_not_found',
          message: `Unknown CWTools MCP resource: ${uri}`,
        },
      };
  }
}
