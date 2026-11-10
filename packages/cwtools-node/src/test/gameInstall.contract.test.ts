import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectGameInstall, detectSteamLibraries } from '../hosts/gameInstall';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cwt-install-${prefix}-`));
}

/** Plant a library entry the way Steam lays it out, and return the data directory. */
function plantInstall(library: string, folder: string, subdir?: string): string {
  const root = path.join(library, 'steamapps', 'common', folder);
  const data = subdir === undefined ? root : path.join(root, subdir);
  fs.mkdirSync(path.join(data, 'common'), { recursive: true });
  return data;
}

describe('MCP game install detection contract', () => {
  it('finds a Steam library install that holds a common directory', () => {
    const library = tmp('stellaris');
    const data = plantInstall(library, 'Stellaris');
    expect(detectGameInstall('stellaris', [library])).to.equal(data);
  });

  it('rejects a leftover folder without a common directory', () => {
    const library = tmp('leftover');
    fs.mkdirSync(path.join(library, 'steamapps', 'common', 'Stellaris'), { recursive: true });
    expect(detectGameInstall('stellaris', [library])).to.equal(undefined);
  });

  it('descends into the game subdirectory CK3 and Victoria 3 use', () => {
    const library = tmp('ck3');
    const data = plantInstall(library, 'Crusader Kings III', 'game');
    expect(detectGameInstall('ck3', [library])).to.equal(data);
  });

  it('tries the alternative folder names a game can have', () => {
    const library = tmp('vic2');
    const data = plantInstall(library, 'Victoria II');
    expect(detectGameInstall('vic2', [library])).to.equal(data);
  });

  it('covers every game the shared detector can report', () => {
    const library = tmp('all-games');
    for (const [game, folder, subdir] of [
      ['stellaris', 'Stellaris', undefined],
      ['hoi4', 'Hearts of Iron IV', undefined],
      ['eu4', 'Europa Universalis IV', undefined],
      ['eu5', 'Europa Universalis V', 'game'],
      ['ck2', 'Crusader Kings II', undefined],
      ['ck3', 'Crusader Kings III', 'game'],
      ['vic2', 'Victoria 2', undefined],
      ['vic3', 'Victoria 3', 'game'],
      ['imperator', 'ImperatorRome', 'game'],
    ] as const) {
      const data = plantInstall(library, folder, subdir);
      expect(detectGameInstall(game, [library])).to.equal(data);
    }
  });

  it('detects nothing for a generic or unknown game id', () => {
    const library = tmp('generic');
    plantInstall(library, 'Stellaris');
    expect(detectGameInstall('paradox', [library])).to.equal(undefined);
    expect(detectGameInstall(undefined, [library])).to.equal(undefined);
    expect(detectGameInstall('ck9', [library])).to.equal(undefined);
  });

  it('reads additional libraries out of libraryfolders.vdf', () => {
    const home = tmp('home');
    const steam = path.join(home, '.local', 'share', 'Steam');
    const second = tmp('second-library');
    fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
    fs.writeFileSync(
      path.join(steam, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"${second.replace(/\\/g, '\\\\')}"\n\t}\n}\n`,
    );
    const libraries = detectSteamLibraries({ platform: 'linux', home });
    expect(libraries).to.include(steam);
    expect(libraries).to.include(second);
  });
});
