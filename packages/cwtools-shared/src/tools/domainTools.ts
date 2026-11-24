import type { HostServices } from '../host/hostServices';
import { queryInterfaceKnowledge } from '../knowledge/interfaceKnowledge';
import { searchRuleCapabilitiesWithHost, type SearchRuleCapabilitiesResult } from '../knowledge/rules';
import type { SharedToolResult } from './schema';
import { solveScopeBridge, type ScopeBridgeCandidate } from './scopeBridge';
import { queryDefinitionByNameWithHost, workspaceSymbolsWithHost } from './symbols';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function result(data: unknown, source = 'cwtools-domain'): SharedToolResult {
  return { ok: true, status: 'ready', source, data };
}

export async function queryInterfaceKnowledgeWithHost(_host: HostServices, args: Record<string, unknown>): Promise<SharedToolResult> {
  return result(queryInterfaceKnowledge(args), 'cwtools-interface-knowledge');
}

export async function findScopeBridgeWithHost(host: HostServices, args: Record<string, unknown>): Promise<SharedToolResult> {
  const fromScope = typeof args.fromScope === 'string' ? args.fromScope.trim() : '';
  const toScope = typeof args.toScope === 'string' ? args.toScope.trim() : '';
  const intent = typeof args.context === 'string' ? args.context : '';
  if (!fromScope || !toScope) {
    return { ok: false, status: 'error', source: 'cwtools-scope-bridge', error: { code: 'invalid_arguments', message: 'fromScope and toScope are required.' } };
  }
  const [outgoing, incoming, intermediate] = await Promise.all([
    searchRuleCapabilitiesWithHost(host, { intent, category: 'scope_change', currentScope: fromScope, limit: 50 }),
    searchRuleCapabilitiesWithHost(host, { intent: intent + ' scope transition bridge', category: 'scope_change', desiredPushScope: toScope, limit: 50 }),
    searchRuleCapabilitiesWithHost(host, { intent: intent + ' intermediate scope transitions', category: 'scope_change', limit: 50 }),
  ]);
  const evidence = [outgoing, intermediate, incoming].map(item => item.data).filter((item): item is SearchRuleCapabilitiesResult => !!item);
  const candidates: ScopeBridgeCandidate[] = evidence.flatMap(pack => pack.candidates.flatMap(candidate => {
    const file = candidate.rule.sourceFile ?? candidate.rule.hardFacts?.cwtSource?.file;
    const line = candidate.rule.sourceLine ?? candidate.rule.hardFacts?.cwtSource?.line;
    if (!file || line === undefined) return [];
    return [{
      name: candidate.rule.name,
      supportedScopes: candidate.rule.hardFacts?.supportedScopes ?? candidate.rule.scopes,
      pushScope: candidate.rule.hardFacts?.pushScope,
      evidence: [pack.source + ':' + file + ':' + line, ...(pack.rulesContentHash ? ['rules-sha256:' + pack.rulesContentHash] : [])],
    }];
  })).slice(0, 200);
  return result({
    ...solveScopeBridge({ fromScope, toScope, candidates }),
    evidenceSource: 'cwtools-node-rules',
    rulesContentHash: evidence.find(pack => pack.rulesContentHash)?.rulesContentHash,
  }, 'cwtools-scope-bridge');
}

interface AssetCandidate {
  name: string;
  source: 'mod' | 'vanilla';
  file: string;
  line: number;
  score: number;
  matchedBy: string[];
  container?: string;
  reference?: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export async function findAssetCandidatesWithHost(
  host: HostServices,
  rawArgs: Record<string, unknown>,
  kind: 'sprite' | 'sound',
): Promise<SharedToolResult> {
  if (!host.indexing) {
    return { ok: false, status: 'unavailable', source: 'cwtools-assets', error: { code: 'index_unavailable', message: 'The active host has no workspace/vanilla asset index.' } };
  }
  const args = rawArgs as { query?: unknown; currentValue?: unknown; fieldName?: unknown; searchContext?: unknown; limit?: unknown };
  const limit = Math.max(1, Math.min(typeof args.limit === 'number' ? Math.floor(args.limit) : 20, 50));
  const searchContext = args.searchContext === 'mod' || args.searchContext === 'vanilla' ? args.searchContext : 'both';
  const current = typeof args.currentValue === 'string' ? args.currentValue.trim().replace(/^"|"$/g, '') : '';
  const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';
  const field = typeof args.fieldName === 'string' ? args.fieldName.toLowerCase() : '';
  const stop = new Set(kind === 'sprite' ? ['gfx', 'sprite', 'type', 'picture', 'icon', 'image'] : ['sound', 'show', 'music', 'asset', 'event', 'audio', 'snd']);
  const terms = unique((rawQuery + ' ' + current + ' ' + field).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
    .filter(term => term.length >= 3 && !stop.has(term)));
  const query = rawQuery || current || terms.join(' ');
  await host.indexing.ensureReady?.();
  const origins = searchContext === 'both' ? ['workspace', 'vanilla'] as const : [searchContext === 'mod' ? 'workspace' : 'vanilla'] as const;
  const packs = await Promise.all(origins.map(origin => host.indexing!.queryWorkspace({
    name: current || terms[0] || rawQuery || undefined,
    kind,
    source: 'asset',
    origin,
    includeReferences: true,
    limit: limit * 5,
  })));
  const candidates = new Map<string, AssetCandidate>();
  for (const pack of packs) {
    for (const entry of pack.entries) {
      const source = entry.origin === 'vanilla' ? 'vanilla' : 'mod';
      const reference = entry.references?.map(item => item.context).find(value => kind === 'sprite' ? /texturefile/i.test(value) : /\bfiles?\s*=/i.test(value));
      let score = source === 'mod' ? 55 : 35;
      const matchedBy = ['workspace-index'];
      const lowerName = entry.name.toLowerCase();
      const lowerCurrent = current.toLowerCase().replace(/^gfx_/, '');
      if (lowerCurrent && lowerName === current.toLowerCase()) { score += 120; matchedBy.push('exact-current-value'); }
      else if (lowerCurrent && lowerName.includes(lowerCurrent)) { score += 40; matchedBy.push('current-value-fragment'); }
      for (const term of terms) {
        if (lowerName.includes(term)) { score += 18; matchedBy.push('name:' + term); }
        else if (reference?.toLowerCase().includes(term)) { score += 8; matchedBy.push('reference:' + term); }
      }
      if (kind === 'sound' && /show_sound|sound/.test(field) && /\.wav\b|sfx|event|ui|interface/i.test(reference ?? '')) score += 15;
      if (terms.length > 0 && matchedBy.length === 1 && lowerName !== current.toLowerCase()) continue;
      const key = source + '|' + lowerName;
      const candidate: AssetCandidate = {
        name: entry.name, source, file: entry.file, line: entry.line, score,
        matchedBy: unique(matchedBy), container: entry.container, reference,
      };
      const existing = candidates.get(key);
      if (!existing || candidate.score > existing.score) candidates.set(key, candidate);
    }
  }
  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  const status = packs.some(pack => pack.status === 'error' || pack.status === 'unavailable') ? 'partial' : 'ready';
  return {
    ok: true,
    status,
    source: 'cwtools-index',
    data: {
      query,
      candidates: sorted,
      searchedRoots: packs.map(pack => pack.status === 'ready' ? 'IndexService:' + kind : 'IndexService:' + pack.status),
      _warning: sorted.length === 0 ? 'No verified ' + kind + ' candidates found; broaden the query and searchContext before inventing an asset name.' : undefined,
    },
    warnings: sorted.length === 0 ? ['Do not guess a replacement asset identifier from a file name alone.'] : undefined,
  };
}

export async function getIgnoredDiagnosticsWithHost(host: HostServices): Promise<SharedToolResult> {
  if (!host.diagnosticSettings) {
    return { ok: false, status: 'unavailable', source: 'cwtools-diagnostics', error: { code: 'settings_unavailable', message: 'The active host does not expose diagnostic ignore settings.' } };
  }
  const ignoredKeys = (await host.diagnosticSettings.getIgnoredKeys()).map(key => key.trim()).filter(Boolean).sort();
  const diagnostics = await host.diagnostics.getDiagnostics({ limit: 1000 }).catch(() => undefined);
  const all = diagnostics?.diagnostics ?? [];
  const audit = ignoredKeys.map(key => {
    const lower = key.toLowerCase();
    const hits = all.filter(item => (item.code ?? '').toLowerCase() === lower || item.message.toLowerCase().includes(lower) || (item.source ?? '').toLowerCase().includes(lower));
    return { key, stillHits: hits.length > 0, matchCount: hits.length, category: hits.length > 0 ? 'matched' : 'unmatched' };
  });
  return result({ success: true, count: ignoredKeys.length, ignoredKeys, audit }, 'cwtools-diagnostics');
}

export async function removeIgnoredDiagnosticWithHost(host: HostServices, args: Record<string, unknown>): Promise<SharedToolResult> {
  const key = typeof args.diagnosticKey === 'string' ? args.diagnosticKey.trim() : '';
  if (!key) return { ok: false, status: 'error', source: 'cwtools-diagnostics', error: { code: 'invalid_arguments', message: 'diagnosticKey is required.' } };
  if (!host.diagnosticSettings) return { ok: false, status: 'unavailable', source: 'cwtools-diagnostics', error: { code: 'settings_unavailable', message: 'The active host does not expose diagnostic ignore settings.' } };
  await host.diagnosticSettings.removeIgnoredKey(key);
  return result({ success: true, diagnosticKey: key, message: 'Diagnostic key removed from the workspace ignore list.' }, 'cwtools-diagnostics');
}

function collectMatches(value: unknown, identifier: string, matches: Array<Record<string, unknown>>, depth = 0): void {
  if (matches.length >= 100 || depth > 6) return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 200)) collectMatches(item, identifier, matches, depth + 1); return; }
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return;
  const name = ['name', 'id', 'symbolName', 'key'].map(key => record[key]).find(item => typeof item === 'string');
  if (typeof name === 'string' && name.toLowerCase() === identifier.toLowerCase()) matches.push(record);
  for (const item of Object.values(record).slice(0, 100)) {
    if (typeof item === 'object' && item !== null) collectMatches(item, identifier, matches, depth + 1);
  }
}

export async function verifyPdxIdentifierWithHost(host: HostServices, args: Record<string, unknown>): Promise<SharedToolResult> {
  const identifier = typeof args.identifier === 'string' ? args.identifier.trim() : '';
  if (!identifier) return { ok: false, status: 'error', source: 'cwtools-verify-id', error: { code: 'invalid_arguments', message: 'identifier is required.' } };
  const limit = Math.max(1, Math.min(typeof args.limit === 'number' ? Math.floor(args.limit) : 20, 50));
  const typeName = typeof args.typeName === 'string' ? args.typeName.trim() : '';
  const [definition, symbols] = await Promise.all([
    queryDefinitionByNameWithHost(host, { symbolName: identifier }).catch(error => ({ ok: false, error })),
    workspaceSymbolsWithHost(host, { query: identifier, limit }).catch(error => ({ ok: false, error })),
  ]);
  const matches: Array<Record<string, unknown>> = [];
  const definitionData = 'data' in definition ? definition.data : undefined;
  const symbolsData = 'data' in symbols ? symbols.data : undefined;
  collectMatches(definitionData, identifier, matches);
  collectMatches(symbolsData, identifier, matches);
  const evidence = [
    { source: 'go_to_definition', status: definition.ok ? 'found' : 'not_found', summary: definition.ok ? 'Definition lookup returned an exact match.' : 'No authoritative definition match.' },
    { source: 'workspace_symbols', status: symbols.ok && collectSymbolMatch(symbolsData, identifier) ? 'found' : 'not_found', summary: 'Workspace symbol lookup completed.' },
  ];
  if (typeName) {
    const typed = await host.lsp.executeCommand('cwtools.ai.queryTypes', [typeName, identifier, limit, args.includeVanilla !== false]);
    collectMatches(typed, identifier, matches);
    evidence.push({ source: 'query_types', status: matches.length > 0 ? 'found' : 'not_found', summary: 'Queried exact ' + typeName + ' instances.' });
  }
  if (host.indexing) {
    const indexed = await host.indexing.queryWorkspace({ name: identifier, exact: true, origin: args.includeVanilla === false ? 'workspace' : 'both', limit });
    matches.push(...indexed.entries.map(entry => ({ ...entry })));
    evidence.push({ source: 'workspace_index', status: indexed.entries.length > 0 ? 'found' : 'not_found', summary: 'Exact indexed identifier lookup completed.' });
  }
  const found = matches.length > 0 || evidence.some(item => item.status === 'found');
  return result({
    identifier,
    status: found ? 'found' : 'not_found',
    confidence: definition.ok || typeName ? 'high' : 'medium',
    canTreatAsMissing: !found,
    evidence,
    matches: matches.slice(0, limit),
    nextSteps: found ? [] : ['Only treat this as missing for the current project, selected type, and loaded vanilla context.'],
  }, 'cwtools-verify-id');
}

function collectSymbolMatch(data: unknown, identifier: string): boolean {
  const matches: Array<Record<string, unknown>> = [];
  collectMatches(data, identifier, matches);
  return matches.length > 0;
}
