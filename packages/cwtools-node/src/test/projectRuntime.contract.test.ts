import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createNodeHostServices, type CwtoolsNodeHostOptions } from '../hosts/nodeHostServices';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-runtime-detect-'));
}

function options(workspaceRoot: string, overrides: Partial<CwtoolsNodeHostOptions> = {}): CwtoolsNodeHostOptions {
  return {
    workspaceRoot,
    enableWrites: true,
    allowedTools: [],
    forceStart: false,
    ...overrides,
  };
}

describe('node host runtime contract', () => {
  it('keeps unsupported projects on the unavailable host without spawning LSP', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'common'));
    const host = createNodeHostServices(options(root));
    try {
      expect(host.projectSupported).to.equal(false);
      expect(host.projectKind).to.equal('unsupported');
      const result = await host.lsp.executeCommand<{ status: string }>('cwtools.ai.getValidationStatus');
      expect(result.status).to.equal('unavailable');
    } finally {
      host.dispose?.();
    }
  });

  it('uses generic Paradox mode instead of implicit Stellaris when the game is unknown', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'descriptor.mod'), 'name="Unknown game mod"');
    const host = createNodeHostServices(options(root));
    try {
      expect(host.projectSupported).to.equal(true);
      expect(host.projectKind).to.equal('mod');
      expect(host.projectGameId).to.equal('paradox');
      expect(host.readonlyMode).to.equal(false);
      expect(host.writesEnabled).to.equal(true);
      expect(host.rules?.gameId).to.equal('paradox');
      expect(host.rules?.configDirs).to.deep.equal([]);
      expect(host.vanillaCache?.cacheFile).to.equal(undefined);
    } finally {
      host.dispose?.();
    }
  });

  it('uses the CWT language and no vanilla cache for a rules workspace', () => {
    const root = tempRoot();
    for (let index = 0; index < 6; index++) {
      const file = path.join(root, 'config', `rule${index}.cwt`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '### rule');
    }
    const host = createNodeHostServices(options(root, { game: 'stellaris' }));
    try {
      expect(host.projectKind).to.equal('cwt-only');
      expect(host.projectGameId).to.equal('cwt');
      expect(host.vanillaCache).to.equal(undefined);
    } finally {
      host.dispose?.();
    }
  });

  it('uses the unique matched child as the effective workspace root', () => {
    const root = tempRoot();
    const mod = path.join(root, 'only-mod');
    fs.mkdirSync(mod);
    fs.writeFileSync(path.join(mod, 'descriptor.mod'), '');
    const host = createNodeHostServices(options(root));
    try {
      expect(host.workspaceRoot).to.equal(mod);
    } finally {
      host.dispose?.();
    }
  });

  it('force-start keeps an unsupported workspace enabled without inventing a game id', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'common'));
    const host = createNodeHostServices(options(root, { forceStart: true }));
    try {
      expect(host.projectSupported).to.equal(true);
      expect(host.projectKind).to.equal('mod');
      expect(host.projectGameId).to.equal('paradox');
    } finally {
      host.dispose?.();
    }
  });

  it('accepts only the transport-agnostic option set (no stdio/http fields)', () => {
    const optionsRecord: CwtoolsNodeHostOptions = options(process.cwd());
    for (const forbidden of ['stdio', 'http', 'host', 'port', 'standalone', 'bridgeManifestPath', 'workspaceRootExplicit']) {
      expect(Object.keys(optionsRecord)).to.not.include(forbidden);
    }
  });
});
