import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeProjectWithHost, type HostServices, type LspHost } from '../index';

describe('initialize_project shared host contract', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-project-init-'));
    fs.mkdirSync(path.join(root, 'common'), { recursive: true });
    fs.writeFileSync(path.join(root, 'descriptor.mod'), 'name = "Init Fixture"\nsupported_version = "4.5.2"\n', 'utf8');
    fs.writeFileSync(path.join(root, 'common', 'fixture.txt'), 'fixture_type = { id = test }\n', 'utf8');
  });
  afterEach(() => {
    const files = [
      'descriptor.mod', 'common/fixture.txt', 'CWTOOLS.md',
      '.cwtools/project/profile.json', '.cwtools/project/knowledge/knowledge.sqlite', '.cwtools/project/knowledge/manifest.json',
    ];
    for (const name of files) {
      try { fs.rmSync(path.join(root, name), { force: true }); } catch { /* ignored */ }
    }
    const dirs = [
      '.cwtools/project/knowledge', '.cwtools/project', '.cwtools', 'common', '',
    ];
    for (const name of dirs) {
      try { fs.rmdirSync(path.join(root, name)); } catch { /* non-empty or absent */ }
    }
  });

  function hostWith(lsp: LspHost): HostServices {
    return {
      workspaceRoot: root,
      readonlyMode: false,
      writesEnabled: true,
      capabilities: new Set(['project_init']),
      lsp,
      diagnostics: { async getDiagnostics() { return { ok: true, status: 'ready', diagnostics: [] }; } },
      filesystem: {
        async readTextFile(filePath) {
          if (!fs.existsSync(filePath)) return { content: '', hasBom: false, exists: false };
          const content = await fs.promises.readFile(filePath, 'utf8');
          return { content, hasBom: content.charCodeAt(0) === 0xfeff, exists: true };
        },
        async writeTextFile(filePath, content) { await fs.promises.writeFile(filePath, content, 'utf8'); },
        async list(directory) {
          return fs.readdirSync(directory, { withFileTypes: true }).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }));
        },
        async glob() { return []; },
      },
      projectKind: 'mod',
      projectGameId: 'stellaris',
      now: () => Date.now(),
      log: () => undefined,
    };
  }

  it('cold-starts V4 profile and V7 SQLite knowledge without an Agent', async () => {
    let calls = 0;
    const lsp: LspHost = {
      async executeCommand(command, args) {
        if (command === 'cwtools.ai.getValidationStatus') return { modelReadyForKnowledgeExport: true, loading: { phase: 'ready' } };
        expect(command).to.equal('cwtools.ai.exportProjectKnowledge');
        calls++;
        const options = args[0] as { databasePath: string };
        fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
        fs.writeFileSync(options.databasePath, 'sqlite-fixture', 'utf8');
        return {
          ok: true, status: 'ready', schemaVersion: 7, game: 'stellaris', generatedAtUnixMs: 1,
          generationMode: 'full', projectRoots: [root], domains: [{ id: 'common' }], counts: { definitions: 1 },
        };
      },
      async sendRequest() { throw new Error('unexpected request'); },
    };
    const result = await initializeProjectWithHost(hostWith(lsp));
    expect(result.ok).to.equal(true);
    expect(calls).to.equal(1);
    const profile = JSON.parse(fs.readFileSync(path.join(root, '.cwtools/project/profile.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.cwtools/project/knowledge/manifest.json'), 'utf8'));
    expect(profile.schemaVersion).to.equal(4);
    expect(profile.projectName).to.equal('Init Fixture');
    expect(manifest.schemaVersion).to.equal(7);
    expect(manifest.status).to.equal('ready');
    expect(fs.readFileSync(path.join(root, '.cwtools/project/knowledge/knowledge.sqlite'), 'utf8')).to.equal('sqlite-fixture');
    expect(fs.readFileSync(path.join(root, 'CWTOOLS.md'), 'utf8')).to.include('User-owned');
  });

  it('reuses existing artifacts without rewriting them when knowledge is unchanged', async () => {
    const profilePath = path.join(root, '.cwtools/project/profile.json');
    const knowledgeRoot = path.join(root, '.cwtools/project/knowledge');
    const manifestPath = path.join(knowledgeRoot, 'manifest.json');
    const databasePath = path.join(knowledgeRoot, 'knowledge.sqlite');
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    const manifestText = '{"status":"ready","sentinel":true}\n';
    fs.writeFileSync(profilePath, 'profile-sentinel\n', 'utf8');
    fs.writeFileSync(manifestPath, manifestText, 'utf8');
    fs.writeFileSync(databasePath, 'sqlite-sentinel', 'utf8');
    const lsp: LspHost = {
      async executeCommand(command) {
        if (command === 'cwtools.ai.getValidationStatus') return { modelReadyForKnowledgeExport: true, loading: { phase: 'ready' } };
        expect(command).to.equal('cwtools.ai.exportProjectKnowledge');
        return { ok: true, status: 'ready', schemaVersion: 7, generationMode: 'unchanged', generatedAtUnixMs: 1 };
      },
      async sendRequest() { throw new Error('unexpected request'); },
    };
    const result = await initializeProjectWithHost(hostWith(lsp), { mode: 'incremental', changedFiles: ['common/fixture.txt'] });
    expect(result.ok).to.equal(true);
    expect(fs.readFileSync(profilePath, 'utf8')).to.equal('profile-sentinel\n');
    expect(fs.readFileSync(manifestPath, 'utf8')).to.equal(manifestText);
    expect(fs.readFileSync(databasePath, 'utf8')).to.equal('sqlite-sentinel');
  });

  it('shares concurrent initialization and preserves existing instructions on export failure', async () => {
    fs.writeFileSync(path.join(root, 'CWTOOLS.md'), '# user-owned\n', 'utf8');
    let resolveExport: ((value: unknown) => void) | undefined;
    let calls = 0;
    const lsp: LspHost = {
      async executeCommand(command) {
        if (command === 'cwtools.ai.getValidationStatus') return { modelReadyForKnowledgeExport: true, loading: { phase: 'ready' } };
        calls++;
        return new Promise(resolve => { resolveExport = resolve; });
      },
      async sendRequest() { throw new Error('unexpected request'); },
    };
    const host = hostWith(lsp);
    const first = initializeProjectWithHost(host);
    const second = initializeProjectWithHost(host);
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).to.equal(1);
    resolveExport?.({ ok: false, status: 'error', error: 'fixture export failure' });
    const [left, right] = await Promise.all([first, second]);
    expect(left.ok).to.equal(false);
    expect(right).to.equal(left);
    expect(fs.readFileSync(path.join(root, 'CWTOOLS.md'), 'utf8')).to.equal('# user-owned\n');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.cwtools/project/knowledge/manifest.json'), 'utf8'));
    expect(manifest.status).to.equal('unavailable');
    expect(manifest.staleReasons).to.include('lsp_export_unavailable');
  });
});
