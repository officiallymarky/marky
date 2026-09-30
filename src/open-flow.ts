export interface OpenFlowDependencies<T> {
  open(): Promise<T | null>;
  replace(document: T): Promise<void>;
  showError(title: string, error: unknown): Promise<void>;
}

export async function runOpenFlow<T>(
  dependencies: OpenFlowDependencies<T>,
): Promise<void> {
  let document: T | null;
  try {
    document = await dependencies.open();
  } catch (error) {
    await dependencies.showError("Open failed", error);
    return;
  }

  if (document) await dependencies.replace(document);
}
