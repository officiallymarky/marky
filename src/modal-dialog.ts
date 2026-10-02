/** Reuses a modal, shares pending opens, and restores focus before resolving. */

interface ModalDom<T, E> {
  dialog: HTMLDialogElement;
  elements: E;
  /** Reads the submitted value from the fields; the cancel path resolves null. */
  readValue: () => T;
  onOpen?: () => void;
}

/** Builds lazily; a removed dialog is rebuilt on its next open. */
export function createModal<T, E>(
  build: () => ModalDom<T, E>,
): (prepare?: (elements: E) => void) => Promise<T | null> {
  let dom: ModalDom<T, E> | null = null;
  let request: Promise<T | null> | null = null;
  let resolveRequest: ((value: T | null) => void) | null = null;
  let restoreFocus: (() => void) | null = null;

  return (prepare) => {
    // A repeat trigger while the dialog is open must not call showModal twice.
    // A pending request whose dialog is closed or detached without the close
    // handler running (e.g. a page restore) must heal instead of wedging.
    if (request && dom?.dialog.open && dom.dialog.isConnected) return request;
    const { promise, resolve } = Promise.withResolvers<T | null>();
    request = promise;
    resolveRequest = resolve;

    if (!dom || !dom.dialog.isConnected) {
      dom = build();
      document.body.append(dom.dialog);
      const { dialog, readValue } = dom;
      dialog.querySelector("form")!.addEventListener("submit", (event) => {
        event.preventDefault();
        dialog.close("insert");
      });
      dialog
        .querySelector<HTMLButtonElement>("button[value=cancel]")!
        .addEventListener("click", () => dialog.close("cancel"));
      dialog.addEventListener("close", () => {
        const value = dialog.returnValue === "insert" ? readValue() : null;
        const restore = restoreFocus;
        const settled = resolveRequest;
        restoreFocus = null;
        resolveRequest = null;
        restore?.();
        settled?.(value);
      });
    }

    prepare?.(dom.elements);
    // Escape preserves returnValue, so clear any earlier submission.
    const previousFocus = document.activeElement;
    restoreFocus = () => (previousFocus as HTMLElement | null)?.focus();
    dom.dialog.returnValue = "";
    dom.dialog.showModal();
    dom.onOpen?.();
    return promise;
  };
}
