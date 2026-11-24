import { expect } from 'chai';
import { getGeneratedMcpTools, listMcpToolSchemas } from '../tools/mcpSchema';
import { MCP_ALL_TOOL_NAMES, MCP_TOOL_NAMES } from '../tools/names';

// The shared catalog is authoritative; these tests check schema and host capability consistency.
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

  it('filters host-only tools from both listing and availability without a capability', () => {
    const tools = listMcpToolSchemas({ capabilities: new Set() }).map(tool => tool.name);
    expect(tools).to.include('query_types');
    for (const name of ['get_ide_context', 'open_in_visual_editor', 'capture_gui_preview', 'initialize_project']) {
      expect(tools).to.not.include(name);
    }
  });
});
