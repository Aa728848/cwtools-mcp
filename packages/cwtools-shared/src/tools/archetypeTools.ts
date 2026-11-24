import * as path from 'path';
import { fileURLToPath } from 'url';
import type { HostServices } from '../host/hostServices';
import type { SharedToolResult } from './schema';
import { HostArchetypeArtifactStore, type HostArchetypeExtractArgs } from './archetypeArtifacts';
import type { ArchetypePlaceholders, ArchetypeSlotValue } from './archetypeSlots';
import { getPdxBlockWithHost } from './pdxBlock';
import { queryDefinitionByNameWithHost } from './symbols';

const stores = new WeakMap<HostServices, HostArchetypeArtifactStore>();

function storeFor(host: HostServices): HostArchetypeArtifactStore {
  const existing = stores.get(host);
  if (existing) return existing;
  const created = new HostArchetypeArtifactStore(host.workspaceRoot, host.now);
  stores.set(host, created);
  return created;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function canonicalKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function responseMatches(value: unknown, identity: string, canonicalPath: string, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.slice(0, 200).some(item => responseMatches(item, identity, canonicalPath, depth + 1));
  const record = asRecord(value);
  const identityMatches = ['name', 'symbolName', 'identity', 'key', 'id']
    .some(key => typeof record[key] === 'string' && String(record[key]).toLowerCase() === identity.toLowerCase());
  const pathMatches = Object.values(record).slice(0, 200).some(item => {
    if (typeof item !== 'string') return false;
    try {
      const file = item.startsWith('file:') ? fileURLToPath(item) : item;
      return path.isAbsolute(file) && canonicalKey(file) === canonicalKey(canonicalPath);
    } catch { return false; }
  });
  if (identityMatches && pathMatches) return true;
  return Object.values(record).slice(0, 200).some(item => responseMatches(item, identity, canonicalPath, depth + 1));
}

async function verifiedContent(host: HostServices, identity: string, canonicalPath: string): Promise<string | undefined> {
  const definition = await queryDefinitionByNameWithHost(host, { symbolName: identity });
  if (!definition.ok || !responseMatches(definition.data, identity, canonicalPath)) return undefined;
  const block = await getPdxBlockWithHost(host, { file: canonicalPath, symbol: identity });
  return block.ok && block.data && !block.data.truncated ? block.data.content : undefined;
}

export async function extractArchetypeWithHost(host: HostServices, args: Record<string, unknown>): Promise<SharedToolResult> {
  try {
    const input: HostArchetypeExtractArgs = {
      filePath: typeof args.filePath === 'string' ? args.filePath : '',
      definitionIdentity: typeof args.definitionIdentity === 'string' ? args.definitionIdentity : '',
      definitionPath: typeof args.definitionPath === 'string' ? args.definitionPath : '',
      placeholders: (args.placeholders ?? {}) as ArchetypePlaceholders,
      scopeId: host.workspaceRoot,
    };
    const artifact = await storeFor(host).extract(input, async (identity, canonicalPath) => {
      const content = await verifiedContent(host, identity, canonicalPath);
      return content === undefined ? undefined : { content };
    });
    return { ok: true, status: 'ready', source: 'cwtools-archetypes', data: { success: true, artifact } };
  } catch (error) {
    return { ok: false, status: 'error', source: 'cwtools-archetypes', error: { code: 'archetype_extract_failed', message: error instanceof Error ? error.message : String(error) } };
  }
}

export async function instantiateArchetypeWithHost(host: HostServices, args: Record<string, unknown>): Promise<SharedToolResult> {
  try {
    const artifactId = typeof args.artifactId === 'string' ? args.artifactId : '';
    const values = (args.values ?? {}) as Readonly<Record<string, ArchetypeSlotValue>>;
    const content = await storeFor(host).instantiate(artifactId, values, host.workspaceRoot);
    return { ok: true, status: 'ready', source: 'cwtools-archetypes', data: { success: true, content } };
  } catch (error) {
    return { ok: false, status: 'error', source: 'cwtools-archetypes', error: { code: 'archetype_instantiate_failed', message: error instanceof Error ? error.message : String(error) } };
  }
}
