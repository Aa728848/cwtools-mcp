import type { IdeHost } from 'cwtools-shared';
import { postNativeJson } from './nativeBridgeHttp';
import type { NativeBridgeManifest } from './nativeBridgeManifest';

interface JsonRpcResult { result?: unknown; error?: { message?: string } }

/** Explicitly allowlisted IDE operations exposed by an active editor host. */
export function createNativeBridgeIdeHost(manifest: NativeBridgeManifest): IdeHost {
  let requestId = 0;
  async function call<T>(method: string, args: Record<string, unknown>, context?: { signal?: AbortSignal }): Promise<T> {
    const payload = await postNativeJson(manifest.cwtoolsNativeRpcUrl, {
      jsonrpc: '2.0', id: ++requestId, method, params: { args },
    }, { token: manifest.token, signal: context?.signal }) as JsonRpcResult;
    if (payload.error) throw new Error(payload.error.message ?? 'Native IDE operation failed.');
    return payload.result as T;
  }
  return {
    getContext: (args, context) => call('cwtools/getIdeContext', args, context),
    openVisualEditor: (args, context) => call('cwtools/openVisualEditor', args, context),
    captureGuiPreview: (args, context) => call('cwtools/captureGuiPreview', args, context),
  };
}
