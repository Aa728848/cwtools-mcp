import {
  BACKEND_INCOMPATIBLE_CODE,
  checkRequiredCommands,
  createAbortError,
  isAbortError,
  parseHostCapabilities,
  type LspCommandOptions,
  type LspHost,
} from 'cwtools-shared';
import { postNativeJson } from './nativeBridgeHttp';
import type { NativeBridgeManifest } from './nativeBridgeManifest';
export type { LspHost } from 'cwtools-shared';

interface JsonRpcResult {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** LspHost backed by the active native CWTools extension host. */
export class NativeBridgeLspHost implements LspHost {
  private handshakePromise?: Promise<void>;
  private incompatible?: Error;
  private disposed = false;
  private requestId = 0;

  constructor(
    private readonly manifest: NativeBridgeManifest,
    private readonly readyAtMs?: number,
  ) {}

  get readyAtMsValue(): number | undefined {
    return this.readyAtMs;
  }

  async executeCommand<T = unknown>(command: string, args: unknown[] = [], options?: LspCommandOptions): Promise<T> {
    return this.call<T>('cwtools/executeCommand', { command, args }, options);
  }

  async request<T = unknown>(method: string, params?: unknown, options?: LspCommandOptions): Promise<T> {
    return this.call<T>('cwtools/lspRequest', { method, params }, options);
  }

  dispose(): void {
    this.disposed = true;
  }

  private async call<T>(method: string, params: unknown, options?: LspCommandOptions): Promise<T> {
    if (this.disposed) return this.unavailable('The active CWTools host connection is disposed.') as T;
    if (this.incompatible) return this.incompatibleResult(this.incompatible) as T;
    try {
      await this.ensureHandshake(options);
      const payload = await postNativeJson(this.manifest.cwtoolsNativeRpcUrl, {
        jsonrpc: '2.0',
        id: ++this.requestId,
        method,
        params,
      }, {
        token: this.manifest.token,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      }) as JsonRpcResult;
      if (payload.error) throw new Error(payload.error.message ?? 'Native CWTools request failed.');
      return payload.result as T;
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (this.incompatible) return this.incompatibleResult(this.incompatible) as T;
      return this.unavailable(error instanceof Error ? error.message : String(error)) as T;
    }
  }

  private async ensureHandshake(options?: LspCommandOptions): Promise<void> {
    if (this.incompatible) throw this.incompatible;
    if (!this.handshakePromise) this.handshakePromise = this.handshake(options);
    try {
      await this.handshakePromise;
    } catch (error) {
      // Transport failures may recover when the active host becomes available.
      if (!this.incompatible) this.handshakePromise = undefined;
      throw error;
    }
  }

  private async handshake(options?: LspCommandOptions): Promise<void> {
    const payload = await postNativeJson(this.manifest.cwtoolsNativeRpcUrl, {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'cwtools/executeCommand',
      params: { command: 'cwtools.ai.getHostCapabilities', args: [] },
    }, {
      token: this.manifest.token,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    }) as JsonRpcResult;
    if (payload.error) {
      const error = new Error(payload.error.message ?? 'Native host capability handshake failed.');
      this.incompatible = error;
      throw error;
    }
    const verdict = parseHostCapabilities(payload.result);
    const checked = verdict.ok ? checkRequiredCommands(verdict.capabilities) : verdict;
    if (!checked.ok) {
      const error = new Error(checked.message);
      this.incompatible = error;
      throw error;
    }
  }

  private incompatibleResult(error: Error): unknown {
    return {
      ok: false,
      status: 'unavailable',
      error: { code: BACKEND_INCOMPATIBLE_CODE, message: error.message },
    };
  }

  private unavailable(message: string): unknown {
    return {
      ok: false,
      status: 'unavailable',
      error: { code: 'active_unavailable', message },
    };
  }
}

export function createNativeBridgeLspHost(manifest: NativeBridgeManifest, readyAtMs?: number): NativeBridgeLspHost {
  return new NativeBridgeLspHost(manifest, readyAtMs);
}
