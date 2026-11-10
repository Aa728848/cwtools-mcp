import {
  detectWorkspaceProject,
  type WorkspaceProjectDetection,
  type WorkspaceProjectKind,
} from 'cwtools-shared';

export interface ProjectSupport {
  supported: boolean;
  reason: string;
  markers: string[];
  matchedAt?: string;
  kind: WorkspaceProjectKind;
  gameId?: string;
  candidates?: string[];
  detection: WorkspaceProjectDetection;
}

/** Resolve the current root, a strong ancestor, or exactly one immediate child. */
export function detectProjectSupport(
  workspaceRoot: string,
  options?: { game?: string; gamePath?: string },
): ProjectSupport {
  const detection = detectWorkspaceProject(workspaceRoot, gameId =>
    options?.gamePath && options.game === gameId ? options.gamePath : undefined);
  return {
    supported: detection.kind === 'mod' || detection.kind === 'vanilla' || detection.kind === 'cwt-only',
    reason: detection.reason,
    markers: [...detection.evidence],
    ...(detection.matchedAt ? { matchedAt: detection.matchedAt } : {}),
    kind: detection.kind,
    ...(detection.gameId ? { gameId: detection.gameId } : {}),
    ...(detection.candidates ? { candidates: [...detection.candidates] } : {}),
    detection,
  };
}
