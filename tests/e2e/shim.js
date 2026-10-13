/**
 * Tauri IPC shim for the browser harness. Loaded before `src/main.ts` so
 * `window.__TAURI_INTERNALS__` exists when the Tauri API modules capture it.
 *
 * It keeps an in-memory file store, records every invoke, and lets a scenario
 * drive the events the native shell would send (menu actions, focus changes,
 * close requests). Dialogs answer from a queue, defaulting to the cancel
 * button, so an unscripted prompt never discards anything.
 */
(() => {
  const callbacks = new Map();
  const listeners = [];
  let nextId = 1;

  const state = {
    calls: [],
    dialogs: [],
    problems: [],
    files: new Map(),
    answers: [],
    failures: new Map(),
    startup: null,
    recovery: [],
    check: { status: "unchanged", token: "1" },
    window: { destroyed: 0, closed: 0, titles: [] },
    recent: [],
    adopted: [],
  };

  const fileName = (path) => String(path).split("/").pop() || String(path);

  /** Button labels the caller would see, so a default answer cancels. */
  const labels = (args) => {
    const buttons = args?.buttons;
    if (buttons === "YesNo") return { cancel: "No" };
    if (buttons === "OkCancel") return { cancel: "Cancel" };
    if (buttons?.OkCancelCustom) return { cancel: buttons.OkCancelCustom[1] };
    if (buttons?.YesNoCancelCustom) return { cancel: buttons.YesNoCancelCustom[2] };
    if (buttons?.YesNoCustom) return { cancel: buttons.YesNoCustom[1] };
    return { cancel: "Cancel" };
  };

  const answerDialog = (args) => {
    if (state.answers.length) return state.answers.shift();
    return labels(args).cancel;
  };

  const handlers = {
    startup_document: () => state.startup,
    list_recovery: () => ({ snapshots: state.recovery, errors: [] }),
    release_recovery: () => null,
    write_recovery: ({ snapshot }) => {
      const existing = state.recovery.filter((entry) => entry.id !== snapshot.id);
      state.recovery = [
        ...existing,
        { ...snapshot, updatedAt: Date.now() },
      ];
      return null;
    },
    discard_recovery: ({ id }) => {
      state.recovery = state.recovery.filter((entry) => entry.id !== id);
      return null;
    },
    refresh_recent_documents: () => null,
    remember_document: ({ path }) => {
      state.recent = [path, ...state.recent.filter((entry) => entry !== path)].slice(0, 10);
      return null;
    },
    clear_recent_documents: () => {
      state.recent = [];
      return null;
    },
    set_window_title: ({ name, dirty }) => {
      state.window.titles.push({ name, dirty });
      return null;
    },
    set_menu_palette: () => null,
    adopt_document: ({ path }) => {
      state.adopted.push(path);
      return null;
    },
    check_document: () => ({ status: state.check.status, token: state.check.token }),
    load_document: ({ path }) => {
      if (!state.files.has(path)) {
        throw `Could not open ${fileName(path)}: No such file or directory (os error 2)`;
      }
      return { path, name: fileName(path), content: state.files.get(path) };
    },
    // The dialog itself lives in Rust: a scenario queues what Open returns.
    open_document: () => {
      const picked = state.open;
      state.open = null;
      return picked;
    },
    save_document: ({ path, content }) => {
      if (!path) return { path: null, name: null };
      state.files.set(path, content);
      state.recent = [path, ...state.recent.filter((entry) => entry !== path)].slice(0, 10);
      return { path, name: fileName(path) };
    },
    "plugin:dialog|message": (args) => {
      state.dialogs.push({ command: "message", ...args });
      return answerDialog(args);
    },
    "plugin:dialog|ask": (args) => {
      state.dialogs.push({ command: "ask", ...args });
      return answerDialog(args);
    },
    "plugin:event|listen": ({ event, handler }) => {
      listeners.push({ event, handler });
      return handler;
    },
    "plugin:event|unlisten": ({ eventId }) => {
      const index = listeners.findIndex((entry) => entry.handler === eventId);
      if (index >= 0) listeners.splice(index, 1);
      return null;
    },
    "plugin:event|emit": ({ event, payload }) => {
      emit(event, payload);
      return null;
    },
    "plugin:window|destroy": () => {
      state.window.destroyed += 1;
      return null;
    },
    "plugin:window|close": () => {
      state.window.closed += 1;
      return null;
    },
  };

  const emit = (event, payload) => {
    for (const entry of [...listeners]) {
      if (entry.event !== event) continue;
      const registered = callbacks.get(entry.handler);
      if (registered) registered.callback({ event, id: entry.handler, payload });
    }
  };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback(callback, once = false) {
      const id = nextId++;
      callbacks.set(id, { callback, once });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (path) => path,
    async invoke(command, args) {
      state.calls.push({ command, args });
      const failures = state.failures.get(command) ?? 0;
      if (failures > 0) {
        state.failures.set(command, failures - 1);
        throw `harness: ${command} was told to fail`;
      }
      const handler = handlers[command];
      if (!handler) return null;
      return handler(args ?? {});
    },
  };

  window.addEventListener("error", (event) => {
    state.problems.push(`uncaught error: ${event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    state.problems.push(`unhandled rejection: ${String(event.reason)}`);
  });

  /** Driving surface for the scenario script. */
  window.markyHarness = {
    state,
    emit,
    /** Puts a document in the shimmed file store. */
    file(path, content) {
      state.files.set(path, content);
    },
    /** Seeds the document the app opens at startup, as `marky notes.md` would. */
    startup(document) {
      state.startup = document;
      if (document?.path) state.files.set(document.path, document.content);
    },
    /** Queues the document the next Open dialog returns (null cancels). */
    pick(document) {
      state.open = document;
      if (document?.path) state.files.set(document.path, document.content);
    },
    /** Queues the next dialog answer (a button label). */
    answer(label) {
      state.answers.push(label);
    },
    /** Makes the next `count` calls to `command` reject. */
    fail(command, count = 1) {
      state.failures.set(command, count);
    },
    /** What `check_document` reports next. */
    report(status, token) {
      state.check = { status, token };
    },
    calls(command) {
      return state.calls.filter((entry) => entry.command === command);
    },
    lastCall(command) {
      return this.calls(command).at(-1);
    },
    reset() {
      state.calls.length = 0;
      state.dialogs.length = 0;
      state.problems.length = 0;
    },
  };
})();
