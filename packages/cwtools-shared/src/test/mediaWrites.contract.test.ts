import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createUnavailableDiagnosticsHost } from '../host/diagnostics';
import { createUnavailableLspHost } from '../host/lsp';
import type { HostServices } from '../host/hostServices';
import {
  convertAudioWithHost,
  convertImageToDdsWithHost,
  deployModAssetWithHost,
  type ExternalCommandRequest,
  type MediaWritesHost,
} from '../tools/mediaWrites';

// The media tools are only useful if they run in a host that owns the
// ImageMagick/ffmpeg processes. These tests pin the contract: argument vectors
// (never shell strings), workspace containment, bounded arguments, and the
// fact that a missing runner is reported instead of silently succeeding.

interface FakeRunner {
  requests: ExternalCommandRequest[];
  fail?: string;
  onRun?: (request: ExternalCommandRequest) => void;
}

function createMediaHost(root: string, runner: FakeRunner, options: { writesEnabled?: boolean } = {}): MediaWritesHost {
  return {
    workspaceRoot: root,
    readonlyMode: options.writesEnabled === false,
    writesEnabled: options.writesEnabled !== false,
    lsp: createUnavailableLspHost(),
    diagnostics: createUnavailableDiagnosticsHost(),
    filesystem: {
      async readTextFile(filePath) {
        if (!fs.existsSync(filePath)) return { content: '', hasBom: false, exists: false };
        const content = fs.readFileSync(filePath, 'utf8');
        return { content, hasBom: content.charCodeAt(0) === 0xfeff, exists: true };
      },
      async writeTextFile(filePath, content) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
      },
      async readBinaryFile(filePath) { return fs.readFileSync(filePath); },
      async writeBinaryFile(filePath, content) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
      },
      async list(dirPath) {
        if (!fs.existsSync(dirPath)) return [];
        return fs.readdirSync(dirPath, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' as const : 'file' as const,
        }));
      },
      async glob() { return []; },
    },
    now: () => Date.now(),
    log: () => undefined,
    externalCommands: {
      async run(request) {
        runner.requests.push(request);
        if (runner.fail) return { success: false, stderr: runner.fail };
        runner.onRun?.(request);
        return { success: true };
      },
    },
  };
}

function tempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupMediaFixture(root: string): void {
  const files = ['gfx/icon.png', 'gfx/icon.dds', 'sound/click.ogg', 'sound/click.wav', 'build/icon.dds', 'gfx/interface/icons/icon.dds'];
  for (const name of files) {
    try { fs.rmSync(path.join(root, name), { force: true }); } catch { /* ignored */ }
  }
  for (const name of ['gfx/interface/icons', 'gfx/interface', 'gfx', 'sound', 'build', '']) {
    try { fs.rmdirSync(path.join(root, name)); } catch { /* non-empty or absent */ }
  }
}
describe('convert_image_to_dds standalone contract', () => {
  it('passes an argument vector, never a shell string', async () => {
    const root = tempWorkspace('cwt-dds-');
    const source = path.join(root, 'gfx', 'icon.png');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'png', 'utf8');
    const runner: FakeRunner = { requests: [] };
    runner.onRun = request => { fs.writeFileSync(request.args[request.args.length - 1]!, 'dds', 'utf8'); };
    try {
      const result = await convertImageToDdsWithHost(createMediaHost(root, runner), {
        sourcePath: 'gfx/icon.png',
        compression: 'dxt1',
        generateMipmaps: true,
      });
      expect(result.ok).to.equal(true);
      expect(result.data?.outputFile).to.equal(path.join(root, 'gfx', 'icon.dds'));
      const request = runner.requests[0]!;
      expect(request.command).to.equal('magick');
      expect(request.args).to.deep.equal([
        'convert', source, '-define', 'dds:compression=dxt1', '-define', 'dds:mipmaps=true', path.join(root, 'gfx', 'icon.dds'),
      ]);
      expect(JSON.stringify(request.args)).to.not.include('&&');
    } finally {
      cleanupMediaFixture(root);
    }
  });

  it('rejects a source outside the workspace without running a command', async () => {
    const root = tempWorkspace('cwt-dds-');
    const runner: FakeRunner = { requests: [] };
    try {
      const result = await convertImageToDdsWithHost(createMediaHost(root, runner), { sourcePath: '../escape.png' });
      expect(result.ok).to.equal(false);
      expect(result.error?.code).to.equal('outside_workspace');
      expect(runner.requests).to.have.length(0);
    } finally {
      cleanupMediaFixture(root);
    }
  });

  it('reports a missing converter as unavailable rather than as a conversion failure', async () => {
    const root = tempWorkspace('cwt-dds-');
    const source = path.join(root, 'gfx', 'icon.png');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'png', 'utf8');
    const runner: FakeRunner = { requests: [], fail: 'magick: not found' };
    try {
      const result = await convertImageToDdsWithHost(createMediaHost(root, runner), { sourcePath: 'gfx/icon.png' });
      expect(result.ok).to.equal(false);
      expect(result.status).to.equal('unavailable');
      expect(result.error?.code).to.equal('external_tool_unavailable');
    } finally {
      cleanupMediaFixture(root);
    }
  });

  it('reports a host without a command runner instead of pretending to convert', async () => {
    const root = tempWorkspace('cwt-dds-');
    const source = path.join(root, 'gfx', 'icon.png');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'png', 'utf8');
    try {
      const host = createMediaHost(root, { requests: [] });
      delete host.externalCommands;
      const result = await convertImageToDdsWithHost(host, { sourcePath: 'gfx/icon.png' });
      expect(result.ok).to.equal(false);
      expect(result.error?.code).to.equal('conversion_failed');
      expect(String(result.error?.message)).to.include('external command runner');
    } finally {
      cleanupMediaFixture(root);
    }
  });
});

describe('convert_audio standalone contract', () => {
  it('encodes WAV with a validated sample rate', async () => {
    const root = tempWorkspace('cwt-audio-');
    const source = path.join(root, 'sound', 'click.ogg');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'ogg', 'utf8');
    const runner: FakeRunner = { requests: [] };
    runner.onRun = request => { fs.writeFileSync(request.args[request.args.length - 1]!, 'wav', 'utf8'); };
    try {
      const result = await convertAudioWithHost(createMediaHost(root, runner), {
        sourcePath: 'sound/click.ogg',
        targetFormat: 'wav',
        sampleRate: 22050,
        channels: 1,
      });
      expect(result.ok).to.equal(true);
      expect(result.data?.outputFile).to.equal(path.join(root, 'sound', 'click.wav'));
      expect(runner.requests[0]!.args).to.deep.equal([
        '-y', '-i', source, '-acodec', 'pcm_s16le', '-ar', '22050', '-ac', '1', path.join(root, 'sound', 'click.wav'),
      ]);
    } finally {
      cleanupMediaFixture(root);
    }
  });

  it('rejects an unbounded sample rate or channel count', async () => {
    const root = tempWorkspace('cwt-audio-');
    const runner: FakeRunner = { requests: [] };
    try {
      const badRate = await convertAudioWithHost(createMediaHost(root, runner), {
        sourcePath: 'a.ogg', targetFormat: 'wav', sampleRate: 12345,
      });
      expect(badRate.error?.code).to.equal('invalid_arguments');
      const badChannels = await convertAudioWithHost(createMediaHost(root, runner), {
        sourcePath: 'a.ogg', targetFormat: 'wav', channels: 64,
      });
      expect(badChannels.error?.code).to.equal('invalid_arguments');
      const badFormat = await convertAudioWithHost(createMediaHost(root, runner), {
        sourcePath: 'a.ogg', targetFormat: 'mp3',
      });
      expect(badFormat.error?.code).to.equal('invalid_arguments');
      expect(runner.requests).to.have.length(0);
    } finally {
      cleanupMediaFixture(root);
    }
  });
});

describe('deploy_mod_asset standalone contract', () => {
  it('copies a file to a workspace-relative target', async () => {
    const root = tempWorkspace('cwt-deploy-');
    const source = path.join(root, 'build', 'icon.dds');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'dds-bytes', 'utf8');
    try {
      const result = await deployModAssetWithHost(createMediaHost(root, { requests: [] }), {
        sourcePath: 'build/icon.dds',
        targetRelativePath: 'gfx/interface/icons/icon.dds',
      });
      expect(result.ok).to.equal(true);
      expect(fs.readFileSync(path.join(root, 'gfx', 'interface', 'icons', 'icon.dds'), 'utf8')).to.equal('dds-bytes');
      expect(result.data?.writtenFiles).to.deep.equal([path.join(root, 'gfx', 'interface', 'icons', 'icon.dds')]);
    } finally {
      cleanupMediaFixture(root);
    }
  });

  it('preserves non-UTF-8 bytes through the binary host port', async () => {
    const root = tempWorkspace('cwt-deploy-');
    const source = path.join(root, 'build', 'icon.dds');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const bytes = Buffer.from([0, 255, 254, 65, 128]);
    fs.writeFileSync(source, bytes);
    try {
      const result = await deployModAssetWithHost(createMediaHost(root, { requests: [] }), {
        sourcePath: 'build/icon.dds', targetRelativePath: 'gfx/icon.dds',
      });
      expect(result.ok).to.equal(true);
      expect(fs.readFileSync(path.join(root, 'gfx', 'icon.dds')).equals(bytes)).to.equal(true);
    } finally {
      cleanupMediaFixture(root);
    }
  });

  it('refuses to overwrite without overwrite=true', async () => {
    const root = tempWorkspace('cwt-deploy-');
    const source = path.join(root, 'build', 'icon.dds');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'new', 'utf8');
    const target = path.join(root, 'gfx', 'icon.dds');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old', 'utf8');
    try {
      const result = await deployModAssetWithHost(createMediaHost(root, { requests: [] }), {
        sourcePath: 'build/icon.dds',
        targetRelativePath: 'gfx/icon.dds',
      });
      expect(result.ok).to.equal(false);
      expect(result.error?.code).to.equal('target_exists');
      expect(fs.readFileSync(target, 'utf8')).to.equal('old');
      const forced = await deployModAssetWithHost(createMediaHost(root, { requests: [] }), {
        sourcePath: 'build/icon.dds',
        targetRelativePath: 'gfx/icon.dds',
        overwrite: true,
      });
      expect(forced.ok).to.equal(true);
      expect(fs.readFileSync(target, 'utf8')).to.equal('new');
    } finally {
      cleanupMediaFixture(root);
    }
  });

  it('rejects traversal targets and directory targets', async () => {
    const root = tempWorkspace('cwt-deploy-');
    const source = path.join(root, 'build', 'icon.dds');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'x', 'utf8');
    try {
      const escape = await deployModAssetWithHost(createMediaHost(root, { requests: [] }), {
        sourcePath: 'build/icon.dds',
        targetRelativePath: '../outside/icon.dds',
      });
      expect(escape.error?.code).to.equal('outside_workspace');
      const directory = await deployModAssetWithHost(createMediaHost(root, { requests: [] }), {
        sourcePath: 'build/icon.dds',
        targetRelativePath: 'gfx/',
      });
      expect(directory.error?.code).to.equal('invalid_target');
    } finally {
      cleanupMediaFixture(root);
    }
  });

  it('refuses every media write when the host has writes disabled', async () => {
    const root = tempWorkspace('cwt-deploy-');
    try {
      const result = await deployModAssetWithHost(createMediaHost(root, { requests: [] }, { writesEnabled: false }), {
        sourcePath: 'build/icon.dds',
        targetRelativePath: 'gfx/icon.dds',
      });
      expect(result.status).to.equal('denied');
      expect(result.error?.code).to.equal('read_only');
    } finally {
      cleanupMediaFixture(root);
    }
  });
});
