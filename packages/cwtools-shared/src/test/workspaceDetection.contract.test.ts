import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyWorkspaceRoot, detectWorkspaceProject } from 'cwtools-shared';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-shared-detect-'));
}

function write(root: string, relative: string, content = ''): void {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe('generated workspace detection contract', () => {
  it('rejects a lone generic content directory', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'common'));
    expect(classifyWorkspaceRoot(root, () => undefined).kind).to.equal('unsupported');
  });

  it('accepts composite evidence only with an actual PDX payload', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'common'));
    fs.mkdirSync(path.join(root, 'events'));
    expect(classifyWorkspaceRoot(root, () => undefined).kind).to.equal('unsupported');
    write(root, 'events/sample.txt', 'namespace = sample');
    const result = classifyWorkspaceRoot(root, () => undefined);
    expect(result.kind).to.equal('mod');
    expect(result.gameId).to.equal(undefined);
  });

  it('detects CWT-only rules independently of a game model', () => {
    const root = tempRoot();
    for (let index = 0; index < 6; index++) write(root, `config/rule${index}.cwt`, '### rule');
    expect(classifyWorkspaceRoot(root, () => undefined).kind).to.equal('cwt-only');
  });

  it('returns all child candidates instead of selecting the first project', () => {
    const root = tempRoot();
    write(root, 'z-mod/descriptor.mod');
    write(root, 'a-mod/descriptor.mod');
    const result = detectWorkspaceProject(root, () => undefined);
    expect(result.kind).to.equal('ambiguous');
    expect(result.candidates).to.deep.equal([path.join(root, 'a-mod'), path.join(root, 'z-mod')]);
  });
});
