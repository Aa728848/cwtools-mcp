export interface LspCommandOptions {
  timeoutMs?: number;
  // Cooperative cancellation. Hosts must abort the in-flight request (or the
  // pending backend startup) and rethrow the abort error instead of converting
  // it into an `unavailable` result: a cancelled call is not an absent backend.
  signal?: AbortSignal;
}

export interface LspHost {
  executeCommand<T = unknown>(
    command: string,
    args?: unknown[],
    options?: LspCommandOptions,
  ): Promise<T>;
  request?<T = unknown>(
    method: string,
    params?: unknown,
    options?: LspCommandOptions,
  ): Promise<T>;
}

/** True for a DOMException/Error raised because an AbortSignal fired. */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { name?: unknown; code?: unknown };
  return record.name === 'AbortError' || record.code === 'ABORT_ERR';
}

/** Build the error a host rejects with when it stops work for an aborted signal. */
export function createAbortError(message = 'Operation was aborted.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Rethrow an abort error, ignoring anything else. Used to keep aborts out of `unavailable` paths. */
export function rethrowIfAborted(error: unknown): void {
  if (isAbortError(error)) throw error;
}

/** Throwing guard: clears the way for hosts that poll before each step. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason instanceof Error ? signal.reason.message : undefined);
}

export function createUnavailableLspHost(message = 'CWTools LSP is not connected.'): LspHost {
  return {
    async executeCommand<T = unknown>() {
      return {
        ok: false,
        status: 'unavailable',
        error: {
          code: 'lsp_unavailable',
          message,
        },
      } as T;
    },
    async request<T = unknown>() {
      return {
        ok: false,
        status: 'unavailable',
        error: {
          code: 'lsp_unavailable',
          message,
        },
      } as T;
    },
  };
}
