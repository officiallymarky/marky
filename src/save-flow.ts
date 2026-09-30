import type { ConflictKind, SaveOutcome } from "./document";
import type { DocumentState } from "./document-state";

export interface SaveSession {
  path: string | null;
  name: string;
  state: DocumentState;
}

/**
 * Outcome of a save attempt. `stale` means the document was replaced by
 * another one while the save ran, so its result must not authorize closing.
 */
export type SaveResult =
  | { kind: "saved" }
  | { kind: "cancelled" }
  | { kind: "stale" }
  | { kind: "conflict"; conflict: ConflictKind };

/** Serializes all saves, retaining the document and snapshot that requested each one. */
export function createSaveHandler(
  currentDocument: () => SaveSession,
  write: (
    path: string | null,
    content: string,
    force: boolean,
  ) => Promise<SaveOutcome>,
): (saveAs?: boolean, force?: boolean) => Promise<SaveResult> {
  let pending: Promise<void> = Promise.resolve();

  return (saveAs = false, force = false) => {
    const document = currentDocument();
    const content = document.state.content;
    const result = pending.then(async (): Promise<SaveResult> => {
      // A preceding Save As may have assigned this document a new path.
      const outcome = await write(saveAs ? null : document.path, content, force);
      if (outcome.conflict) {
        return { kind: "conflict", conflict: outcome.conflict };
      }
      if (!outcome.path) return { kind: "cancelled" };
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
