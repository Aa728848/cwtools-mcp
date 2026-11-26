import { expect } from 'chai';
import { getMcpToolSchema, listMcpToolSchemas } from '../tools/mcpSchema';
import { MCP_ALL_TOOL_NAMES, MCP_WRITE_TOOL_NAMES } from '../tools/names';
import { LOAD_DEPENDENT_TOOLS } from '../host/readiness';
import { defaultSharedToolDispatcher } from '../tools/toolHandlers';
import type { HostServices } from '../host/hostServices';

const TOOLS = ['ship_design_draft', 'static_galaxy_draft'] as const;
const ACTIONS = ['begin', 'apply', 'validate', 'commit', 'discard', 'status'];

// Guard the catalog wiring that turns the shared ship/static-galaxy write-back
// helpers into first-class, independently-granted tools. The behavior-level
// grant semantics (draft grant present, candidate_transaction absent) live in
// shipGalaxyEditors.test.ts.
describe('ship/static galaxy draft tool surface', () => {
  it('registers both draft tools as write tools in catalog order', () => {
    const writeNames = [...MCP_WRITE_TOOL_NAMES];
    for (const name of TOOLS) expect(writeNames, name).to.include(name);
    const schemaOrder = listMcpToolSchemas({ includeWrites: true }).map(tool => tool.name);
    // The generated catalog and names.ts stay positionally aligned.
    expect(schemaOrder).to.deep.equal([...MCP_ALL_TOOL_NAMES]);
    // The two draft tools appear right after gui_draft, in declaration order.
    const guiIndex = schemaOrder.indexOf('gui_draft');
    expect(schemaOrder.slice(guiIndex + 1, guiIndex + 3)).to.deep.equal([...TOOLS]);
  });

  it('exposes the begin/apply/validate/commit/discard/status action set', () => {
    for (const name of TOOLS) {
      const schema = getMcpToolSchema(name);
      expect(schema, name).to.not.equal(undefined);
      const inputSchema = schema!.inputSchema as { properties?: { action?: { enum?: string[] } }; required?: string[] };
      expect(inputSchema.properties?.action?.enum, name).to.deep.equal(ACTIONS);
      expect(inputSchema.required, name).to.deep.equal(['action']);
    }
  });

  it('is load-dependent so results are not trusted while the model is loading', () => {
    for (const name of TOOLS) expect(LOAD_DEPENDENT_TOOLS.has(name), name).to.equal(true);
  });

  it('is denied by default when writes are not enabled', async () => {
    const host = {
      workspaceRoot: '/ws', readonlyMode: true, writesEnabled: false,
      lsp: { async executeCommand() { return { ok: true } as never; }, async request() { return [] as never; } },
      diagnostics: { async getDiagnostics() { return { ok: true, status: 'fresh', diagnostics: [] }; } },
      filesystem: {
        async readTextFile() { return { content: '', hasBom: false, exists: false }; },
        async writeTextFile() { throw new Error('read-only'); },
        async list() { return []; },
        async glob() { return []; },
      },
      now: () => Date.now(), log: () => undefined,
    } as HostServices;
    for (const name of TOOLS) {
      const result = await defaultSharedToolDispatcher(host, name, { action: 'begin', filePath: 'x.txt' });
      expect(result.ok, name).to.equal(false);
      expect(result.error?.code, name).to.equal('read_only');
    }
  });
});