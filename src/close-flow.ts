export interface CloseRequestEvent {
  preventDefault(): void;
}

export interface CloseRequestDependencies {
  isDirty(): boolean;
  confirm(): Promise<string>;
  save(): Promise<boolean>;
  destroy(): Promise<void>;
  showError(title: string, error: unknown): Promise<void>;
}

export function createCloseRequestHandler(
  dependencies: CloseRequestDependencies,
): (event: CloseRequestEvent) => Promise<void> {
  return async (event) => {
    if (!dependencies.isDirty()) return;
    event.preventDefault();

    let action: string;
    try {
      action = await dependencies.confirm();
    } catch (error) {
      await dependencies.showError("Could not confirm close", error);
      return;
    }

    if (action === "Save") {
      let saved: boolean;
      try {
        saved = await dependencies.save();
      } catch (error) {
        await dependencies.showError("Save failed", error);
        return;
      }
      if (!saved || dependencies.isDirty()) return;
    } else if (action !== "Close without saving") {
      return;
    }

    await dependencies.destroy();
  };
}
