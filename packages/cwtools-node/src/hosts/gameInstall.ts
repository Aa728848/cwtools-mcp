import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Steam/Paradox install discovery.
 *
 * Ported from the VS Code extension so a caller that leaves the game path
 * empty still finds the vanilla data: the same Steam libraries (registry entry
 * plus `libraryfolders.vdf`), the same per-game folder names, and the same
 * requirement that the resolved directory really holds a `common` folder.
 */

/** Where one game lives under a Steam library. */
export interface GameInstallLayout {
  /** Folder name under `steamapps/common`. */
  folder: string;
  /** Folder names seen on some installs. */
  alternatives: readonly string[];
  /** Subdirectory holding the game data (CK3 and Victoria 3 keep it in `game`). */
  subdir?: string;
}

/** Per-game install layout; a game absent here is never auto-detected. */
export const GAME_INSTALL_LAYOUT: Readonly<Record<string, GameInstallLayout>> = {
  stellaris: { folder: 'Stellaris', alternatives: [] },
  hoi4: { folder: 'Hearts of Iron IV', alternatives: [] },
  eu4: { folder: 'Europa Universalis IV', alternatives: [] },
  eu5: { folder: 'Europa Universalis V', alternatives: [], subdir: 'game' },
  ck2: { folder: 'Crusader Kings II', alternatives: [] },
  ck3: { folder: 'Crusader Kings III', alternatives: [], subdir: 'game' },
  vic2: { folder: 'Victoria 2', alternatives: ['Victoria II'] },
  vic3: { folder: 'Victoria 3', alternatives: [], subdir: 'game' },
  imperator: { folder: 'ImperatorRome', alternatives: ['Imperator'], subdir: 'game' },
};

/** Platform sources the discovery reads; every field has a real default. */
export interface GameInstallDiscoveryOptions {
  platform?: NodeJS.Platform;
  home?: string;
}

/** Resolve the Steam install root from the Windows registry, else a known path. */
function steamRoot(options: GameInstallDiscoveryOptions): string | undefined {
  const platform = options.platform ?? os.platform();
  const home = options.home ?? os.homedir();
  if (platform === 'win32') {
    for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'HKLM\\SOFTWARE\\Valve\\Steam']) {
      try {
        const output = execFileSync('reg', ['query', key, '/v', 'InstallPath'], {
          encoding: 'utf8', timeout: 3000, windowsHide: true,
        });
        const match = /InstallPath\s+REG_SZ\s+(.+)/.exec(output);
        if (match?.[1]) return match[1].trim();
      } catch {
        // The key is absent on this machine; the fallback list below decides.
      }
    }
    for (const candidate of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', 'D:\\Steam', 'D:\\SteamLibrary']) {
      if (fs.existsSync(path.join(candidate, 'steam.exe')) || fs.existsSync(path.join(candidate, 'steamapps'))) {
        return candidate;
      }
    }
    return undefined;
  }
  if (platform === 'darwin') {
    const macPath = path.join(home, 'Library', 'Application Support', 'Steam');
    return fs.existsSync(macPath) ? macPath : undefined;
  }
  for (const linuxPath of [path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam')]) {
    if (fs.existsSync(linuxPath)) return linuxPath;
  }
  return undefined;
}

/** Every Steam library root: the install itself plus each `libraryfolders.vdf` entry. */
export function detectSteamLibraries(options: GameInstallDiscoveryOptions = {}): string[] {
  const root = steamRoot(options);
  if (!root) return [];
  const libraries = [root];
  const vdfPath = path.join(root, 'steamapps', 'libraryfolders.vdf');
  try {
    const content = fs.readFileSync(vdfPath, 'utf8');
    for (const match of content.matchAll(/"path"\s+"([^"]+)"/g)) {
      const raw = match[1];
      if (!raw) continue;
      const library = raw.replace(/\\\\/g, '\\');
      if (!libraries.includes(library) && fs.existsSync(library)) libraries.push(library);
    }
  } catch {
    // A missing or unreadable VDF only means the install root itself is the single library.
  }
  return libraries;
}

/** True when the directory really looks like a game install rather than a leftover folder. */
function isGameInstall(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'common')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find one game's vanilla install without asking the user for a path.
 * @param gameId - Paradox game id such as `stellaris`; a generic id detects nothing.
 * @param libraries - Steam libraries to search; discovered when omitted.
 * @returns the validated game data directory, or undefined when no install matches.
 */
export function detectGameInstall(
  gameId: string | undefined,
  libraries: readonly string[] = detectSteamLibraries(),
): string | undefined {
  const layout = gameId === undefined ? undefined : GAME_INSTALL_LAYOUT[gameId];
  if (!layout) return undefined;
  for (const folder of [layout.folder, ...layout.alternatives]) {
    for (const library of libraries) {
      const root = path.join(library, 'steamapps', 'common', folder);
      const data = layout.subdir ? path.join(root, layout.subdir) : root;
      if (isGameInstall(data)) return data;
    }
  }
  return undefined;
}
