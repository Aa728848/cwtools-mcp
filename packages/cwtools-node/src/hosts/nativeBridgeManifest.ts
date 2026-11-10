import * as fs from 'fs';
import * as path from 'path';
import { isAbortError } from 'cwtools-shared';
import { getNativeJson, NativeBridgeResponseError } from './nativeBridgeHttp';
import { detectExtensionBridgeManifestPath } from './vscodeCache';

export interface NativeBridgeManifest {
  cwtoolsNativeRpcUrl: string;
  cwtoolsNativeHealthUrl?: string;
  token: string;
  pid: number;
  workspaceRoot: string;
}

export type NativeBridgeDiscovery =
  | { kind: 'available'; manifest: NativeBridgeManifest; readyAtMs?: number }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'incompatible'; reason: string };

export interface NativeDiscoveryOptions {
  manifestPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function sameWorkspace(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function unavailable(reason: string): NativeBridgeDiscovery {
  return { kind: 'unavailable', reason };
}

/** Discover an active native CWTools host for this exact resolved project root. */
export async function discoverNativeBridge(
  workspaceRoot: string,
  options: NativeDiscoveryOptions = {},
): Promise<NativeBridgeDiscovery> {
  const manifestPath = options.manifestPath ?? detectExtensionBridgeManifestPath();
  if (!manifestPath || !fs.existsSync(manifestPath)) return unavailable('No native CWTools bridge manifest is available.');
  let manifest: NativeBridgeManifest;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return unavailable('The native CWTools bridge manifest is malformed.');
    }
    manifest = parsed as NativeBridgeManifest;
  } catch {
    return unavailable('The native CWTools bridge manifest is malformed.');
  }
  if (
    typeof manifest.cwtoolsNativeRpcUrl !== 'string' || manifest.cwtoolsNativeRpcUrl.trim() === ''
    || (manifest.cwtoolsNativeHealthUrl !== undefined && typeof manifest.cwtoolsNativeHealthUrl !== 'string')
    || typeof manifest.token !== 'string' || manifest.token === ''
    || !Number.isInteger(manifest.pid) || manifest.pid <= 0
    || typeof manifest.workspaceRoot !== 'string' || manifest.workspaceRoot.trim() === ''
  ) {
    return unavailable('The manifest does not advertise a valid native CWTools host.');
  }
  try {
    const rpcUrl = new URL(manifest.cwtoolsNativeRpcUrl);
    if (rpcUrl.protocol !== 'http:' && rpcUrl.protocol !== 'https:') throw new Error('unsupported protocol');
    if (manifest.cwtoolsNativeHealthUrl) {
      const healthUrl = new URL(manifest.cwtoolsNativeHealthUrl);
      if (healthUrl.protocol !== 'http:' && healthUrl.protocol !== 'https:') throw new Error('unsupported protocol');
    }
  } catch {
    return unavailable('The manifest contains an invalid native CWTools URL.');
  }
  if (!sameWorkspace(workspaceRoot, manifest.workspaceRoot)) {
    return unavailable(`The active host belongs to a different workspace: ${manifest.workspaceRoot}`);
  }
  try {
    process.kill(manifest.pid, 0);
  } catch {
    return unavailable('The active CWTools host process is no longer running.');
  }
  const healthUrl = manifest.cwtoolsNativeHealthUrl
    ?? new URL('./healthz', manifest.cwtoolsNativeRpcUrl).toString();
  try {
    const value = await getNativeJson(healthUrl, {
      token: manifest.token,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { kind: 'incompatible', reason: 'The active host returned a malformed native health response.' };
    }
    const health = value as Record<string, unknown>;
    if (health.protocolVersion !== 1) return { kind: 'incompatible', reason: 'The active host uses an unsupported native protocol.' };
    if (health.active !== true) return unavailable('The CWTools LanguageClient is not active yet.');
    if (!sameWorkspace(workspaceRoot, String(health.workspaceRoot ?? ''))) {
      return unavailable('The active host changed to a different workspace.');
    }
    return {
      kind: 'available',
      manifest,
      ...(typeof health.readyAtMs === 'number' ? { readyAtMs: health.readyAtMs } : {}),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof NativeBridgeResponseError) return { kind: 'incompatible', reason: error.message };
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}
