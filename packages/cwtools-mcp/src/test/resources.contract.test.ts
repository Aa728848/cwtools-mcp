import { expect } from 'chai';
import {
  createUnavailableDiagnosticsHost,
  createUnavailableLspHost,
  type HostServices,
} from 'cwtools-shared';
import { listResources, readResource } from '../mcp/resources';

describe('MCP resources contract', () => {
  it('lists project and knowledge resources', () => {
    const resources = listResources();
    expect(resources.map(resource => resource.uri)).to.deep.equal([
      'cwtools://knowledge/game',
      'cwtools://knowledge/diagnostic-routing',
      'cwtools://knowledge/workflow-hints',
      'cwtools://project/profile',
      'cwtools://project/knowledge-manifest',
    ]);
  });

  it('reads workflow hints as JSON resource content', async () => {
    const result = await readResource(createHost(), 'cwtools://knowledge/workflow-hints');
    expect(result.contents[0]?.mimeType).to.equal('application/json');
    expect(result.contents[0]?.text).to.include('diagnostic-fix');
  });

  it('reads the knowledge manifest only from the current .cwtools path', async () => {
    const host = createHost();
    const reads: string[] = [];
    host.filesystem.readTextFile = async filePath => {
      reads.push(filePath.replace(/\\/g, '/'));
      return { content: '', hasBom: false, exists: false };
    };

    await readResource(host, 'cwtools://project/knowledge-manifest');

    expect(reads).to.have.length(1);
    expect(reads[0]).to.match(/\.cwtools\/project\/knowledge\/manifest\.json$/);
    expect(reads[0]).not.to.include('.cwtools-ai');
  });
});

function createHost(): HostServices {
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
