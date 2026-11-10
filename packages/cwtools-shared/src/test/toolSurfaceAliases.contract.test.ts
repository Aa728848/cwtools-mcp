import { expect } from 'chai';
import {
  getCwtoolsToolSchema,
  getMcpToolSchema,
  isCwtoolsToolAvailable,
  isMcpToolAvailable,
  listCwtoolsToolSchemas,
  listMcpToolSchemas,
} from '../tools/mcpSchema';

// The tool surface is consumed outside MCP (Node host, editor integration, agent
// runtimes). The neutral names must be the same functions, not a parallel copy
// that can drift.

describe('neutral CWTools tool surface aliases', () => {
  it('lists the same schemas through both spellings', () => {
    expect(listCwtoolsToolSchemas()).to.deep.equal(listMcpToolSchemas());
    expect(listCwtoolsToolSchemas({ includeWrites: false })).to.deep.equal(listMcpToolSchemas({ includeWrites: false }));
    expect(listCwtoolsToolSchemas({ cwtOnly: true })).to.deep.equal(listMcpToolSchemas({ cwtOnly: true }));
  });

  it('answers availability identically through both spellings', () => {
    for (const name of ['query_types', 'write_localisation', 'get_ide_context', 'not_a_tool']) {
      for (const options of [undefined, { includeWrites: true }, { includeWrites: false }, { cwtOnly: true }]) {
        expect(isCwtoolsToolAvailable(name, options), `${name} ${JSON.stringify(options)}`)
          .to.equal(isMcpToolAvailable(name, options));
      }
    }
  });

  it('resolves a single schema identically through both spellings', () => {
    expect(getCwtoolsToolSchema('query_types')).to.deep.equal(getMcpToolSchema('query_types'));
    expect(getCwtoolsToolSchema('not_a_tool')).to.equal(undefined);
  });

  it('keeps the legacy MCP names exported', () => {
    expect(typeof listMcpToolSchemas).to.equal('function');
    expect(typeof isMcpToolAvailable).to.equal('function');
    expect(typeof getMcpToolSchema).to.equal('function');
  });
});
