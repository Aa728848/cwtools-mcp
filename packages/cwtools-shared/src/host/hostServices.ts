import type { DiagnosticsHost } from './diagnostics';
import type { FilesystemHost } from './filesystem';
import type { IndexHost } from './indexing';
import type { LspHost } from './lsp';
import type { VanillaCacheStatus } from './vanillaCache';
import type { WorkspaceProjectKind } from '../generated/workspaceGameDetection';

export type HostLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Optional host capabilities used to disclose only tools with a real execution path. */
export type CwtoolsHostCapability =
  | 'project_init'
  | 'domain_writes'
  | 'archetypes'
  | 'diagnostic_settings'
  | 'ide_context'
  | 'visual_editor'
  | 'gui_capture';

export interface ProjectProfileHost {
  readProfile(): Promise<unknown | null>;
}

export interface GameKnowledgeHost {
  queryProfile?(args?: unknown): Promise<unknown>;
  queryHints?(args?: unknown): Promise<unknown>;
  queryDiagnosticKnowledge?(args?: unknown): Promise<unknown>;
}

export interface CompletionHost {
  getCompletionContext(args: unknown): Promise<unknown>;
}

export interface IdeHost {
  getContext(args: Record<string, unknown>, context?: { signal?: AbortSignal }): Promise<unknown>;
  openVisualEditor(args: Record<string, unknown>, context?: { signal?: AbortSignal }): Promise<unknown>;
  captureGuiPreview?(args: Record<string, unknown>, context?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface ExternalCommandRequest {
  command: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExternalCommandResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  message?: string;
}

export interface ExternalCommandHost {
  run(request: ExternalCommandRequest): Promise<ExternalCommandResult>;
}

export interface MediaToolSettingsHost {
  imageMagickPath?: string;
  ffmpegPath?: string;
}

export interface DiagnosticSettingsHost {
  getIgnoredKeys(): Promise<string[]>;
  removeIgnoredKey(key: string): Promise<void>;
}

export interface RulesConfigHost {
  gameId?: string;
  configDirs?: string[];
  readTextFile?(filePath: string): Promise<{ content: string; hasBom?: boolean; exists: boolean }>;
  listCwtFiles?(root: string, options?: { limit?: number }): Promise<string[]>;
}

export interface HostServices {
  workspaceRoot: string;
  readonlyMode: boolean;
  writesEnabled: boolean;
  allowedWriteTools?: ReadonlySet<string>;
  /** Undefined retains the static catalog; a provided set enables strict host filtering. */
  capabilities?: ReadonlySet<CwtoolsHostCapability>;
  lsp: LspHost;
  diagnostics: DiagnosticsHost;
  filesystem: FilesystemHost;
  indexing?: IndexHost;
  projectProfile?: ProjectProfileHost;
  knowledge?: GameKnowledgeHost;
  completion?: CompletionHost;
  rules?: RulesConfigHost;
  diagnosticSettings?: DiagnosticSettingsHost;
  ide?: IdeHost;
  externalCommands?: ExternalCommandHost;
  mediaTools?: MediaToolSettingsHost;
  vanillaCache?: VanillaCacheStatus;
  projectSupported?: boolean;
  projectSupportReason?: string;
  projectKind?: WorkspaceProjectKind;
  projectGameId?: string;
  projectEvidence?: string[];
  projectCandidates?: string[];
  now(): number;
  log(level: HostLogLevel, message: string, data?: unknown): void;
  dispose?(): void;
}
