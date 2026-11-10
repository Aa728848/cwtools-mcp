import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createNodeHostServices } from '../hosts/nodeHostServices';
import { REQUIRED_BACKEND_COMMANDS } from 'cwtools-shared';

const FIXTURE = path.join(__dirname, 'fixtures', 'fakeBackend.cjs');

describe('diagnostics pending contract', () => {
  it('treats null whole-workspace and per-file responses as pending instead of errors', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-diagnostics-pending-'));
    fs.writeFileSync(path.join(root, 'descriptor.mod'), 'name="pending"\n');
    fs.mkdirSync(path.join(root, 'common'));
    fs.writeFileSync(path.join(root, 'common', 'test.txt'), 'test = { }\n');
    const host = createNodeHostServices({
      workspaceRoot: root,
      game: 'stellaris',
      serverPath: process.execPath,
      serverArgs: [FIXTURE, 'ok', path.join(root, 'backend.log'), JSON.stringify(REQUIRED_BACKEND_COMMANDS)],
      enableWrites: false,
      allowedTools: [],
      forceStart: false,
      startupTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
    });
    try {
      const whole = await host.diagnostics.getDiagnostics({ limit: 1 });
      expect(whole.ok).to.equal(true);
      expect(whole.status).to.equal('pending');
      expect(whole.diagnostics).to.deep.equal([]);
      expect(whole.freshness?.pendingKinds).to.include('game_model');
      expect(whole.error).to.equal(undefined);

      const single = await host.diagnostics.getDiagnostics({ file: 'common/test.txt', limit: 1 });
      expect(single.ok).to.equal(true);
      expect(single.status).to.equal('pending');
      expect(single.diagnostics).to.deep.equal([]);
      expect(single.error).to.equal(undefined);
    } finally {
      host.dispose?.();
    }
  });
});
