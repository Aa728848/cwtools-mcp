export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'information' | 'hint';
export type DiagnosticsFreshness = 'fresh' | 'pending' | 'stale' | 'unavailable';

export interface DiagnosticRecord {
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity: DiagnosticSeverity;
  code?: string;
  message: string;
  source?: string;
}

export interface DiagnosticsFilter {
  file?: string;
  severity?: DiagnosticSeverity;
  limit?: number;
}

export interface DiagnosticsQueryResult {
  ok: boolean;
  status: DiagnosticsFreshness;
  diagnostics: DiagnosticRecord[];
  totalCount?: number;
  truncated?: boolean;
  suppressedCount?: number;
  freshness?: {
    value: DiagnosticsFreshness;
    pendingKinds: string[];
    validatedVersion?: number;
    epoch?: number;
    updatedAt?: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

/** Per-call context for a diagnostics query. `signal` cancels the backend work. */
export interface DiagnosticsQueryContext {
  signal?: AbortSignal;
}

export interface DiagnosticsHost {
  getDiagnostics(
    filter?: DiagnosticsFilter,
    context?: DiagnosticsQueryContext,
  ): Promise<DiagnosticsQueryResult>;
}

export function createUnavailableDiagnosticsHost(message = 'Diagnostics are not available without an LSP connection.'): DiagnosticsHost {
  return {
    async getDiagnostics() {
      return {
        ok: false,
        status: 'unavailable',
        diagnostics: [],
        error: {
          code: 'diagnostics_unavailable',
          message,
        },
      };
    },
  };
}
