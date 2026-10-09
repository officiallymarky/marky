export interface OpenFlowDependencies<T> {
  open(): Promise<T | null>;
  replace(document: T): Promise<void>;
  showError(title: string, error: unknown): Promise<void>;
  /** False once the document this open was authorized for is gone. */
  isCurrent(): boolean;
  /** Content and editor revision of that document; any edit changes it. */
  revision(): number;
}

/**
 * Opens a document and hands it to `replace`, unless the picker or the read
 * took long enough for the editor to move on. Edits typed meanwhile, or
 * another document transition, win over the late result: replacing the buffer
 * with it would discard that newer content and its recovery backup.
 */
export async function runOpenFlow<T>(
  dependencies: OpenFlowDependencies<T>,
): Promise<void> {
  const revision = dependencies.revision();
  let document: T | null;
  try {
    document = await dependencies.open();
  } catch (error) {
    await dependencies.showError("Open failed", error);
    return;
  }

  if (!document) return;
  if (!dependencies.isCurrent() || dependencies.revision() !== revision) return;
  await dependencies.replace(document);
}
