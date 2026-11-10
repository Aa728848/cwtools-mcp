import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseCliArgs } from '../config';
import { createNodeHostServices } from '../hosts/nodeHostServices';
import { listServerTools } from '../server';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-runtime-detect-'));
}

describe('standalone project runtime contract', () => {
  it('keeps unsupported projects on the unavailable host without spawning LSP', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'common'));
    const host = createNodeHostServices(parseCliArgs(['--standalone', '--workspace', root]));
    try {
      expect(host.projectSupported).to.equal(false);
      expect(host.projectKind).to.equal('unsupported');
      expect(listServerTools(host)).to.deep.equal([]);
      const result = await host.lsp.executeCommand<{ status: string }>('cwtools.ai.getValidationStatus');
      expect(result.status).to.equal('unavailable');
    } finally {
      host.dispose?.();
    }
  });

  it('uses generic Paradox mode instead of implicit Stellaris when the game is unknown', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'descriptor.mod'), 'name="Unknown game mod"');
    const host = createNodeHostServices(parseCliArgs(['--standalone', '--workspace', root]));
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
    const host = createNodeHostServices(parseCliArgs(['--standalone', '--workspace', root, '--game', 'stellaris']));
    try {
      expect(host.projectKind).to.equal('cwt-only');
      expect(host.projectGameId).to.equal('cwt');
      expect(listServerTools(host).map(tool => tool.name)).to.have.length(7);
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
    const host = createNodeHostServices(parseCliArgs(['--standalone', '--workspace', root]));
    try {
      expect(host.workspaceRoot).to.equal(mod);
    } finally {
      host.dispose?.();
    }
  });
});
