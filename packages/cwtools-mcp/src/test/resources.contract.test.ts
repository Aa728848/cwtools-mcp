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
      'cwtools://skills/catalog',
    ]);
  });

  it('hides all resources for unsupported projects and only diagnostics routing for CWT-only', () => {
    const unsupported = createHost();
    unsupported.projectSupported = false;
    unsupported.projectKind = 'unsupported';
    expect(listResources(unsupported)).to.deep.equal([]);

    const cwt = createHost();
    cwt.projectKind = 'cwt-only';
    expect(listResources(cwt).map(resource => resource.uri)).to.deep.equal([
      'cwtools://knowledge/diagnostic-routing',
    ]);
  });

  it('rejects cached resource reads when the project is unsupported', async () => {
    const host = createHost();
    host.projectSupported = false;
    host.projectKind = 'unsupported';
    const result = await readResource(host, 'cwtools://knowledge/game');
    expect(result.contents[0]?.text).to.include('project_not_supported');
  });

  it('reads skills catalog as JSON resource content', async () => {
    const result = await readResource(createHost(), 'cwtools://skills/catalog');
    expect(result.contents[0]?.mimeType).to.equal('application/json');
    expect(result.contents[0]?.text).to.include('"status": "ready"');
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
