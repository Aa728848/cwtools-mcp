import { expect } from 'chai';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  createNativeBridgeLspHost,
  createNodeHostServices,
  discoverNativeBridge,
} from '../index';
import { REQUIRED_BACKEND_COMMANDS } from 'cwtools-shared';

interface Fixture {
  url: string;
  manifestPath: string;
  close(): Promise<void>;
}

async function createFixture(options: { active?: boolean; incomplete?: boolean; healthDelayMs?: number } = {}): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-native-contract-'));
  fs.writeFileSync(path.join(root, 'descriptor.mod'), 'name="native"\n');
  const token = 'secret';
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (request.url === '/cwtools/healthz') {
      const respond = () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, protocolVersion: 1, active: options.active !== false, workspaceRoot: root, readyAtMs: 123 }));
      };
      if (options.healthDelayMs) setTimeout(respond, options.healthDelayMs);
      else respond();
      return;
    }
    if (request.url === '/cwtools/rpc' && request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const rpc = JSON.parse(body) as { method: string; params: { command?: string; method?: string } };
        const command = rpc.params.command ?? rpc.params.method;
        response.writeHead(200, { 'content-type': 'application/json' });
        if (command === 'cwtools.ai.getHostCapabilities') {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
            protocolVersion: 1,
            serverVersion: '2.35.0',
            commands: options.incomplete ? ['cwtools.ai.queryTypes'] : REQUIRED_BACKEND_COMMANDS,
          } }));
        } else {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true, command } }));
        }
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  const url = `http://127.0.0.1:${address.port}`;
  const manifestPath = path.join(root, 'bridge-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    cwtoolsNativeRpcUrl: url + '/cwtools/rpc',
    cwtoolsNativeHealthUrl: url + '/cwtools/healthz',
    token,
    pid: process.pid,
    workspaceRoot: root,
  }));
  return {
    url,
    manifestPath,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

describe('native active bridge contract', () => {
  it('discovers and calls an active host without spawning a process', async () => {
    const fixture = await createFixture();
    try {
      const root = path.dirname(fixture.manifestPath);
      const discovered = await discoverNativeBridge(root, { manifestPath: fixture.manifestPath });
      expect(discovered.kind).to.equal('available');
      if (discovered.kind !== 'available') return;
      const lspHost = createNativeBridgeLspHost(discovered.manifest, discovered.readyAtMs);
      const host = createNodeHostServices({
        workspaceRoot: root,
        game: 'stellaris',
        serverPath: path.join(root, 'missing-server.exe'),
        lspHost,
        readyAtMs: discovered.readyAtMs,
        enableWrites: false,
        allowedTools: [],
        forceStart: false,
      });
      expect(host.lsp).to.equal(lspHost);
      const result = await host.lsp.executeCommand<{ ok: boolean; command: string }>('cwtools.ai.queryTypes', ['ship_size']);
      expect(result.ok).to.equal(true);
      expect(result.command).to.equal('cwtools.ai.queryTypes');
      const navigation = await host.lsp.request<{ ok: boolean; method: string }>('textDocument/definition', { textDocument: { uri: 'file:///mod/a.txt' } });
      expect(navigation.ok).to.equal(true);
      expect(navigation.command).to.equal('textDocument/definition');
      host.dispose?.();
    } finally {
      await fixture.close();
    }
  });

  it('returns unavailable for workspace mismatch and backend_incompatible for an incomplete active host', async () => {
    const fixture = await createFixture({ incomplete: true });
    try {
      const root = path.dirname(fixture.manifestPath);
      const mismatch = await discoverNativeBridge(path.join(root, 'other'), { manifestPath: fixture.manifestPath });
      expect(mismatch.kind).to.equal('unavailable');
      const discovered = await discoverNativeBridge(root, { manifestPath: fixture.manifestPath });
      expect(discovered.kind).to.equal('available');
      if (discovered.kind !== 'available') return;
      const host = createNativeBridgeLspHost(discovered.manifest);
      const result = await host.executeCommand<{ ok: boolean; error?: { code: string } }>('cwtools.ai.queryTypes');
      expect(result.ok).to.equal(false);
      expect(result.error?.code).to.equal('backend_incompatible');
    } finally {
      await fixture.close();
    }
  });

  it('validates manifests, treats health timeouts as unavailable, and preserves aborts', async () => {
    const fixture = await createFixture({ healthDelayMs: 50 });
    try {
      const root = path.dirname(fixture.manifestPath);
      const original = fs.readFileSync(fixture.manifestPath, 'utf8');
      const malformed = JSON.parse(original) as Record<string, unknown>;
      delete malformed.workspaceRoot;
      fs.writeFileSync(fixture.manifestPath, JSON.stringify(malformed));
      expect((await discoverNativeBridge(root, { manifestPath: fixture.manifestPath })).kind).to.equal('unavailable');

      fs.writeFileSync(fixture.manifestPath, original);
      expect((await discoverNativeBridge(root, { manifestPath: fixture.manifestPath, timeoutMs: 1 })).kind).to.equal('unavailable');

      const controller = new AbortController();
      controller.abort(new Error('stop discovery'));
      let aborted: unknown;
      try {
        await discoverNativeBridge(root, { manifestPath: fixture.manifestPath, signal: controller.signal });
      } catch (error) {
        aborted = error;
      }
      expect(aborted).to.be.instanceOf(Error);
      expect((aborted as Error).name).to.equal('AbortError');
    } finally {
      await fixture.close();
    }
  });

  it('classifies inactive and missing manifests as unavailable', async () => {
    const inactive = await createFixture({ active: false });
    try {
      const result = await discoverNativeBridge(path.dirname(inactive.manifestPath), { manifestPath: inactive.manifestPath });
      expect(result.kind).to.equal('unavailable');
    } finally {
      await inactive.close();
    }
    const missing = await discoverNativeBridge('C:/definitely-missing', { manifestPath: 'C:/definitely-missing/manifest.json' });
    expect(missing.kind).to.equal('unavailable');
  });
});
