import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLspProcessHost, type LspProcessHostOptions } from '../hosts/lspProcessHost';
import { isAbortError, REQUIRED_BACKEND_COMMANDS } from 'cwtools-shared';

// Contracts a Promise.race alone cannot provide: an abort must reach the backend
// as a real JSON-RPC $/cancelRequest, the capability handshake must run before any
// model-loading notification, and an aborted or stale startup must leave no live
// child and no file watcher behind.

const FIXTURE = path.join(__dirname, 'fixtures', 'fakeBackend.cjs');

interface Backend {
  options: LspProcessHostOptions;
  read(): string;
}

function backend(mode: string, root: string, commands: readonly string[] = REQUIRED_BACKEND_COMMANDS): Backend {
  const logFile = path.join(root, 'backend-' + mode + '.log');
  return {
    options: {
      workspaceRoot: root,
      serverPath: process.execPath,
      serverArgs: [FIXTURE, mode, logFile, JSON.stringify(commands)],
      startupTimeoutMs: 15_000,
    },
    read: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''),
  };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await delay(25);
  }
  return check();
}

describe('LSP host cancellation reaches the backend', () => {
  it('sends a JSON-RPC cancellation instead of only abandoning the promise', async () => {
    const root = tempDir('cwt-cancel-');
    const { options, read } = backend('ok', root);
    const host = createLspProcessHost(options);
    try {
      await host.executeCommand('cwtools.ai.getValidationStatus');
      const controller = new AbortController();
      const pending = host.executeCommand('slow.command', [], { signal: controller.signal, timeoutMs: 10_000 });
      // Wait until the backend has actually received the request: aborting before
      // that would only cancel startup, which is a different contract.
      expect(await waitFor(() => read().includes('REQUEST slow.command')), read()).to.equal(true);
      controller.abort();
      let raised: unknown;
      try {
        await pending;
      } catch (error) {
        raised = error;
      }
      expect(isAbortError(raised), 'abort must surface as an AbortError').to.equal(true);
      // The decisive assertion: the backend itself must observe the cancellation.
      const cancelled = await waitFor(() => read().includes('CANCELLED slow.command'));
      expect(cancelled, 'no cancellation reached the backend: ' + read()).to.equal(true);
      expect(read()).to.include('CANCELLED slow.command');
    } finally {
      host.dispose();
    }
  });

  it('cancels backend work on timeout as well, not just on abort', async () => {
    const root = tempDir('cwt-timeout-');
    const { options, read } = backend('ok', root);
    const host = createLspProcessHost(options);
    try {
      await host.executeCommand('cwtools.ai.getValidationStatus');
      const result = await host.executeCommand<{ status?: string }>('slow.command', [], { timeoutMs: 150 });
      expect(result.status).to.equal('unavailable');
      const cancelled = await waitFor(() => read().includes('CANCELLED slow.command'));
      expect(cancelled, 'a timed-out request must still cancel the backend work: ' + read()).to.equal(true);
    } finally {
      host.dispose();
    }
  });
});

describe('LSP host handshake ordering', () => {
  it('runs the handshake before any model-loading notification', async () => {
    const root = tempDir('cwt-order-');
    const { options, read } = backend('ok', root);
    const host = createLspProcessHost(options);
    try {
      await host.executeCommand('cwtools.ai.getValidationStatus');
      const log = read();
      const initializeAt = log.indexOf('INITIALIZE');
      const capabilitiesAt = log.indexOf('CAPABILITIES');
      const initializedAt = log.indexOf('NOTIFY initialized');
      const configAt = log.indexOf('NOTIFY workspace/didChangeConfiguration');
      expect(initializeAt).to.be.greaterThan(-1);
      expect(capabilitiesAt).to.be.greaterThan(initializeAt);
      expect(initializedAt).to.be.greaterThan(-1);
      expect(capabilitiesAt).to.be.lessThan(initializedAt);
      if (configAt >= 0) expect(capabilitiesAt).to.be.lessThan(configAt);
      expect(host.backendCapabilities?.serverVersion).to.equal('2.35.0');
    } finally {
      host.dispose();
    }
  });

  it('rejects a legacy backend before initialized/model loading', async () => {
    const root = tempDir('cwt-legacy-');
    const { options, read } = backend('legacy', root);
    const host = createLspProcessHost(options);
    try {
      const result = await host.executeCommand<{ status: string; error?: { code?: string; reason?: string } }>(
        'cwtools.ai.getValidationStatus',
      );
      expect(result.status).to.equal('unavailable');
      expect(result.error?.code).to.equal('backend_incompatible');
      expect(result.error?.reason).to.equal('legacy');
      const log = read();
      expect(log).to.not.include('NOTIFY initialized');
      expect(log).to.not.include('NOTIFY workspace/didChangeConfiguration');
    } finally {
      host.dispose();
    }
  });

  it('rejects an incomplete command table before initialized/model loading', async () => {
    const root = tempDir('cwt-incomplete-');
    const { options, read } = backend('incomplete', root);
    const host = createLspProcessHost(options);
    try {
      const result = await host.executeCommand<{ error?: { code?: string; reason?: string; message?: string } }>(
        'cwtools.ai.queryTypes',
      );
      expect(result.error?.code).to.equal('backend_incompatible');
      expect(result.error?.reason).to.equal('incomplete');
      expect(result.error?.message).to.include('cwtools.ai.getAllDiagnostics');
      expect(read()).to.not.include('NOTIFY initialized');
    } finally {
      host.dispose();
    }
  });

  it('reports one consistent incompatible shape from both entry points', async () => {
    const root = tempDir('cwt-shape-');
    const { options } = backend('malformed', root);
    const host = createLspProcessHost(options);
    try {
      const viaCommand = await host.executeCommand<{ ok: boolean; status: string; error?: Record<string, unknown> }>('cwtools.ai.queryTypes');
      const viaRequest = await host.request<{ ok: boolean; status: string; error?: Record<string, unknown> }>('textDocument/definition', {});
      expect(viaCommand.ok).to.equal(false);
      expect(viaCommand.status).to.equal('unavailable');
      expect(viaCommand.error?.code).to.equal('backend_incompatible');
      expect(viaRequest).to.deep.equal(viaCommand);
    } finally {
      host.dispose();
    }
  });
});

describe('LSP host startup abort leaves nothing running', () => {
  it('kills the child and installs no watcher when startup is aborted', async () => {
    const root = tempDir('cwt-startup-abort-');
    const { options, read } = backend('hang-capabilities', root);
    const host = createLspProcessHost(options);
    const controller = new AbortController();
    try {
      const pending = host.executeCommand('cwtools.ai.getValidationStatus', [], { signal: controller.signal });
      expect(await waitFor(() => read().includes('CAPABILITIES')), 'startup never reached the handshake: ' + read()).to.equal(true);
      const pid = Number((read().match(/PID (\d+)/) || [])[1]);
      expect(Number.isInteger(pid) && pid > 0).to.equal(true);
      controller.abort();
      let raised: unknown;
      try {
        await pending;
      } catch (error) {
        raised = error;
      }
      expect(isAbortError(raised), 'startup abort must surface as an AbortError').to.equal(true);
      host.dispose();
      const gone = await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 8000);
      expect(gone, 'the backend child survived the aborted startup').to.equal(true);
      expect(host.readyAtMs).to.equal(undefined);
      expect(host.backendCapabilities).to.equal(undefined);
    } finally {
      host.dispose();
    }
  });

  it('disposes the child on startup abort without an explicit dispose call', async () => {
    const root = tempDir('cwt-startup-abort-owned-');
    const { options, read } = backend('hang-capabilities', root);
    const host = createLspProcessHost(options);
    const controller = new AbortController();
    try {
      const pending = host.executeCommand('cwtools.ai.getValidationStatus', [], { signal: controller.signal });
      expect(await waitFor(() => read().includes('CAPABILITIES'))).to.equal(true);
      const pid = Number((read().match(/PID (\d+)/) || [])[1]);
      controller.abort();
      let raised: unknown;
      try {
        await pending;
      } catch (error) {
        raised = error;
      }
      expect(isAbortError(raised)).to.equal(true);
      const gone = await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 8000);
      expect(gone, 'startup abort did not release the backend child').to.equal(true);
      expect(host.readyAtMs).to.equal(undefined);
    } finally {
      host.dispose();
    }
  });

  it('refuses a late start completion after dispose', async () => {
    const root = tempDir('cwt-stale-');
    const { options, read } = backend('hang-capabilities', root);
    const host = createLspProcessHost(options);
    try {
      const pending = host.executeCommand('cwtools.ai.getValidationStatus').catch(() => undefined);
      expect(await waitFor(() => read().includes('CAPABILITIES'))).to.equal(true);
      host.dispose();
      await pending;
      await delay(200);
      expect(host.readyAtMs).to.equal(undefined);
      expect(host.backendCapabilities).to.equal(undefined);
    } finally {
      host.dispose();
    }
  });
});
