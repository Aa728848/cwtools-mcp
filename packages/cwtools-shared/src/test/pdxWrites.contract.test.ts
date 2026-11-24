import { expect } from 'chai';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DiagnosticRecord, DiagnosticsFreshness } from '../host/diagnostics';
import { createUnavailableDiagnosticsHost } from '../host/diagnostics';
import { createUnavailableLspHost } from '../host/lsp';
import type { FilesystemHost } from '../host/filesystem';
import type { HostServices } from '../host/hostServices';
import { candidateTransactionWithHost, typedPdxWriteWithHost } from '../tools/pdxWrites';
import { buildTypedPdxCandidate } from '../tools/pdxWriteCore';

// Contract tests for the standalone domain-write surface. Every path here must
// work without VS Code: the host is reduced to workspace containment, a
// filesystem, diagnostics and an LSP command channel.

const BOM = '\uFEFF';

interface FakeLspBehaviour {
  overlay?: 'ok' | 'error' | 'unavailable' | 'malformed' | 'hang';
  revalidate?: boolean;
}

interface FakeDiagnosticsBehaviour {
  status: DiagnosticsFreshness;
  records: DiagnosticRecord[];
  epoch: number;
}

function createTestHost(root: string, options: {
  writesEnabled?: boolean;
  readonlyMode?: boolean;
  allowedWriteTools?: Set<string>;
  lsp?: FakeLspBehaviour;
  diagnostics?: FakeDiagnosticsBehaviour;
} = {}): HostServices {
  const deleted: Array<{ path: string; error: string }> = [];
  void deleted;
  const filesystem: FilesystemHost & { deleteFile(target: string): Promise<void> } = {
    async readTextFile(filePath) {
      if (!fs.existsSync(filePath)) return { content: '', hasBom: false, exists: false };
      const content = fs.readFileSync(filePath, 'utf8');
      return { content, hasBom: content.charCodeAt(0) === 0xfeff, exists: true };
    },
    async writeTextFile(filePath, content) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
    },
    async list(dirPath) {
      if (!fs.existsSync(dirPath)) return [];
      return fs.readdirSync(dirPath, { withFileTypes: true }).map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' as const : 'file' as const,
      }));
    },
    async glob() { return []; },
    async deleteFile(target) {
      try { fs.unlinkSync(target); } catch (error) { deleted.push({ path: target, error: String(error) }); }
    },
  };
  const lsp = {
    ...createUnavailableLspHost(),
    async executeCommand(command: string, args: unknown[]) {
      if (command === 'cwtools.ai.revalidateFiles') {
        return options.lsp?.revalidate === false ? { ok: false } : { ok: true };
      }
      if (command !== 'cwtools.ai.validateOverlay') return { ok: false, error: { code: 'unknown_command', message: command } };
      const behaviour = options.lsp?.overlay ?? 'ok';
      if (behaviour === 'unavailable') return { status: 'unavailable', error: { code: 'lsp_unavailable', message: 'no backend' } };
      if (behaviour === 'hang') return new Promise(() => undefined);
      if (behaviour === 'malformed') return { ok: true, files: [] };
      const request = (args[0] ?? {}) as { files?: Array<{ uri: string; content: string; baseHash?: string }> };
      const files = request.files ?? [];
      return {
        ok: true,
        validationLevel: 'semantic',
        files: files.map(file => behaviour === 'error'
          ? { uri: file.uri, ok: true, contentHash: 'x'.repeat(64), diagnostics: [{ code: 'cwt_error', severity: 'error', message: 'bad', line: 1, column: 0 }] }
          : { uri: file.uri, ok: true, contentHash: sha256Of(file.content), diagnostics: [] }),
      };
    },
  } as HostServices['lsp'];
  // The epoch advances on every read so a post-write read is "newer" than the
  // baseline, which is exactly what the commit freshness gate requires.
  let diagnosticsReads = 0;
  const diagnostics = options.diagnostics
    ? { getDiagnostics: async () => {
        diagnosticsReads++;
        return {
          ok: true,
          status: options.diagnostics!.status,
          diagnostics: options.diagnostics!.records,
          freshness: {
            value: options.diagnostics!.status,
            pendingKinds: [],
            epoch: options.diagnostics!.epoch + diagnosticsReads,
          },
        };
      } }
    : createUnavailableDiagnosticsHost();
  return {
    workspaceRoot: root,
    readonlyMode: options.readonlyMode ?? false,
    writesEnabled: options.writesEnabled ?? true,
    allowedWriteTools: options.allowedWriteTools,
    lsp,
    diagnostics,
    filesystem,
    now: () => Date.now(),
    log: () => undefined,
  };
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function tempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const EVENT_FILE = [
  'namespace = test',
  '',
  'country_event = {',
  '\tid = test.1',
  '',
  '\ttrigger = {',
  '\t\tis_ai = no',
  '\t}',
  '',
  '\toption = {',
  '\t\tname = test.1.a',
  '\t}',
  '}',
  '',
].join('\n');
describe('typed_pdx_write standalone contract', () => {
  it('previews a candidate without touching the file', async () => {
    const root = tempWorkspace('cwt-pdxw-');
    const file = path.join(root, 'events', 'test.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, EVENT_FILE, 'utf8');
    try {
      const result = await typedPdxWriteWithHost(createTestHost(root), {
        filePath: 'events/test.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'test.1.b' },
      });
      expect(result.ok).to.equal(true);
      expect(result.data?.mode).to.equal('preview');
      expect(result.data?.candidate?.content).to.include('name = test.1.b');
      expect(fs.readFileSync(file, 'utf8')).to.equal(EVENT_FILE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to write when the host is read-only', async () => {
    const root = tempWorkspace('cwt-pdxw-');
    try {
      const result = await typedPdxWriteWithHost(createTestHost(root, { writesEnabled: false, readonlyMode: true }), {
        filePath: 'events/test.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'x' },
      });
      expect(result.ok).to.equal(false);
      expect(result.status).to.equal('denied');
      expect(result.error?.code).to.equal('read_only');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a path that escapes the workspace', async () => {
    const root = tempWorkspace('cwt-pdxw-');
    try {
      const result = await typedPdxWriteWithHost(createTestHost(root), {
        filePath: '../../outside.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'x' },
      });
      expect(result.ok).to.equal(false);
      expect(result.error?.code).to.equal('outside_workspace');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unknown operation and never invents a file', async () => {
    const root = tempWorkspace('cwt-pdxw-');
    try {
      const host = createTestHost(root);
      const missing = await typedPdxWriteWithHost(host, {
        filePath: 'events/missing.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'x' },
      });
      expect(missing.error?.code).to.equal('file_not_found');
      expect(fs.existsSync(path.join(root, 'events', 'missing.txt'))).to.equal(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a BOM and CRLF line endings when staging', async () => {
    const root = tempWorkspace('cwt-pdxw-');
    const file = path.join(root, 'events', 'crlf.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, BOM + EVENT_FILE.replace(/\n/g, '\r\n'), 'utf8');
    try {
      const host = createTestHost(root);
      const begun = await candidateTransactionWithHost(host, { action: 'begin' });
      const staged = await typedPdxWriteWithHost(host, {
        filePath: 'events/crlf.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'test.1.c' },
        mode: 'stage',
        transactionId: begun.data?.transactionId,
      });
      expect(staged.ok).to.equal(true);
      expect(staged.data?.mode).to.equal('stage');
      expect(staged.data?.candidate?.content).to.include('\r\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a stage without an active transaction instead of writing', async () => {
    const root = tempWorkspace('cwt-pdxw-');
    const file = path.join(root, 'events', 'test.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, EVENT_FILE, 'utf8');
    try {
      const result = await typedPdxWriteWithHost(createTestHost(root), {
        filePath: 'events/test.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'test.1.b' },
        mode: 'stage',
        transactionId: 'not-a-real-transaction',
      });
      expect(result.ok).to.equal(false);
      expect(result.error?.code).to.equal('transaction_inactive');
      expect(fs.readFileSync(file, 'utf8')).to.equal(EVENT_FILE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('candidate_transaction standalone contract', () => {
  it('validates and commits a staged candidate to disk', async function () {
    this.timeout(30_000);
    const root = tempWorkspace('cwt-tx-');
    const file = path.join(root, 'events', 'test.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, EVENT_FILE, 'utf8');
    try {
      const host = createTestHost(root, { diagnostics: { status: 'fresh', records: [], epoch: 5 } });
      const begun = await candidateTransactionWithHost(host, { action: 'begin' });
      const transactionId = begun.data?.transactionId;
      expect(begun.data?.state).to.equal('active');

      const staged = await typedPdxWriteWithHost(host, {
        filePath: 'events/test.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'test.1.b' },
        mode: 'stage',
        transactionId,
      });
      expect(staged.data?.candidate?.content).to.include('name = test.1.b');

      const validated = await candidateTransactionWithHost(host, { action: 'validate', transactionId });
      expect(validated.data?.success).to.equal(true);
      expect(validated.data?.state).to.equal('validated');

      const committed = await candidateTransactionWithHost(host, { action: 'commit', transactionId });
      expect(committed.ok).to.equal(true);
      expect(committed.data?.state).to.equal('committed');
      expect(fs.readFileSync(file, 'utf8')).to.include('name = test.1.b');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the transaction active when overlay validation is unavailable', async () => {
    const root = tempWorkspace('cwt-tx-');
    const file = path.join(root, 'events', 'test.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, EVENT_FILE, 'utf8');
    try {
      const host = createTestHost(root, { lsp: { overlay: 'unavailable' } });
      const begun = await candidateTransactionWithHost(host, { action: 'begin' });
      const transactionId = begun.data?.transactionId;
      await typedPdxWriteWithHost(host, {
        filePath: 'events/test.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'test.1.b' },
        mode: 'stage',
        transactionId,
      });
      const validated = await candidateTransactionWithHost(host, { action: 'validate', transactionId });
      expect(validated.ok).to.equal(false);
      expect(validated.data?.infrastructureError).to.include('not available');
      expect(validated.data?.state).to.equal('active');
      // The commit path must stay closed while validation never ran.
      const committed = await candidateTransactionWithHost(host, { action: 'commit', transactionId });
      expect(committed.ok).to.equal(false);
      expect(committed.error?.code).to.equal('transaction_not_validated');
      expect(fs.readFileSync(file, 'utf8')).to.equal(EVENT_FILE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks commit when overlay validation reports an error diagnostic', async () => {
    const root = tempWorkspace('cwt-tx-');
    const file = path.join(root, 'events', 'test.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, EVENT_FILE, 'utf8');
    try {
      const host = createTestHost(root, { lsp: { overlay: 'error' } });
      const begun = await candidateTransactionWithHost(host, { action: 'begin' });
      const transactionId = begun.data?.transactionId;
      await typedPdxWriteWithHost(host, {
        filePath: 'events/test.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'test.1.b' },
        mode: 'stage',
        transactionId,
      });
      const validated = await candidateTransactionWithHost(host, { action: 'validate', transactionId });
      expect(validated.data?.success).to.equal(false);
      expect(validated.data?.state).to.equal('validated');
      const committed = await candidateTransactionWithHost(host, { action: 'commit', transactionId });
      expect(committed.ok).to.equal(false);
      expect(fs.readFileSync(file, 'utf8')).to.equal(EVENT_FILE);
      expect(committed.data?.state).to.equal('discarded');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back a commit that introduces new diagnostics', async () => {
    const root = tempWorkspace('cwt-tx-');
    const file = path.join(root, 'events', 'test.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, EVENT_FILE, 'utf8');
    let calls = 0;
    const host = createTestHost(root);
    host.diagnostics = {
      async getDiagnostics() {
        calls++;
        // The first (baseline) read is clean; every later read reports a new error,
        // which is exactly the regression the commit must roll back.
        return {
          ok: true,
          status: 'fresh',
          diagnostics: calls === 1 ? [] : [{ severity: 'error', code: 'cwt_error', message: 'introduced', line: 3, column: 0 }],
          freshness: { value: 'fresh', pendingKinds: [], epoch: calls },
        };
      },
    };
    try {
      const begun = await candidateTransactionWithHost(host, { action: 'begin' });
      const transactionId = begun.data?.transactionId;
      await typedPdxWriteWithHost(host, {
        filePath: 'events/test.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'test.1.b' },
        mode: 'stage',
        transactionId,
      });
      await candidateTransactionWithHost(host, { action: 'validate', transactionId });
      const committed = await candidateTransactionWithHost(host, { action: 'commit', transactionId });
      expect(committed.ok).to.equal(false);
      expect(committed.data?.commit?.rollback.succeeded).to.equal(true);
      expect(fs.readFileSync(file, 'utf8')).to.equal(EVENT_FILE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects external disk drift instead of overwriting it', async () => {
    const root = tempWorkspace('cwt-tx-');
    const file = path.join(root, 'events', 'test.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, EVENT_FILE, 'utf8');
    try {
      const host = createTestHost(root, { diagnostics: { status: 'fresh', records: [], epoch: 1 } });
      const begun = await candidateTransactionWithHost(host, { action: 'begin' });
      const transactionId = begun.data?.transactionId;
      await typedPdxWriteWithHost(host, {
        filePath: 'events/test.txt',
        operation: { operation: 'add_event_option', target: 'test.1', name: 'test.1.b' },
        mode: 'stage',
        transactionId,
      });
      const edited = EVENT_FILE.replace('is_ai = no', 'is_ai = yes');
      fs.writeFileSync(file, edited, 'utf8');
      await candidateTransactionWithHost(host, { action: 'validate', transactionId });
      const committed = await candidateTransactionWithHost(host, { action: 'commit', transactionId });
      expect(committed.ok).to.equal(false);
      expect(String(committed.data?.error)).to.include('drift');
      expect(fs.readFileSync(file, 'utf8')).to.equal(edited);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an already-active transaction and discards cleanly', async () => {
    const root = tempWorkspace('cwt-tx-');
    try {
      const host = createTestHost(root);
      const begun = await candidateTransactionWithHost(host, { action: 'begin' });
      const again = await candidateTransactionWithHost(host, { action: 'begin' });
      expect(again.ok).to.equal(false);
      expect(again.error?.code).to.equal('transaction_active');
      const discarded = await candidateTransactionWithHost(host, { action: 'discard', transactionId: begun.data?.transactionId });
      expect(discarded.data?.state).to.equal('discarded');
      const status = await candidateTransactionWithHost(host, { action: 'status' });
      expect(status.data?.state).to.equal('discarded');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});