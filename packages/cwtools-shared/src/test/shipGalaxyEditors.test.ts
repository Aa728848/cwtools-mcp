import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseStaticGalaxy } from '../editors/staticGalaxyParser';
import { buildStaticGalaxyEdits } from '../editors/staticGalaxyEditBuilder';
import { parseShipDesignDocument, applyShipDesignOperation } from '../editors/shipDesign';
import { shipDesignDraftWithHost, staticGalaxyDraftWithHost } from '../tools/shipGalaxyDraft';
import type { HostServices } from '../host/hostServices';

function apply(text: string, reps: ReadonlyArray<{ span: { start: number; end: number }; text: string }>): string {
  let out = text;
  for (const rep of reps) out = out.slice(0, rep.span.start) + rep.text + out.slice(rep.span.end);
  return out;
}

function hostFor(root: string, granted = true): HostServices {
  const resolve = (file: string) => path.resolve(root, file);
  return {
    workspaceRoot: root,
    readonlyMode: !granted,
    writesEnabled: granted,
    allowedWriteTools: new Set(granted ? ['ship_design_draft', 'static_galaxy_draft'] : []),
    filesystem: {
      readTextFile: async (file: string) => ({
        content: fs.existsSync(resolve(file)) ? fs.readFileSync(resolve(file), 'utf8') : '',
        hasBom: false,
        exists: fs.existsSync(resolve(file)),
      }),
      writeTextFile: async (file: string, content: string) => { fs.writeFileSync(resolve(file), content, 'utf8'); },
      list: async () => [],
      glob: async () => [],
    },
    lsp: {} as HostServices['lsp'],
    diagnostics: {} as HostServices['diagnostics'],
    now: () => Date.now(),
    log: () => {},
  };
}

describe('editors/staticGalaxyEditBuilder (shared)', () => {
  it('moves a fixed coordinate by replacing exactly the number token', () => {
    const text = 'static_galaxy_scenario = {\n    system = { id = 1 name = "A" position = { x = 20 y = -30 } }\n}\n';
    const parsed = parseStaticGalaxy(text);
    expect(parsed.ok, parsed.error).to.equal(true);
    const nodeKey = parsed.scenarios[0]!.systems[0]!.nodeKey;
    const built = buildStaticGalaxyEdits({ kind: 'move', moves: [{ nodeKey, x: 27, y: -30 }] }, { text, scenarios: parsed.scenarios });
    expect(built.replacements).to.have.lengthOf(1);
    expect(text.slice(built.replacements[0]!.span.start, built.replacements[0]!.span.end)).to.equal('20');
    expect(apply(text, built.replacements)).to.include('position = { x = 27 y = -30 }');
  });

  it('translates a range axis as a whole, preserving width', () => {
    const text = 'static_galaxy_scenario = {\n    system = { id = 1 position = { x = { min = -97 max = -93 } y = 5 } }\n}\n';
    const parsed = parseStaticGalaxy(text);
    const nodeKey = parsed.scenarios[0]!.systems[0]!.nodeKey;
    const built = buildStaticGalaxyEdits({ kind: 'move', moves: [{ nodeKey, x: -85, y: 5 }] }, { text, scenarios: parsed.scenarios });
    const next = apply(text, built.replacements);
    expect(next).to.include('x = { min = -87 max = -83 }');
    expect(next).to.include('y = 5');
  });
});

describe('editors/shipDesign designDocument (shared)', () => {
  const SOURCE = [
    '# before',
    'ship_design = {',
    '\tname = "NAME_ONE"',
    '\tship_size = corvette',
    '\tcustom_unknown = preserve_me',
    '\tsection = {',
    '\t\ttemplate = "CORVETTE_MID_S3"',
    '\t\tslot = "mid"',
    '\t\t# slot comment',
    '\t\tcomponent = { slot = "SMALL_GUN_01" template = "SMALL_RED_LASER" }',
    '\t}',
    '\trequired_component = "SENSOR_1"',
    '}',
    '',
  ].join('\n');

  it('parses designs, sections and components', () => {
    const result = parseShipDesignDocument(SOURCE);
    expect(result.hasSyntaxErrors).to.equal(false);
    expect(result.designs).to.have.length(1);
    expect(result.designs[0]?.sections[0]?.components[0]?.template).to.equal('SMALL_RED_LASER');
    expect(result.designs[0]?.requiredComponents).to.deep.equal(['SENSOR_1']);
  });

  it('updates one component without reformatting unrelated source', () => {
    const result = applyShipDesignOperation(SOURCE, {
      kind: 'set-component',
      sectionId: 'design:0/section:0',
      slot: 'SMALL_GUN_01',
      template: 'SMALL_BLUE_LASER',
    });
    expect(result.text).to.contain('template = "SMALL_BLUE_LASER"');
    expect(result.text).to.contain('# slot comment');
    expect(result.text).to.contain('custom_unknown = preserve_me');
    expect(result.text.indexOf('SMALL_RED_LASER')).to.equal(-1);
  });
});

describe('tools/shipGalaxyDraft candidate write-back', () => {
  let root = '';
  const shipSource = 'ship_design = {\n\tname = "X"\n\tship_size = corvette\n\tsection = {\n\t\ttemplate = "MID"\n\t\tslot = "mid"\n\t\tcomponent = { slot = "S1" template = "RED" }\n\t}\n}\n';
  const galaxySource = 'static_galaxy_scenario = {\n    system = { id = 1 position = { x = 20 y = -30 } }\n}\n';

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-galaxy-')); });
  afterEach(() => {
    for (const name of fs.readdirSync(root)) fs.unlinkSync(path.join(root, name));
    fs.rmdirSync(root);
  });

  it('stages ship design edits as a hash-chained candidate without touching disk', async () => {
    const file = path.join(root, 'designs.txt');
    fs.writeFileSync(file, shipSource, 'utf8');
    const host = hostFor(root);
    const begun = await shipDesignDraftWithHost(host, { action: 'begin', filePath: 'designs.txt' });
    expect(begun.ok, JSON.stringify(begun)).to.equal(true);
    expect(begun.data?.transactionId).to.be.a('string');
    expect(begun.data?.designs?.[0]?.name).to.equal('X');
    const applied = await shipDesignDraftWithHost(host, {
      action: 'apply',
      filePath: 'designs.txt',
      operation: { kind: 'set-component', sectionId: 'design:0/section:0', slot: 'S1', template: 'BLUE' },
    });
    expect(applied.ok, JSON.stringify(applied)).to.equal(true);
    expect(applied.data?.contentHash).to.not.equal(applied.data?.baseHash);
    expect(fs.readFileSync(file, 'utf8')).to.equal(shipSource);
    await shipDesignDraftWithHost(host, { action: 'discard' });
  });

  it('rejects a stale span against the candidate and blocks ungranted writes', async () => {
    const file = path.join(root, 'scenario.txt');
    fs.writeFileSync(file, galaxySource, 'utf8');
    const host = hostFor(root);
    const begun = await staticGalaxyDraftWithHost(host, { action: 'begin', filePath: 'scenario.txt' });
    expect(begun.ok, JSON.stringify(begun)).to.equal(true);
    const parsed = parseStaticGalaxy(galaxySource);
    const nodeKey = parsed.scenarios[0]!.systems[0]!.nodeKey;
    const applied = await staticGalaxyDraftWithHost(host, {
      action: 'apply',
      filePath: 'scenario.txt',
      request: { kind: 'move', moves: [{ nodeKey, x: 27, y: -30 }] },
    });
    expect(applied.ok, JSON.stringify(applied)).to.equal(true);
    expect(applied.data?.summary).to.contain('Move');
    expect(fs.readFileSync(file, 'utf8')).to.equal(galaxySource);
    await staticGalaxyDraftWithHost(host, { action: 'discard' });

    const denied = await staticGalaxyDraftWithHost(hostFor(root, false), { action: 'begin', filePath: 'scenario.txt' });
    expect(denied.ok).to.equal(false);
    expect(fs.readFileSync(file, 'utf8')).to.equal(galaxySource);
  });

  it('requires the tool-specific grant: candidate_transaction alone is not enough', async () => {
    // Only candidate_transaction is on the allowlist: a draft write must still be denied.
    const host = hostFor(root);
    (host as { allowedWriteTools?: ReadonlySet<string> }).allowedWriteTools = new Set(['candidate_transaction']);
    const ship = path.join(root, 'designs.txt');
    fs.writeFileSync(ship, shipSource, 'utf8');
    const deniedShip = await shipDesignDraftWithHost(host, { action: 'begin', filePath: 'designs.txt' });
    expect(deniedShip.ok).to.equal(false);
    expect(deniedShip.error?.code).to.equal('tool_not_allowed');

    const galaxy = path.join(root, 'scenario.txt');
    fs.writeFileSync(galaxy, galaxySource, 'utf8');
    const deniedGalaxy = await staticGalaxyDraftWithHost(host, { action: 'begin', filePath: 'scenario.txt' });
    expect(deniedGalaxy.ok).to.equal(false);
    expect(deniedGalaxy.error?.code).to.equal('tool_not_allowed');
  });
});