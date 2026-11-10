import { expect } from 'chai';
import {
  createToolCallHandler,
  defaultSharedToolDispatcher,
  type HostServices,
  type LspHost,
} from 'cwtools-shared';

const UNAVAILABLE = {
  ok: false,
  status: 'unavailable',
  error: { code: 'active_unavailable', message: 'fetch failed' },
};

function host(overrides: {
  lsp?: Partial<LspHost>;
  diagnostics?: HostServices['diagnostics'];
  filesystem?: Partial<HostServices['filesystem']>;
}): HostServices {
  const lsp: LspHost = {
    async executeCommand() { return { ok: true } as never; },
    async request() { return [] as never; },
    ...overrides.lsp,
  };
  return {
    workspaceRoot: '/ws',
    readonlyMode: true,
    writesEnabled: false,
    lsp,
    diagnostics: overrides.diagnostics ?? { async getDiagnostics() { return { ok: true, status: 'fresh', diagnostics: [] }; } },
    filesystem: {
      async readTextFile() { return { content: '', hasBom: false, exists: false }; },
      async writeTextFile() { throw new Error('read-only'); },
      async list() { return []; },
      async glob() { return []; },
      ...overrides.filesystem,
    },
    now: () => Date.now(),
    log: () => undefined,
  } as HostServices;
}

describe('tool failure signals', () => {
  it('treats an LSP command answer of ok:false as a failure, not an empty success', async () => {
    const result = await defaultSharedToolDispatcher(
      host({ lsp: { async executeCommand() { return { ok: false, status: 'error', error: 'No such type.' } as never; } } }),
      'query_types',
      { typeName: 'definitely_not_a_type' },
    );
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('error');
    expect(result.error?.message).to.equal('No such type.');
    expect(result.error?.code).to.equal('lsp_command_failed');
  });

  it('keeps ok:false from queryDefinitionByName as a definition miss', async () => {
    const result = await defaultSharedToolDispatcher(
      host({ lsp: { async executeCommand() { return { ok: false, error: "Symbol 'x' was not found." } as never; } } }),
      'go_to_definition',
      { symbolName: 'x' },
    );
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('error');
    expect(result.error?.code).to.equal('definition_not_found');
    expect(result.error?.message).to.contain('was not found');
  });

  it('rejects exact without a query on explore_pdx_project', async () => {
    const exactOnly = await defaultSharedToolDispatcher(host({}), 'explore_pdx_project', {
      typeName: 'scripted_effect',
      exact: 'kuat_battle_set_foo',
    });
    expect(exactOnly.status).to.equal('error');
    expect(exactOnly.error?.code).to.equal('invalid_arguments');

    const missingQuery = await defaultSharedToolDispatcher(host({}), 'explore_pdx_project', { exact: true });
    expect(missingQuery.status).to.equal('error');
    expect(missingQuery.error?.code).to.equal('invalid_arguments');
  });

  it('labels lexical reference fallback as partial evidence', async () => {
    const result = await defaultSharedToolDispatcher(
      host({
        lsp: {
          async executeCommand() { return UNAVAILABLE as never; },
          async request() { return UNAVAILABLE as never; },
        },
        filesystem: {
          async glob() { return ['common/x.txt']; },
          async readTextFile() { return { content: 'is_modifiering_fleet = yes', hasBom: false, exists: true }; },
        },
      }),
      'find_references',
      { identifier: 'is_modifiering_fleet' },
    );
    expect(result.ok).to.equal(true);
    expect(result.status).to.equal('partial');
    expect(result.source).to.equal('cwtools-text-references');
    expect(result.warnings?.[0]).to.contain('lexical');
    expect((result.data as Record<string, unknown>).evidence).to.equal('lexical');
  });

  it('does not relabel an unavailable result as loading when the backend is gone', async () => {
    const call = createToolCallHandler(host({
      lsp: { async executeCommand() { return UNAVAILABLE as never; } },
      diagnostics: {
        async getDiagnostics() {
          return { ok: false, status: 'unavailable', diagnostics: [], error: { code: 'active_unavailable', message: 'fetch failed' } };
        },
      },
    }));
    const result = await call('get_diagnostics', {});
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('unavailable');
    expect((result as { readiness?: { ready: boolean } }).readiness?.ready).to.equal(false);
    expect(result.nextSteps?.[0]).to.contain('CWTools backend');
  });
});
