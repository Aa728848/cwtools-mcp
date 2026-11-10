import { expect } from 'chai';
import type { WorkspaceProjectDetection, WorkspaceProjectKind } from 'cwtools-shared';
import { fallbackBridgeResources, fallbackBridgeTools, localBridgeToolDenied } from '../mcp/bridgeProxy';

function project(kind: WorkspaceProjectKind): WorkspaceProjectDetection {
  return { kind, strength: kind === 'unsupported' || kind === 'ambiguous' ? 'none' : 'strong', evidence: [], reason: kind };
}

describe('MCP bridge capability fallback contract', () => {
  it('does not expose the static toolset for unsupported or ambiguous workspaces', () => {
    expect(fallbackBridgeTools(project('unsupported'), false)).to.deep.equal([]);
    expect(fallbackBridgeTools(project('ambiguous'), false)).to.deep.equal([]);
    expect(fallbackBridgeResources(project('unsupported'))).to.deep.equal([]);
  });

  it('uses the generated CWT capability metadata when an older bridge has no project field', () => {
    expect(fallbackBridgeTools(project('cwt-only'), false).map(tool => tool.name)).to.have.length(7);
    expect(localBridgeToolDenied(project('cwt-only'), 'query_types')?.error?.code)
      .to.equal('tool_not_available_in_cwt_only');
    expect(localBridgeToolDenied(project('cwt-only'), 'get_diagnostics')).to.equal(undefined);
    expect(fallbackBridgeResources(project('cwt-only')).map(resource => resource.uri)).to.deep.equal([
      'cwtools://knowledge/diagnostic-routing',
    ]);
  });

  it('includes whitelisted domain writes by default for a supported mod', () => {
    expect(fallbackBridgeTools(project('mod'), true).length).to.be.greaterThan(7);
    expect(fallbackBridgeTools(project('mod'), true).some(tool => tool.name === 'write_localisation')).to.equal(true);
  });
});
