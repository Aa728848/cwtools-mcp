import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { createLspProcessHost, isLspWatchedFile, pathToFileUri } from '../hosts/lspProcessHost';
import { createNodeHostServices } from '../hosts/nodeHostServices';
import { isAbortError, type LspHost } from 'cwtools-shared';

// Cancellation contract for the Node LSP host. The behaviour under test is the
// guarantee that an AbortSignal reaches the backend request and that the abort
// surfaces as an AbortError instead of being laundered into an unavailable tool
// result (which a client would retry forever).

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', prefix));
}

describe('node LSP host cancellation contract', () => {
  it('rethrows an aborted command instead of reporting it as unavailable', async () => {
    const root = tempDir('cwt-abort-');
    // A server path that does not exist keeps startup instant and deterministic.
    const host = createLspProcessHost({ workspaceRoot: root, serverPath: path.join(root, 'missing-server') });
    const controller = new AbortController();
    controller.abort();
    try {
      await host.executeCommand('cwtools.ai.getValidationStatus', [], { signal: controller.signal });
      expect.fail('executeCommand should have rejected');
    } catch (error) {
      expect(isAbortError(error)).to.equal(true);
      expect((error as Error).name).to.equal('AbortError');
    } finally {
      host.dispose();
    }
  });

  it('still reports a genuinely missing backend as unavailable (no over-capture)', async () => {
    const root = tempDir('cwt-missing-');
    const host = createLspProcessHost({ workspaceRoot: root, serverPath: path.join(root, 'missing-server') });
    try {
      const result = await host.executeCommand<{ status?: string; error?: { code?: string } }>(
        'cwtools.ai.getValidationStatus',
      );
      expect(result.status).to.equal('unavailable');
      expect(result.error?.code).to.equal('lsp_unavailable');
    } finally {
      host.dispose();
    }
  });

  it('keeps the abort error out of generic requests too', async () => {
    const root = tempDir('cwt-abort-req-');
    const host = createLspProcessHost({ workspaceRoot: root, serverPath: path.join(root, 'missing-server') });
    const controller = new AbortController();
    controller.abort();
    try {
      await host.request('textDocument/definition', {}, { signal: controller.signal });
      expect.fail('request should have rejected');
    } catch (error) {
      expect(isAbortError(error)).to.equal(true);
    } finally {
      host.dispose();
    }
  });

  it('releases the abort listener it registered on a timed call', async () => {
    const root = tempDir('cwt-abort-listener-');
    const host = createLspProcessHost({ workspaceRoot: root, serverPath: path.join(root, 'missing-server') });
    const controller = new AbortController();
    const added: string[] = [];
    const removed: string[] = [];
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (originalAdd as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (originalRemove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof signal.removeEventListener;
    try {
      await host.executeCommand('cwtools.ai.getValidationStatus', [], { signal, timeoutMs: 50 });
    } finally {
      host.dispose();
    }
    // Every registration must have been released: a cancelled or finished call
    // may not leak a listener onto the caller's signal.
    expect(added).to.deep.equal(removed);
  });

  it('rejects every waiter when the signal is already aborted', async () => {
    const root = tempDir('cwt-abort-idem-');
    const host = createLspProcessHost({ workspaceRoot: root, serverPath: path.join(root, 'missing-server') });
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const results = await Promise.allSettled([
      host.executeCommand('cwtools.ai.getValidationStatus', [], { signal: controller.signal }),
      host.executeCommand('cwtools.ai.getValidationStatus', [], { signal: controller.signal }),
    ]);
    host.dispose();
    expect(results.every(result => result.status === 'rejected')).to.equal(true);
    for (const result of results) {
      if (result.status === 'rejected') expect(isAbortError(result.reason)).to.equal(true);
    }
  });

  it('cancels a diagnostics query instead of returning an empty fresh result', async () => {
    const root = tempDir('cwt-diag-abort-');
    const host = createNodeHostServices({
      workspaceRoot: root,
      enableWrites: false,
      allowedTools: [],
      forceStart: false,
    });
    const controller = new AbortController();
    controller.abort();
    try {
      await host.diagnostics.getDiagnostics({ file: 'events/a.txt' }, { signal: controller.signal });
      expect.fail('getDiagnostics should have rejected');
    } catch (error) {
      expect(isAbortError(error)).to.equal(true);
    } finally {
      host.dispose?.();
    }
  });

  it('disposes idempotently so repeated teardown cannot kill twice', () => {
    const root = tempDir('cwt-dispose-');
    const host = createLspProcessHost({ workspaceRoot: root, serverPath: path.join(root, 'missing-server') });
    expect(() => {
      host.dispose();
      host.dispose();
      host.dispose();
    }).to.not.throw();
  });

  it('accepts the shared LspHost surface so a host can be swapped for a stub', async () => {
    const stub: LspHost = {
      async executeCommand<T>() {
        return { ok: true, status: 'ready' } as T;
      },
    };
    const result = await stub.executeCommand<{ ok: boolean }>('x');
    expect(result.ok).to.equal(true);
  });

  it('keeps the path and URI helpers stable for the watcher contract', () => {
    const root = path.resolve('C:/workspace/mod');
    expect(isLspWatchedFile(root, path.join(root, 'events', 'a.txt'))).to.equal(true);
    expect(pathToFileUri(path.join(root, 'a # b.txt'))).to.include('%23');
  });
});
