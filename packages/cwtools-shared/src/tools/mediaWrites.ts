import * as path from 'path';
import type { ExternalCommandHost, HostServices, MediaToolSettingsHost } from '../host/hostServices';
import type { ExternalCommandRequest, ExternalCommandResult } from '../host/hostServices';
import { throwIfAborted } from '../host/lsp';
import { isPathInsideOrEqual, normalizeWorkspaceRoot } from '../safety/paths';
import { ensureToolWriteAllowed } from '../safety/writes';
import type { SharedToolResult } from './schema';
import type { DomainWriteContext } from './pdxWrites';

/**
 * Transport-neutral media conversion and mod-asset deployment.
 *
 * ImageMagick/ffmpeg are reached through an injected port so this package never
 * imports child_process, never builds a shell string, and never depends on the
 * VS Code settings that configure the binaries in the extension. Every path is
 * contained by the workspace, every output name is derived from a validated
 * basename, and nothing is ever deleted recursively.
 */

/** Optional host ports on top of the common HostServices surface. */
export interface MediaWritesHost extends HostServices {
  externalCommands?: ExternalCommandHost;
  mediaTools?: MediaToolSettingsHost;
}

export interface ConvertImageToDdsArgs {
  sourcePath: string;
  outputDir?: string;
  compression?: 'dxt5' | 'dxt1' | 'dxt3' | 'none';
  generateMipmaps?: boolean;
}

export interface ConvertAudioArgs {
  sourcePath: string;
  outputDir?: string;
  targetFormat: 'ogg' | 'wav';
  sampleRate?: number;
  channels?: number;
}

export interface DeployModAssetArgs {
  sourcePath: string;
  targetRelativePath: string;
  overwrite?: boolean;
}

export interface MediaConversionResult {
  success: boolean;
  message: string;
  outputFile?: string;
}

export interface DeployModAssetResult {
  success: boolean;
  message: string;
  finalPath?: string;
  writtenFiles?: string[];
}

const SOURCE = 'cwtools-domain-writes';
const CONVERSION_TIMEOUT_MS = 60_000;
const MAX_FILENAME_CHARS = 200;
const WAV_SAMPLE_RATES = new Set([8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000]);
const MAX_CHANNELS = 8;

export const CONVERT_IMAGE_TO_DDS_FIELDS = ['sourcePath', 'outputDir', 'compression', 'generateMipmaps'] as const;
export const CONVERT_AUDIO_FIELDS = ['sourcePath', 'outputDir', 'targetFormat', 'sampleRate', 'channels'] as const;
export const DEPLOY_MOD_ASSET_FIELDS = ['sourcePath', 'targetRelativePath', 'overwrite'] as const;

function failure(code: string, message: string): SharedToolResult {
  return { ok: false, status: 'error', source: SOURCE, error: { code, message } };
}

function rejected<T>(code: string, message: string): SharedToolResult<T> {
  return { ok: false, status: 'error', source: SOURCE, error: { code, message } };
}

function unsupported<T>(message: string, nextSteps: string[]): SharedToolResult<T> {
  return { ok: false, status: 'unavailable', source: SOURCE, error: { code: 'external_tool_unavailable', message }, nextSteps };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortLike(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function unsupportedFields(args: Record<string, unknown>, allowed: readonly string[], tool: string): string | undefined {
  const extra = Object.keys(args).filter(key => !allowed.includes(key));
  return extra.length > 0 ? tool + ' contains unsupported field(s): ' + extra.join(', ') : undefined;
}

function resolveInside(host: HostServices, inputPath: unknown): { ok: true; resolvedPath: string; relativePath: string } | { ok: false; message: string } {
  const trimmed = typeof inputPath === 'string' ? inputPath.trim() : '';
  if (!trimmed) return { ok: false, message: 'A file path is required.' };
  const root = normalizeWorkspaceRoot(host.workspaceRoot);
  const resolved = path.resolve(root, trimmed);
  if (!isPathInsideOrEqual(root, resolved)) return { ok: false, message: "Path '" + trimmed + "' is outside the workspace root." };
  return { ok: true, resolvedPath: resolved, relativePath: path.relative(root, resolved).replace(/\\/g, '/') };
}

/** A derived output file name must stay a plain file name inside its directory. */
function safeBaseName(sourcePath: string): { ok: true; name: string } | { ok: false; message: string } {
  const raw = path.basename(sourcePath, path.extname(sourcePath)).trim();
  if (!raw) return { ok: false, message: 'Source file name is empty; cannot derive an output name.' };
  if (raw.length > MAX_FILENAME_CHARS) return { ok: false, message: 'Source file name exceeds ' + MAX_FILENAME_CHARS + ' characters.' };
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(raw) || raw === '.' || raw === '..') {
    return { ok: false, message: "Source file name '" + raw + "' cannot be used as a safe output name." };
  }
  return { ok: true, name: raw };
}


function externalHost(host: HostServices): { commands?: ExternalCommandHost; settings?: MediaToolSettingsHost } {
  const candidate = host as MediaWritesHost;
  return { commands: candidate.externalCommands, settings: candidate.mediaTools };
}

async function runCommand(
  host: HostServices,
  request: Omit<ExternalCommandRequest, 'timeoutMs'>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const runner = externalHost(host).commands;
  if (!runner) {
    return { ok: false, message: 'This host does not expose an external command runner, so no conversion can be performed.' };
  }
  try {
    const result = await runner.run({ ...request, timeoutMs: CONVERSION_TIMEOUT_MS, ...(request.signal ? { signal: request.signal } : {}) });
    if (!result.success) {
      return { ok: false, message: (result.stderr ?? '').trim() || result.message || request.command + ' reported a failure.' };
    }
    return { ok: true };
  } catch (error) {
    if (isAbortLike(error)) throw error;
    return { ok: false, message: errorText(error) };
  }
}

async function resolveOutputDir(
  host: HostServices,
  args: Record<string, unknown>,
  sourcePath: string,
): Promise<{ ok: true; outDir: string } | { ok: false; message: string }> {
  if (args.outputDir === undefined || args.outputDir === '') {
    return { ok: true, outDir: path.dirname(sourcePath) };
  }
  const resolved = resolveInside(host, args.outputDir);
  if (!resolved.ok) return resolved;
  if (resolved.resolvedPath === sourcePath) {
    return { ok: false, message: 'outputDir must be a directory, not the source file.' };
  }
  return { ok: true, outDir: resolved.resolvedPath };
}

async function sourceExists(host: HostServices, sourcePath: string): Promise<boolean> {
  const read = await host.filesystem.readTextFile(sourcePath).catch(() => undefined);
  if (read?.exists) return true;
  const parent = await host.filesystem.list(path.dirname(sourcePath)).catch(() => undefined);
  return !!parent?.some(entry => entry.type === 'file' && path.join(path.dirname(sourcePath), entry.name) === sourcePath);
}

// ─── convert_image_to_dds ──────────────────────────────────────────────────

export async function convertImageToDdsWithHost(
  host: HostServices,
  args: Record<string, unknown>,
  context?: DomainWriteContext,
): Promise<SharedToolResult<MediaConversionResult>> {
  const denied = ensureToolWriteAllowed(host, 'convert_image_to_dds');
  if (denied) return denied as SharedToolResult<MediaConversionResult>;
  throwIfAborted(context?.signal);
  const unsupportedField = unsupportedFields(args, CONVERT_IMAGE_TO_DDS_FIELDS, 'convert_image_to_dds');
  if (unsupportedField) return rejected('invalid_arguments', unsupportedField);

  const compression = args.compression ?? 'dxt5';
  if (compression !== 'dxt5' && compression !== 'dxt1' && compression !== 'dxt3' && compression !== 'none') {
    return rejected('invalid_arguments', 'compression must be dxt5, dxt1, dxt3, or none.');
  }
  const generateMipmaps = args.generateMipmaps === true;

  const source = resolveInside(host, args.sourcePath);
  if (!source.ok) return rejected('outside_workspace', source.message);
  if (!(await sourceExists(host, source.resolvedPath))) {
    return rejected('source_not_found', 'Source file not found: ' + String(args.sourcePath));
  }
  const output = await resolveOutputDir(host, args, source.resolvedPath);
  if (!output.ok) return rejected('outside_workspace', output.message);
  const baseName = safeBaseName(source.resolvedPath);
  if (!baseName.ok) return rejected('invalid_source_name', baseName.message);
  const outFile = path.join(output.outDir, baseName.name + '.dds');
  if (!isPathInsideOrEqual(normalizeWorkspaceRoot(host.workspaceRoot), outFile)) {
    return rejected('outside_workspace', 'Derived output path escapes the workspace.');
  }
  if (context?.signal) throwIfAborted(context.signal);

  const { settings } = externalHost(host);
  const magick = settings?.imageMagickPath?.trim() || 'magick';
  const pass = await runCommand(host, {
    command: magick,
    args: ['convert', source.resolvedPath, '-define', 'dds:compression=' + compression, '-define', 'dds:mipmaps=' + (generateMipmaps ? 'true' : '0'), outFile],
    signal: context?.signal,
  });
  if (!pass.ok) {
    if (/ENOENT|not found|is not recognized/i.test(pass.message)) {
      return unsupported<MediaConversionResult>(
        'ImageMagick is not available: ' + pass.message,
        ['Install ImageMagick (https://imagemagick.org/) and put it on PATH, or configure the ImageMagick path for this host.'],
      );
    }
    return rejected('conversion_failed', 'ImageMagick conversion failed: ' + pass.message);
  }
  if (!(await sourceExists(host, outFile))) {
    return rejected('output_missing', 'Conversion completed but the output file was not found: ' + outFile);
  }
  return {
    ok: true,
    status: 'success',
    source: SOURCE,
    data: { success: true, message: 'Image converted to DDS (' + compression + ', mipmaps=' + generateMipmaps + '): ' + outFile, outputFile: outFile },
  };
}

// ─── convert_audio ─────────────────────────────────────────────────────────

export async function convertAudioWithHost(
  host: HostServices,
  args: Record<string, unknown>,
  context?: DomainWriteContext,
): Promise<SharedToolResult<MediaConversionResult>> {
  const denied = ensureToolWriteAllowed(host, 'convert_audio');
  if (denied) return denied as SharedToolResult<MediaConversionResult>;
  throwIfAborted(context?.signal);
  const unsupportedField = unsupportedFields(args, CONVERT_AUDIO_FIELDS, 'convert_audio');
  if (unsupportedField) return rejected('invalid_arguments', unsupportedField);

  const targetFormat = args.targetFormat;
  if (targetFormat !== 'ogg' && targetFormat !== 'wav') return rejected('invalid_arguments', 'targetFormat must be "ogg" or "wav".');
  if (args.sampleRate !== undefined && (!Number.isSafeInteger(args.sampleRate) || !WAV_SAMPLE_RATES.has(args.sampleRate as number))) {
    return rejected('invalid_arguments', 'sampleRate must be one of ' + [...WAV_SAMPLE_RATES].join(', ') + '.');
  }
  if (args.channels !== undefined && (!Number.isSafeInteger(args.channels) || (args.channels as number) < 1 || (args.channels as number) > MAX_CHANNELS)) {
    return rejected('invalid_arguments', 'channels must be an integer between 1 and ' + MAX_CHANNELS + '.');
  }

  const source = resolveInside(host, args.sourcePath);
  if (!source.ok) return rejected('outside_workspace', source.message);
  if (!(await sourceExists(host, source.resolvedPath))) {
    return rejected('source_not_found', 'Source file not found: ' + String(args.sourcePath));
  }
  const output = await resolveOutputDir(host, args, source.resolvedPath);
  if (!output.ok) return rejected('outside_workspace', output.message);
  const baseName = safeBaseName(source.resolvedPath);
  if (!baseName.ok) return rejected('invalid_source_name', baseName.message);
  const outFile = path.join(output.outDir, baseName.name + '.' + targetFormat);
  if (!isPathInsideOrEqual(normalizeWorkspaceRoot(host.workspaceRoot), outFile)) {
    return rejected('outside_workspace', 'Derived output path escapes the workspace.');
  }

  const { settings } = externalHost(host);
  const ffmpeg = settings?.ffmpegPath?.trim() || 'ffmpeg';
  const command: string[] = ['-y', '-i', source.resolvedPath];
  if (targetFormat === 'ogg') {
    command.push('-c:a', 'libvorbis', '-q:a', '4');
    if (args.sampleRate !== undefined) command.push('-ar', String(args.sampleRate));
  } else {
    command.push('-acodec', 'pcm_s16le', '-ar', String((args.sampleRate as number | undefined) ?? 44100));
  }
  if (args.channels !== undefined) command.push('-ac', String(args.channels));
  command.push(outFile);

  const pass = await runCommand(host, { command: ffmpeg, args: command, signal: context?.signal });
  if (!pass.ok) {
    if (/ENOENT|not found|is not recognized/i.test(pass.message)) {
      return unsupported<MediaConversionResult>(
        'ffmpeg is not available: ' + pass.message,
        ['Install ffmpeg (https://ffmpeg.org/) and put it on PATH, or configure the ffmpeg path for this host.'],
      );
    }
    return rejected('conversion_failed', 'ffmpeg conversion failed: ' + pass.message);
  }
  if (!(await sourceExists(host, outFile))) {
    return rejected('output_missing', 'Conversion completed but the output file was not found: ' + outFile);
  }
  return {
    ok: true,
    status: 'success',
    source: SOURCE,
    data: { success: true, message: 'Audio converted to ' + targetFormat.toUpperCase() + ': ' + outFile, outputFile: outFile },
  };
}

// ─── deploy_mod_asset ──────────────────────────────────────────────────────

export async function deployModAssetWithHost(
  host: HostServices,
  args: Record<string, unknown>,
  context?: DomainWriteContext,
): Promise<SharedToolResult<DeployModAssetResult>> {
  const denied = ensureToolWriteAllowed(host, 'deploy_mod_asset');
  if (denied) return denied as SharedToolResult<DeployModAssetResult>;
  throwIfAborted(context?.signal);
  const unsupportedField = unsupportedFields(args, DEPLOY_MOD_ASSET_FIELDS, 'deploy_mod_asset');
  if (unsupportedField) return rejected('invalid_arguments', unsupportedField);
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
    return rejected('invalid_arguments', 'overwrite must be a boolean.');
  }

  const source = resolveInside(host, args.sourcePath);
  if (!source.ok) return rejected('outside_workspace', source.message);
  if (!(await sourceExists(host, source.resolvedPath))) {
    return rejected('source_not_found', 'Source file not found: ' + String(args.sourcePath));
  }
  const target = resolveInside(host, args.targetRelativePath);
  if (!target.ok) return rejected('outside_workspace', target.message);
  // A trailing separator or dot segment would aim at a directory; deployment copies one file.
  if (/[\\/]$/.test(String(args.targetRelativePath).trim()) || target.resolvedPath === normalizeWorkspaceRoot(host.workspaceRoot)) {
    return rejected('invalid_target', 'targetRelativePath must name a file inside the workspace.');
  }
  const targetDir = path.dirname(target.resolvedPath);
  const targetName = path.basename(target.resolvedPath);
  if (!targetName || targetName === '.' || targetName === '..') {
    return rejected('invalid_target', 'targetRelativePath must name a file.');
  }

  const listing = await host.filesystem.list(targetDir).catch(() => undefined);
  const existing = listing?.find(entry => entry.name === targetName);
  if (existing && existing.type === 'directory') {
    return rejected('invalid_target', 'Target path is an existing directory: ' + target.relativePath);
  }
  if (existing && args.overwrite !== true) {
    return rejected('target_exists', 'Target file already exists: ' + target.resolvedPath + '. Set overwrite=true to replace it.');
  }
  if (context?.signal) throwIfAborted(context.signal);

  try {
    if (host.filesystem.readBinaryFile && host.filesystem.writeBinaryFile) {
      const content = await host.filesystem.readBinaryFile(source.resolvedPath);
      await host.filesystem.writeBinaryFile(target.resolvedPath, content);
    } else {
      const content = await host.filesystem.readTextFile(source.resolvedPath);
      if (!content.exists) return rejected('source_unreadable', 'Source file could not be read: ' + source.relativePath);
      await host.filesystem.writeTextFile(target.resolvedPath, content.content);
    }
  } catch (error) {
    return rejected('deploy_failed', 'Failed to deploy asset: ' + errorText(error));
  }
  await host.indexing?.invalidate?.(target.resolvedPath);
  return {
    ok: true,
    status: 'success',
    source: SOURCE,
    data: {
      success: true,
      message: 'Asset deployed: ' + target.relativePath,
      finalPath: target.resolvedPath,
      writtenFiles: [target.resolvedPath],
    },
  };
}