import { createAbortError, isAbortError } from 'cwtools-shared';

const MAX_NATIVE_RESPONSE_BYTES = 1_000_000;

export class NativeBridgeUnavailableError extends Error {
  readonly code = 'active_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'NativeBridgeUnavailableError';
  }
}

export class NativeBridgeResponseError extends Error {
  readonly code = 'invalid_bridge_response';
  constructor(message: string) {
    super(message);
    this.name = 'NativeBridgeResponseError';
  }
}

export interface NativeHttpOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  token: string;
}

/** Small bounded native HTTP transport shared by discovery and LSP calls. */
export async function getNativeJson(url: string, options: NativeHttpOptions): Promise<unknown> {
  return requestNativeJson(url, 'GET', undefined, options);
}

export async function postNativeJson(url: string, body: unknown, options: NativeHttpOptions): Promise<unknown> {
  return requestNativeJson(url, 'POST', body, options);
}

async function requestNativeJson(url: string, method: 'GET' | 'POST', body: unknown, options: NativeHttpOptions): Promise<unknown> {
  if (options.signal?.aborted) throw createAbortError(options.signal.reason instanceof Error ? options.signal.reason.message : undefined);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let timedOut = false;
  try {
    if (options.signal) {
      onAbort = () => { controller.abort(options.signal!.reason); };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? 20_000);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > MAX_NATIVE_RESPONSE_BYTES) {
      throw new NativeBridgeResponseError('Native bridge response exceeds the 1 MiB limit.');
    }
    if (!response.ok) {
      throw new NativeBridgeUnavailableError(`Native bridge HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new NativeBridgeResponseError('Native bridge returned malformed JSON.');
    }
  } catch (error) {
    if (isAbortError(error) && !timedOut) throw error;
    if (timedOut) throw new NativeBridgeUnavailableError('Native bridge request timed out.');
    if (error instanceof NativeBridgeUnavailableError || error instanceof NativeBridgeResponseError) throw error;
    if (isAbortError(error)) throw error;
    throw new NativeBridgeUnavailableError(error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}
