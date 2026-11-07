import { expect } from 'chai';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  isMcpToolName,
  MCP_TOOL_NAMES,
  type HostServices,
} from 'cwtools-shared';
import { createToolCallHandler } from '../mcp/toolHandlers';

describe('MCP read-only surface contract', () => {
  it('does not register any write tool by default', () => {
    expect(isMcpToolName('write_localisation')).to.equal(false);
    expect(isMcpToolName('write_localisation', { includeWrites: true })).to.equal(true);
    expect((MCP_TOOL_NAMES as readonly string[])).to.not.include('write_localisation');
    expect((MCP_TOOL_NAMES as readonly string[])).to.include('get_ide_context');
    expect((MCP_TOOL_NAMES as readonly string[])).to.include('open_in_visual_editor');
  });

  it('rejects write_localisation as not available (read-only server)', async () => {
    const result = await createToolCallHandler(createTestHost())('write_localisation', {
      filePath: 'localisation/english/test_l_english.yml',
      entries: [{ key: 'blocked', value: 'Blocked' }],
    });
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('denied');
    expect(result.error?.code).to.equal('tool_not_available');
  });

  it('allows write_localisation when writes are explicitly enabled on the host', async () => {
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
