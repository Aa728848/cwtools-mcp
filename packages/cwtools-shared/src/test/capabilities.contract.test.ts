import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  BACKEND_INCOMPATIBLE_CODE,
  checkRequiredCommands,
  HOST_CAPABILITIES_PROTOCOL_VERSION,
  parseHostCapabilities,
  REQUIRED_BACKEND_COMMANDS,
} from '../host/capabilities';

// The required-command set is a contract with the backend: a command the client
// calls but does not require would only surface as a silently empty tool result,
// so the list is derived from the real call sites and pinned here.

// Both packages that talk to the backend: cwtools-shared drives the tool surface,
// cwtools-node drives diagnostics and revalidation.
const PACKAGES_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_ROOTS = [
  path.join(PACKAGES_ROOT, 'cwtools-shared', 'src'),
  path.join(PACKAGES_ROOT, 'cwtools-node', 'src'),
];

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'generated') continue;
      walk(full, visit);
    } else if (entry.name.endsWith('.ts')) {
      visit(full);
    }
  }
}

function commandCallSites(): Set<string> {
  const found = new Set<string>();
  for (const root of SRC_ROOTS) {
    if (!fs.existsSync(root)) continue;
    walk(root, file => {
      if (file.endsWith(path.join('host', 'capabilities.ts'))) return;
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/['\"]cwtools\.ai\.[A-Za-z.]+['\"]/g)) {
        found.add(match[0].slice(1, -1));
      }
    });
  }
  // The handshake is internal, never a model-facing command.
  found.delete('cwtools.ai.getHostCapabilities');
  return found;
}

describe('required backend command contract', () => {
  it('requires exactly the commands the shared package actually calls', () => {
    const called = commandCallSites();
    const required = new Set(REQUIRED_BACKEND_COMMANDS);
    expect([...called].filter(c => !required.has(c))).to.deep.equal([]);
    expect([...required].filter(c => !called.has(c))).to.deep.equal([]);
  });

  it('covers every tool group the surface exposes', () => {
    const required = new Set(REQUIRED_BACKEND_COMMANDS);
    const groups: Record<string, string[]> = {
      diagnostics: ['cwtools.ai.getValidationStatus', 'cwtools.ai.getDiagnosticsFresh', 'cwtools.ai.getAllDiagnostics'],
      revalidation: ['cwtools.ai.revalidateFiles'],
      navigation: ['cwtools.ai.getCompletionContext', 'cwtools.ai.getScopeAtPosition', 'cwtools.ai.queryDefinition', 'cwtools.ai.queryDefinitionByName'],
      semantic: ['cwtools.ai.queryTypes', 'cwtools.ai.getEntityInfo'],
      graph: ['cwtools.ai.exploreProject', 'cwtools.ai.exploreInlineGraph', 'cwtools.ai.analyzePdxFlow'],
      localisation: ['cwtools.ai.queryLocalisationAudit'],
      scripted: ['cwtools.ai.queryScriptedEffects', 'cwtools.ai.queryScriptedTriggers', 'cwtools.ai.queryEnums', 'cwtools.ai.queryStaticModifiers', 'cwtools.ai.queryVariables'],
      shader: [
        'cwtools.ai.shader.symbols',
        'cwtools.ai.shader.compileUnit',
        'cwtools.ai.shader.variants',
        'cwtools.ai.shader.callers',
        'cwtools.ai.shader.reachability',
        'cwtools.ai.shader.validate',
        'cwtools.ai.shader.compareVanilla',
      ],
    };
    for (const [group, commands] of Object.entries(groups)) {
      for (const command of commands) {
        expect(required.has(command), `${group}: ${command}`).to.equal(true);
      }
    }
  });

  it('keeps the internal handshake out of the required tool commands', () => {
    expect(REQUIRED_BACKEND_COMMANDS).to.not.include('cwtools.ai.getHostCapabilities');
  });

  it('rejects a backend that is missing any single required command', () => {
    for (const missing of REQUIRED_BACKEND_COMMANDS) {
      const commands = REQUIRED_BACKEND_COMMANDS.filter(command => command !== missing);
      const parsed = parseHostCapabilities({
        protocolVersion: HOST_CAPABILITIES_PROTOCOL_VERSION,
        serverVersion: '2.35.0',
        commands,
      });
      expect(parsed.ok, missing).to.equal(true);
      if (!parsed.ok) continue;
      const checked = checkRequiredCommands(parsed.capabilities);
      expect(checked.ok, missing).to.equal(false);
      if (!checked.ok) {
        expect(checked.reason).to.equal('incomplete');
        expect(checked.message).to.include(missing);
      }
    }
  });

  it('accepts a backend that reports every required command', () => {
    const parsed = parseHostCapabilities({
      protocolVersion: HOST_CAPABILITIES_PROTOCOL_VERSION,
      serverVersion: '2.35.0',
      commands: [...REQUIRED_BACKEND_COMMANDS],
    });
    expect(parsed.ok).to.equal(true);
    if (!parsed.ok) return;
    const checked = checkRequiredCommands(parsed.capabilities);
    expect(checked.ok).to.equal(true);
  });

  it('lists each required command once', () => {
    expect(new Set(REQUIRED_BACKEND_COMMANDS).size).to.equal(REQUIRED_BACKEND_COMMANDS.length);
  });

  it('exposes a stable incompatible-backend code', () => {
    expect(BACKEND_INCOMPATIBLE_CODE).to.equal('backend_incompatible');
  });
});
