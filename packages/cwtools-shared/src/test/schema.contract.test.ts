import { expect } from 'chai';
import { getGeneratedMcpTools, listMcpToolSchemas } from '../tools/mcpSchema';
import { MCP_ALL_TOOL_NAMES, MCP_TOOL_NAMES } from '../tools/names';

// Drift against the extension's tool definitions is checked on the
// cwtools-vscode side: node tools/generate-mcp-schema.cjs --check
describe('MCP schema contract', () => {
  it('generates the MCP tool schemas for every whitelisted tool name', () => {
    const generated = getGeneratedMcpTools();
    expect(generated.map(entry => entry.tool.name)).to.deep.equal([...MCP_ALL_TOOL_NAMES]);
    expect(listMcpToolSchemas().map(tool => tool.name)).to.deep.equal([...MCP_ALL_TOOL_NAMES]);
    expect(listMcpToolSchemas({ includeWrites: true }).map(tool => tool.name)).to.deep.equal([...MCP_ALL_TOOL_NAMES]);
    expect(listMcpToolSchemas({ includeWrites: false }).map(tool => tool.name)).to.deep.equal([...MCP_TOOL_NAMES]);
    expect(generated.map(entry => entry.tool.name)).to.include.members([
      'get_completion_at',
      'document_symbols',
      'workspace_symbols',
      'go_to_definition',
      'find_references',
      'get_ide_context',
      'open_in_visual_editor',
    ]);

    for (const toolName of MCP_ALL_TOOL_NAMES) {
      const entry = generated.find(item => item.tool.name === toolName);
      expect(entry, `missing generated definition for ${toolName}`).to.not.equal(undefined);
      expect(entry!.tool.description, `empty description for ${toolName}`).to.be.a('string').and.not.equal('');
      expect(entry!.tool.inputSchema, `missing input schema for ${toolName}`).to.not.equal(undefined);
      expect(entry!.registry.name, `registry mismatch for ${toolName}`).to.equal(toolName);
    }
  });
});
