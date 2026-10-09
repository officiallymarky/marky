import { invoke } from "@tauri-apps/api/core";

export interface OpenedDocument {
  path: string | null;
  name: string;
  content: string;
}

export interface SaveOutcome {
  path: string | null;
  name: string | null;
  /** Set when nothing was written because the file changed on disk. */
  conflict?: ConflictKind | null;
}

/** How a file differs from the version the app read. */
export type ConflictKind = "changed" | "removed";

export interface DocumentStatus {
  /** `untracked` means the app has no recorded version to compare against. */
  status: "unchanged" | "changed" | "removed" | "untracked";
  /** Fingerprint of the current on-disk version; de-duplicates prompts. */
  token: string;
}

/** Shows the native open dialog; resolves null when the user cancels. */
export function openDocumentDialog(): Promise<OpenedDocument | null> {
  return invoke("open_document");
}

/**
 * Saves `content`. With a known `path` it writes in place; with `null` it
 * raises the native Save As dialog. Resolves `path: null` when the dialog is
 * cancelled, and `conflict` when another program changed the file since it
 * was read — nothing is written unless `force` is set.
 */
export function saveDocument(
  path: string | null,
  content: string,
  force = false,
): Promise<SaveOutcome> {
  return invoke("save_document", { path, content, force });
}

/** Re-reads a known path; adopts the on-disk version after an outside edit. */
export function loadDocument(path: string): Promise<OpenedDocument> {
  return invoke("load_document", { path });
}

/**
 * Records the version the buffer just adopted as this document's save
 * baseline. Reads only stage a fingerprint, so a read whose result was
 * discarded cannot make the next save miss an outside edit.
 */
export function adoptDocument(path: string): Promise<void> {
  return invoke("adopt_document", { path });
}

/** Reports whether the file still matches the version the app read. */
export function checkDocument(path: string): Promise<DocumentStatus> {
  return invoke("check_document", { path });
}
