import { expect } from 'chai';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  isMcpToolName,
  MCP_TOOL_NAMES,
  type HostServices,
} from 'cwtools-shared';
import { createToolCallHandler } from '../mcp/toolHandlers';

describe('MCP domain-write policy contract', () => {
  it('includes whitelisted writes by default while preserving an embedded read-only filter', () => {
    expect(isMcpToolName('write_localisation')).to.equal(true);
    expect(isMcpToolName('write_localisation', { includeWrites: true })).to.equal(true);
    expect(isMcpToolName('write_localisation', { includeWrites: false })).to.equal(false);
    expect((MCP_TOOL_NAMES as readonly string[])).to.not.include('write_localisation');
    expect((MCP_TOOL_NAMES as readonly string[])).to.include('get_ide_context');
    expect((MCP_TOOL_NAMES as readonly string[])).to.include('open_in_visual_editor');
  });

  it('retains the read-only guard for an explicitly read-only embedded host', async () => {
    const result = await createToolCallHandler(createTestHost())('write_localisation', {
      filePath: 'localisation/english/test_l_english.yml',
      entries: [{ key: 'blocked', value: 'Blocked' }],
    });
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('denied');
    expect(result.error?.code).to.equal('tool_not_available');
  });

  it('rejects full-game tools in CWT-only mode even when cached by a client', async () => {
    const host = createTestHost();
    host.projectKind = 'cwt-only';
    const result = await createToolCallHandler(host)('query_types', { typeName: 'ship_size' });
    expect(result.ok).to.equal(false);
    expect(result.error?.code).to.equal('tool_not_available_in_cwt_only');
  });

  it('allows write_localisation for a write-capable host', async () => {
    const written: Array<{ path: string; content: string }> = [];
    const host = createTestHost();
    host.readonlyMode = false;
    host.writesEnabled = true;
    host.filesystem.writeTextFile = async (filePath, content) => {
      written.push({ path: filePath, content });
    };

    const result = await createToolCallHandler(host)('write_localisation', {
      filePath: 'localisation/english/test_l_english.yml',
      entries: [{ key: 'allowed.key', value: 'Allowed' }],
    });
    expect(result.ok).to.equal(true);
    expect(result.status).to.equal('success');
    expect(written).to.have.length(1);
    expect(written[0]!.content.charCodeAt(0)).to.equal(0xfeff);
  });
});

function createTestHost(): HostServices {
  return {
    workspaceRoot: process.cwd(),
    readonlyMode: true,
    writesEnabled: false,
    lsp: createUnavailableLspHost(),
    diagnostics: createUnavailableDiagnosticsHost(),
    filesystem: {
      async readTextFile() { return { content: '', hasBom: false, exists: false }; },
      async writeTextFile() { throw new Error('unexpected write'); },
      async list() { return []; },
      async glob() { return []; },
    },
    now: () => Date.now(),
    log: () => undefined,
  };
}
