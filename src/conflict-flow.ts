/**
 * Flows for a document whose file changed on disk: the save-time prompt
 * (overwrite, adopt the on-disk version, or keep editing) and the focus-time
 * check (adopt silently when nothing is unsaved, ask when there is).
 */
import type { ConflictKind, OpenedDocument } from "./document";

/** `alternate` adopts the on-disk version (or offers Save As when it is gone). */
export type ConflictChoice = "overwrite" | "alternate" | "keep-editing";

export interface SaveConflictDependencies {
  /** Asks the user what to do about the outside edit. */
  choose(kind: ConflictKind): Promise<ConflictChoice>;
  /** Writes the buffer over the version on disk. */
  overwrite(): Promise<boolean>;
  /** Replaces the buffer with the on-disk version. */
  alternate(): Promise<boolean>;
  showError(title: string, error: unknown): Promise<void>;
}

/**
 * Resolves a save that was stopped because the file changed on disk. True
 * when the document ends up in sync with disk (so a close may proceed).
 */
export async function resolveSaveConflict(
  kind: ConflictKind,
  dependencies: SaveConflictDependencies,
): Promise<boolean> {
  let choice: ConflictChoice;
  try {
    choice = await dependencies.choose(kind);
  } catch (error) {
    await dependencies.showError("Save failed", error);
    return false;
  }
  if (choice === "keep-editing") return false;
  try {
    return await (choice === "overwrite"
      ? dependencies.overwrite()
      : dependencies.alternate());
  } catch (error) {
    await dependencies.showError(
      choice === "overwrite" ? "Save failed" : "Reload failed",
      error,
    );
    return false;
  }
}

export interface ExternalChangeDependencies {
  isCurrent(): boolean;
  revision(): number;
  isDirty(): boolean;
  /** Reads the on-disk version without replacing the buffer. */
  load(): Promise<OpenedDocument>;
  /** True when the replacement ran, false when it was superseded. */
  replace(document: OpenedDocument): Promise<boolean>;
  /** Asked only when the buffer has unsaved edits to lose. */
  confirmReload(): Promise<boolean>;
  showError(title: string, error: unknown): Promise<void>;
}

export type ExternalChangeOutcome = "reloaded" | "kept-editing" | "not-handled";

/** Adopts an outside edit when the buffer is clean; asks when it is not. */
export async function handleExternalChange(
  dependencies: ExternalChangeDependencies,
): Promise<ExternalChangeOutcome> {
  try {
    if (!dependencies.isCurrent()) return "not-handled";
    const revision = dependencies.revision();
    const reload = !dependencies.isDirty() || (await dependencies.confirmReload());
    if (!dependencies.isCurrent() || dependencies.revision() !== revision) {
      return "not-handled";
    }
    if (!reload) return "kept-editing";
    const document = await dependencies.load();
    // A prompt or read must never authorize replacing edits made meanwhile.
    if (!dependencies.isCurrent() || dependencies.revision() !== revision) {
      return "not-handled";
    }
    return (await dependencies.replace(document)) ? "reloaded" : "not-handled";
  } catch (error) {
    await dependencies.showError("Reload failed", error);
    return "not-handled";
  }
}
