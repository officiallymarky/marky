import type { ConflictKind, SaveOutcome } from "./document";
import type { DocumentState } from "./document-state";

export interface SaveSession {
  path: string | null;
  name: string;
  state: DocumentState;
}

/** The document and exact destination whose guarded save was refused. */
export interface SaveConflict {
  kind: "conflict";
  conflict: ConflictKind;
  session: SaveSession;
  path: string;
  name: string;
}

/**
 * Outcome of a save attempt. `stale` means the document was replaced by
 * another one while the save ran, so its result must not authorize closing.
 */
export type SaveResult =
  | { kind: "saved" }
  | { kind: "cancelled" }
  | { kind: "stale" }
  | SaveConflict;

/** Serializes all saves, retaining the document and snapshot that requested each one. */
export function createSaveHandler(
  currentDocument: () => SaveSession,
  write: (
    path: string | null,
    content: string,
    force: boolean,
  ) => Promise<SaveOutcome>,
): (saveAs?: boolean, overwrite?: SaveConflict) => Promise<SaveResult> {
  let pending: Promise<void> = Promise.resolve();

  return (saveAs = false, overwrite?: SaveConflict) => {
    const document = overwrite?.session ?? currentDocument();
    const content = document.state.content;
    const result = pending.then(async (): Promise<SaveResult> => {
      // Recheck at execution time: an overwrite may wait behind another save.
      if (overwrite && document !== currentDocument()) return { kind: "stale" };
      // A preceding Save As may have assigned this document a new path.
      const path = overwrite ? overwrite.path : saveAs ? null : document.path;
      const outcome = await write(path, content, overwrite !== undefined);
      if (!outcome.path) return { kind: "cancelled" };
      if (outcome.conflict) {
        if (document !== currentDocument()) return { kind: "stale" };
        return {
          kind: "conflict",
          conflict: outcome.conflict,
          session: document,
          path: outcome.path,
          name: outcome.name ?? document.name,
        };
      }
      document.path = outcome.path;
      document.name = outcome.name ?? document.name;
      document.state.markSaved(content);
      return document === currentDocument() ? { kind: "saved" } : { kind: "stale" };
    });
    // Callers receive failures; a failed save must not poison the queue.
    pending = result.then(() => {}, () => {});
    return result;
  };
}
