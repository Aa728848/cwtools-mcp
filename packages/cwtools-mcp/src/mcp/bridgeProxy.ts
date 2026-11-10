import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { detectWorkspaceProject, type SharedToolResult, type WorkspaceProjectDetection } from 'cwtools-shared';
import type { CwtoolsMcpConfig } from '../config';
import { detectExtensionBridgeManifestPath } from '../hosts/vscodeCache';
import { listResources } from './resources';
import { listRegisteredTools } from './toolRegistrar';
import { toMcpCallToolResult } from './toolHandlers';

const BRIDGE_MANIFEST_FILE = 'bridge-manifest.json';
const BRIDGE_PROTOCOL_VERSION = 1;

interface BridgeManifest {
  schemaVersion: 1;
  protocolVersion: number;
  kind: 'cwtools-mcp-extension-bridge';
  host: string;
  port: number;
  rpcUrl: string;
  token: string;
  pid: number;
  workspaceRoot: string;
  project?: Pick<WorkspaceProjectDetection, 'kind' | 'gameId' | 'reason' | 'evidence' | 'candidates'>;
  hostAppName?: string;
  extensionId?: string;
  updatedAt?: string;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: {
    code?: number;
    message?: string;
  };
}

interface McpCallToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface McpReadResourceResult {
  [key: string]: unknown;
  contents: Array<{ uri: string; mimeType?: string; text?: string }>;
}

interface McpListToolsResult {
  [key: string]: unknown;
  tools: ReturnType<typeof listRegisteredTools>;
}

interface McpListResourcesResult {
  [key: string]: unknown;
  resources: ReturnType<typeof listResources>;
}

export function fallbackBridgeTools(project: WorkspaceProjectDetection, includeWrites: boolean) {
  if (project.kind === 'unsupported' || project.kind === 'ambiguous') return [];
  return listRegisteredTools({ includeWrites, cwtOnly: project.kind === 'cwt-only' });
}

export function fallbackBridgeResources(project: WorkspaceProjectDetection) {
  if (project.kind === 'unsupported' || project.kind === 'ambiguous') return [];
  const resources = listResources();
  return project.kind === 'cwt-only'
    ? resources.filter(resource => resource.uri === 'cwtools://knowledge/diagnostic-routing')
    : resources;
}

export function localBridgeToolDenied(
  project: WorkspaceProjectDetection,
  name: string,
): SharedToolResult | undefined {
  if (project.kind !== 'unsupported' && project.kind !== 'ambiguous'
    && (project.kind !== 'cwt-only'
      || fallbackBridgeTools(project, true).some(tool => tool.name === name))) return undefined;
  return {
    ok: false,
    status: 'denied',
    source: 'cwtools-mcp-bridge-proxy',
    error: {
      code: project.kind === 'ambiguous'
        ? 'project_ambiguous'
        : project.kind === 'unsupported' ? 'project_not_supported' : 'tool_not_available_in_cwt_only',
      message: project.kind === 'cwt-only'
        ? `Tool '${name}' requires a full Paradox game model and is not available in a CWT-only workspace.`
        : project.reason,
    },
  };
}

export function createBridgeProxyMcpServer(config: CwtoolsMcpConfig): Server {
  const server = new Server(
    {
      name: 'cwtools-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
      instructions: [
        'CWTools MCP is served by the active VS Code-compatible extension host.',
        'This proxy does not start its own CWTools language server. If calls report',
        'bridge_unavailable, open the project in the compatible host where the extension',
        'is installed and active, or rerun with --standalone to use the standalone LSP host.',
      ].join('\n'),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const manifest = await readBridgeManifest(config, server);
      if (!manifest.project) {
        const project = await detectProxyWorkspace(config, server);
        return { tools: fallbackBridgeTools(project, config.enableWrites) };
      }
      return await bridgeRpc<McpListToolsResult>(config, server, 'tools/list', {
        allowDomainWrites: config.enableWrites,
      }, manifest);
    } catch {
      try {
        const project = await detectProxyWorkspace(config, server);
        return { tools: fallbackBridgeTools(project, config.enableWrites) };
      } catch {
        return { tools: [] };
      }
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const manifest = await readBridgeManifest(config, server);
      if (!manifest.project) {
        const project = await detectProxyWorkspace(config, server);
        return { resources: fallbackBridgeResources(project) };
      }
      return await bridgeRpc<McpListResourcesResult>(config, server, 'resources/list', {}, manifest);
    } catch {
      try {
        const project = await detectProxyWorkspace(config, server);
        return { resources: fallbackBridgeResources(project) };
      } catch {
        return { resources: [] };
      }
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    try {
      const manifest = await readBridgeManifest(config, server);
      if (!manifest.project) {
        const project = await detectProxyWorkspace(config, server);
        if (!fallbackBridgeResources(project).some(resource => resource.uri === request.params.uri)) {
          return {
            contents: [{
              uri: request.params.uri,
              mimeType: 'application/json',
              text: `${JSON.stringify({
                status: 'error',
                error: {
                  code: project.kind === 'ambiguous' ? 'project_ambiguous' : project.kind === 'unsupported' ? 'project_not_supported' : 'resource_not_available_in_cwt_only',
                  message: project.reason,
                },
              }, null, 2)}\n`,
            }],
          };
        }
      }
      return await bridgeRpc<McpReadResourceResult>(config, server, 'resources/read', {
        uri: request.params.uri,
      }, manifest);
    } catch (error) {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'application/json',
            text: `${JSON.stringify(unavailableResult(error), null, 2)}\n`,
          },
        ],
      };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const args = request.params.arguments && typeof request.params.arguments === 'object'
        ? request.params.arguments as Record<string, unknown>
        : {};
      const manifest = await readBridgeManifest(config, server);
      if (!manifest.project) {
        const project = await detectProxyWorkspace(config, server);
        const denied = localBridgeToolDenied(project, request.params.name);
        if (denied) return toMcpCallToolResult(denied);
      }
      const result = await bridgeRpc<McpCallToolResult>(config, server, 'tools/call', {
        name: request.params.name,
        arguments: args,
        allowDomainWrites: config.enableWrites,
      }, manifest);
      return normalizeCallToolResult(result);
    } catch (error) {
      try {
        const project = await detectProxyWorkspace(config, server);
        const denied = localBridgeToolDenied(project, request.params.name);
        if (denied) return toMcpCallToolResult(denied);
      } catch {
        // Preserve the original bridge error when local fallback detection fails.
      }
      return toMcpCallToolResult(unavailableResult(error));
    }
  });

  return server;
}

async function bridgeRpc<T>(
  config: CwtoolsMcpConfig,
  server: Server,
  method: string,
  params: Record<string, unknown>,
  knownManifest?: BridgeManifest,
): Promise<T> {
  const manifest = knownManifest ?? await readBridgeManifest(config, server);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(manifest.rpcUrl, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${manifest.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
        method,
        params,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Bridge HTTP ${response.status}: ${await response.text()}`);
    }
    const payload = await response.json() as JsonRpcResponse<T>;
    if (payload.error) {
      throw new Error(payload.error.message ?? `Bridge JSON-RPC error ${payload.error.code ?? ''}`.trim());
    }
    return payload.result as T;
  } finally {
    clearTimeout(timer);
  }
}

async function readBridgeManifest(config: CwtoolsMcpConfig, server: Server): Promise<BridgeManifest> {
  const manifestPath = resolveBridgeManifestPath(config);
  let parsed: BridgeManifest;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BridgeManifest;
  } catch (error) {
    throw new Error(
      `CWTools MCP bridge is unavailable: could not read ${manifestPath}. ` +
      `Open this project in a VS Code-compatible host with the extension active, or pass --standalone to start a separate CWTools server. ` +
      `Details: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed.kind !== 'cwtools-mcp-extension-bridge' || parsed.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error(
      `CWTools MCP bridge manifest at ${manifestPath} is not compatible with this proxy. ` +
      `Open the project in the updated extension host, or pass --standalone to use the standalone LSP host.`,
    );
  }
  if (!parsed.rpcUrl || !parsed.token) {
    throw new Error(`CWTools MCP bridge manifest at ${manifestPath} is missing rpcUrl/token.`);
  }
  const expected = await resolveExpectedWorkspace(config, server);
  assertBridgeWorkspaceMatches(expected.roots, parsed.workspaceRoot, expected.source);
  return parsed;
}

interface ExpectedWorkspace {
  roots: string[];
  source: string;
}

async function resolveExpectedWorkspace(config: CwtoolsMcpConfig, server: Server): Promise<ExpectedWorkspace> {
  if (config.workspaceRootExplicit) {
    return { roots: [config.workspaceRoot], source: '--workspace' };
  }

  const clientRoots = await readClientWorkspaceRoots(server);
  if (clientRoots.length > 0) {
    return { roots: clientRoots, source: 'MCP client roots' };
  }

  const envRoot = process.env.CLAUDE_PROJECT_DIR || process.env.CWTOOLS_MCP_WORKSPACE;
  if (envRoot) {
    return { roots: [envRoot], source: 'environment workspace' };
  }

  return { roots: [config.workspaceRoot], source: 'MCP process cwd' };
}

async function detectProxyWorkspace(config: CwtoolsMcpConfig, server: Server): Promise<WorkspaceProjectDetection> {
  const expected = await resolveExpectedWorkspace(config, server);
  if (expected.roots.length > 1) {
    return {
      kind: 'ambiguous',
      strength: 'none',
      evidence: [],
      candidates: [...expected.roots].sort(),
      reason: `Multiple MCP workspace roots are ambiguous for the CWTools bridge: ${expected.roots.join(', ')}`,
    };
  }
  return detectWorkspaceProject(expected.roots[0] ?? config.workspaceRoot, () => undefined);
}

async function readClientWorkspaceRoots(server: Server): Promise<string[]> {
  if (!server.getClientCapabilities()?.roots) return [];
  try {
    const result = await server.listRoots(undefined, { timeout: 1_000 });
    const roots = result.roots
      .map(root => rootUriToPath(root.uri))
      .filter((root): root is string => !!root);
    return uniquePaths(roots);
  } catch {
    return [];
  }
}

function rootUriToPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return undefined;
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
}

function uniquePaths(roots: string[]): string[] {
  const result: string[] = [];
  for (const root of roots) {
    if (!result.some(existing => samePath(existing, root))) {
      result.push(root);
    }
  }
  return result;
}

export function assertBridgeWorkspaceMatches(
  expectedWorkspaceRoot: string | string[],
  servedWorkspaceRoot: string,
  source = 'MCP process workspace',
): void {
  const expectedRoots = Array.isArray(expectedWorkspaceRoot) ? expectedWorkspaceRoot : [expectedWorkspaceRoot];
  if (expectedRoots.some(expected => samePath(expected, servedWorkspaceRoot))) return;
  const expected = expectedRoots.map(root => path.resolve(root)).join(', ');
  throw new Error(
    `CWTools MCP bridge workspace mismatch. ${source} expects ${expected}, ` +
    `but the active extension bridge serves ${servedWorkspaceRoot}. ` +
    'Open the same project in the compatible host, or make sure the MCP client exposes its current workspace roots/cwd.',
  );
}

function resolveBridgeManifestPath(config: CwtoolsMcpConfig): string {
  if (config.bridgeManifestPath) return config.bridgeManifestPath;
  const envPath = process.env.CWTOOLS_MCP_BRIDGE_MANIFEST;
  if (envPath) return path.resolve(envPath);
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : __filename;
  const scriptSibling = path.join(path.dirname(scriptPath), BRIDGE_MANIFEST_FILE);
  if (fs.existsSync(scriptSibling)) return scriptSibling;
  // Independently installed (npx / npm -g) proxies live nowhere near the
  // extension's globalStorage — fall back to the manifest the active
  // VS Code-compatible host writes there.
  const detected = detectExtensionBridgeManifestPath();
  return detected ?? scriptSibling;
}

function normalizeCallToolResult(result: McpCallToolResult): McpCallToolResult {
  if (
    result
    && Array.isArray(result.content)
    && result.content.every(item => item?.type === 'text' && typeof item.text === 'string')
  ) {
    return result;
  }
  return toMcpCallToolResult({
    ok: false,
    status: 'error',
    source: 'cwtools-mcp-bridge-proxy',
    error: {
      code: 'invalid_bridge_response',
      message: 'The extension MCP bridge returned an invalid tool result.',
    },
  });
}

function unavailableResult(error: unknown): SharedToolResult {
  return {
    ok: false,
    status: 'unavailable',
    source: 'cwtools-mcp-bridge-proxy',
    error: {
      code: 'bridge_unavailable',
      message: error instanceof Error ? error.message : String(error),
    },
    nextSteps: [
      'Open the workspace in a VS Code-compatible host with the CWTools extension installed and active.',
      'Point the MCP client at cwtools-mcp (npx -y cwtools-mcp) or pass --bridge-manifest to the host globalStorage/mcp/bridge-manifest.json.',
      'Use --standalone only if you intentionally want a separate CWTools Server process.',
    ],
  };
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}
