import "./styles.css";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
import "@milkdown/kit/prose/gapcursor/style/gapcursor.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { createEditor, type EditorHandle } from "./editor";
import {
  checkDocument,
  loadDocument,
  openDocumentDialog,
  saveDocument,
  type ConflictKind,
  type OpenedDocument,
} from "./document";
import {
  combineFrontmatter,
  getDocumentTitle,
  splitFrontmatter,
} from "./frontmatter";
import { DocumentState } from "./document-state";
import { createCloseRequestHandler } from "./close-flow";
import { runOpenFlow } from "./open-flow";
import { createSaveHandler, type SaveSession } from "./save-flow";
import {
  handleExternalChange,
  resolveSaveConflict,
  type ConflictChoice,
} from "./conflict-flow";
import {
  buildFrontMatterBlock,
  openFrontMatterWizard,
  readKnownFields,
  todayIsoDate,
  updateFrontMatterBlock,
} from "./frontmatter-wizard";
import { openTableDialog } from "./table-dialog";
import { createSearchPanel } from "./search";
import { readSpellEnabled, writeSpellEnabled } from "./harper";

const editorRoot = document.getElementById("editor")!;
const statusWords = document.getElementById("status-words")!;
const statusChars = document.getElementById("status-chars")!;
const statusFocus = document.getElementById("status-focus")!;
const statusPath = document.getElementById("status-path")!;
const statusRaw = document.getElementById("status-raw") as HTMLButtonElement;
const rawEditor = document.getElementById("raw-editor") as HTMLTextAreaElement;
const frontWrap = document.getElementById("frontmatter")!;
const frontEditor = document.getElementById(
  "frontmatter-editor",
) as HTMLTextAreaElement;

const appWindow = getCurrentWindow();

let handle: EditorHandle | null = null;
let documentSession: SaveSession = {
  path: null,
  name: "Untitled",
  state: new DocumentState(),
};
const saveCurrentDocument = createSaveHandler(() => documentSession, saveDocument);
let rawMode = false;
let frontContent: string | null = null;
let lastTitle = "";
let titleUpdates: Promise<void> = Promise.resolve();

const countWords = (text: string) => (text.match(/\S+/g) ?? []).length;

function refreshChrome() {
  const dirty = documentSession.state.dirty;
  const { front, body } = splitFrontmatter(documentSession.state.content);
  const displayName = getDocumentTitle(front, documentSession.name);
  const title = `${dirty ? "* " : ""}${displayName} — marky`;
  titleUpdates = titleUpdates
    .then(async () => {
      if (title === lastTitle) return;
      await invoke("set_window_title", { name: displayName, dirty });
      lastTitle = title;
    })
    .catch((error: unknown) => showError("Title update failed", error));
  // YAML keys are not prose; count only the markdown body.
  statusWords.textContent = `${countWords(body)} words`;
  statusChars.textContent = `${body.length} chars`;
  statusPath.textContent = documentSession.path ?? "unsaved";
  statusPath.title = documentSession.path ?? "";
}

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** Shows/hides the frontmatter panel and syncs its content. */
function updateFrontPanel() {
  document.body.classList.toggle("has-frontmatter", frontContent !== null);
  if (frontContent === null) {
    frontWrap.hidden = true;
    return;
  }
  frontWrap.hidden = false;
  if (frontEditor.value !== frontContent) frontEditor.value = frontContent;
  autoGrow(frontEditor);
}

function onUpdate(markdown: string) {
  documentSession.state.update(combineFrontmatter(frontContent, markdown));
  refreshChrome();
  if (searchPanel.isOpen()) searchPanel.refresh();
}

async function replaceDocument(doc: OpenedDocument) {
  documentSession = {
    path: doc.path,
    name: doc.name,
    state: new DocumentState(),
  };
  documentSession.state.load(doc.content);
  if (rawMode) {
    rawEditor.hidden = true;
    rawMode = false;
    statusRaw.classList.remove("active");
    statusRaw.setAttribute("aria-pressed", "false");
  }
  editorRoot.hidden = false;
  const split = splitFrontmatter(doc.content);
  frontContent = split.front;
  updateFrontPanel();
  await handle?.destroy();
  handle = await createEditor(editorRoot, split.body, onUpdate, showError);
  handle.focus();
  // The editor normalizes markdown on load (e.g. trailing paragraphs); treat
  // its canonical form — not the raw file bytes — as the saved baseline.
  const baseline = combineFrontmatter(frontContent, handle.getMarkdown());
  documentSession.state.load(baseline);
  refreshChrome();
  if (searchPanel.isOpen()) searchPanel.retarget(true);
}

async function confirmDiscard(): Promise<boolean> {
  if (!documentSession.state.dirty) return true;
  return ask(`"${documentSession.name}" has unsaved changes. Discard them?`, {
    title: "Unsaved changes",
    kind: "warning",
    okLabel: "Discard",
    cancelLabel: "Keep editing",
  });
}

async function doNew() {
  if (!(await confirmDiscard())) return;
  await replaceDocument({ path: null, name: "Untitled", content: "" });
}

async function doOpen() {
  if (!(await confirmDiscard())) return;
  await runOpenFlow({
    open: openDocumentDialog,
    replace: replaceDocument,
    showError,
  });
}

async function doFrontMatter() {
  if (rawMode) return; // raw mode edits the source directly
  const unsupported =
    "This front matter uses YAML syntax the dialog cannot rewrite safely. Use the front matter panel or raw mode instead.";
  if (frontContent !== null) {
    const { prefill, supported } = readKnownFields(frontContent);
    if (!supported) {
      await showError("Front Matter", new Error(unsupported));
      return;
    }
    const updated = await openFrontMatterWizard(prefill, {
      submitLabel: "Update",
    });
    if (!updated) return;
    const block = updateFrontMatterBlock(frontContent, updated);
    if (!block) {
      await showError("Front Matter", new Error(unsupported));
      return;
    }
    frontContent = block;
    updateFrontPanel();
    documentSession.state.update(
      combineFrontmatter(frontContent, handle?.getMarkdown() ?? ""),
    );
    refreshChrome();
    return;
  }
  const fields = await openFrontMatterWizard({ date: todayIsoDate() });
  if (!fields) return;
  frontContent = buildFrontMatterBlock(fields);
  updateFrontPanel();
  documentSession.state.update(
    combineFrontmatter(frontContent, handle?.getMarkdown() ?? ""),
  );
  refreshChrome();
}

async function showError(title: string, error: unknown): Promise<void> {
  console.error(title, error);
  try {
    await message(error instanceof Error ? error.message : String(error), {
      title,
      kind: "error",
    });
  } catch (dialogError) {
    console.error("Could not display error dialog", dialogError);
  }
}

/** Asks what to do about a file that changed on disk before it is overwritten. */
async function chooseConflictAction(
  kind: ConflictKind,
  name: string,
): Promise<ConflictChoice> {
  const removed = kind === "removed";
  const answer = await message(
    removed
      ? `"${name}" was moved or deleted on disk since you opened it.`
      : `"${name}" changed on disk since you opened it. Saving now would replace that version.`,
    {
      title: "File changed on disk",
      kind: "warning",
      buttons: {
        yes: removed ? "Recreate file" : "Overwrite",
        no: removed ? "Save As…" : "Reload from disk",
        cancel: "Keep editing",
      },
    },
  );
  if (answer === "Overwrite" || answer === "Recreate file") return "overwrite";
  if (answer === "Reload from disk" || answer === "Save As…") return "alternate";
  return "keep-editing";
}

/**
 * Saves the document, resolving an outside edit first. True when nothing is
 * left unsaved afterwards — written, or reloaded from disk.
 */
async function doSave(saveAs = false): Promise<boolean> {
  const result = await saveCurrentDocument(saveAs).catch(async (error: unknown) => {
    await showError("Save failed", error);
    return null;
  });
  if (!result) return false;
  if (result.kind === "saved") {
    refreshChrome();
    return true;
  }
  if (result.kind !== "conflict") return false;

  const conflict = result.conflict;
  const session = result.session;
  const path = result.path;
  return resolveSaveConflict(conflict, {
    choose: () =>
      session === documentSession
        ? chooseConflictAction(conflict, result.name)
        : Promise.resolve("keep-editing"),
    overwrite: async () => {
      const forced = await saveCurrentDocument(false, result);
      if (forced.kind === "saved") refreshChrome();
      return forced.kind === "saved";
    },
    alternate: async () => {
      if (session !== documentSession) return false;
      // A removed file cannot be reloaded; offer Save As instead.
      if (conflict === "removed") return doSave(true);
      const reloaded = await loadDocument(path);
      if (session !== documentSession) return false;
      await replaceDocument(reloaded);
      return true;
    },
    showError,
  });
}

async function setRawMode(on: boolean) {
  if (on === rawMode) return;
  rawMode = on;

  if (on) {
    // Focus mode is block-based; meaningless over a plain textarea.
    if (editorRoot.classList.contains("focus-mode")) toggleFocusMode();
    // Raw mode edits the whole document, frontmatter included.
    await handle?.destroy();
    handle = null;
    editorRoot.hidden = true;
    frontWrap.hidden = true;
    rawEditor.value = documentSession.state.content;
    rawEditor.hidden = false;
    rawEditor.focus();
  } else {
    const split = splitFrontmatter(rawEditor.value);
    frontContent = split.front;
    rawEditor.hidden = true;
    editorRoot.hidden = false;
    updateFrontPanel();
    handle = await createEditor(editorRoot, split.body, onUpdate, showError);
    handle.focus();
    // Normalize the baseline the same way a freshly opened document does.
    const baseline = combineFrontmatter(frontContent, handle.getMarkdown());
    documentSession.state.update(baseline);
  }

  statusRaw.classList.toggle("active", on);
  statusRaw.setAttribute("aria-pressed", String(on));
  refreshChrome();
  if (searchPanel.isOpen()) searchPanel.retarget(true);
}

function toggleFocusMode() {
  const on = !editorRoot.classList.contains("focus-mode");
  handle?.setFocusMode(on);
  statusFocus.hidden = !on;
}

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem("theme", dark ? "dark" : "light");
}

function toggleTheme() {
  applyTheme(!document.documentElement.classList.contains("dark"));
}

/**
 * The preference lives in storage so it also applies while raw mode has no
 * editor, and so a recreated editor picks it up.
 */
function toggleSpellCheck() {
  const on = !readSpellEnabled();
  writeSpellEnabled(on);
  handle?.spelling.setEnabled(on);
}

// Persisted theme wins; first run follows the OS preference and locks it in.
const storedTheme = localStorage.getItem("theme");
applyTheme(
  storedTheme
    ? storedTheme === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches,
);

/**
 * The find/replace panel works over whichever surface is active; the rich
 * editor's handle is recreated on document switches, so re-apply the query.
 */
const searchPanel = createSearchPanel({
  rawEditor,
  surface: () => (rawMode ? "raw" : "rich"),
  rich: () => handle?.search ?? null,
  focusSurface: () => {
    if (rawMode) {
      rawEditor.focus();
    } else {
      handle?.focus();
    }
  },
  showError: (error) => void showError("Find & Replace", error),
});

window.addEventListener("keydown", (event) => {
  if (event.key === "F7") {
    toggleSpellCheck();
    return;
  }
  if (event.key === "F8") {
    toggleFocusMode();
    return;
  }
  if (event.key === "F9") {
    toggleTheme();
    return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  switch (event.key.toLowerCase()) {
    case "s":
      event.preventDefault();
      void (event.shiftKey ? doSave(true) : doSave());
      break;
    case "o":
      event.preventDefault();
      void doOpen();
      break;
    case "n":
      event.preventDefault();
      void doNew();
      break;
    case "m":
      event.preventDefault();
      void doFrontMatter();
      break;
    case "f":
      event.preventDefault();
      searchPanel.open(false);
      break;
    case "h":
      event.preventDefault();
      searchPanel.open(true);
      break;
    case "/":
      event.preventDefault();
      void setRawMode(!rawMode);
      break;
  }
});

// Intercept window close while dirty: offer Save / Close without saving.
statusRaw.addEventListener("click", () => {
  void setRawMode(!rawMode);
});

rawEditor.addEventListener("input", () => {
  documentSession.state.update(rawEditor.value);
  refreshChrome();
  if (searchPanel.isOpen()) searchPanel.refresh();
});

frontEditor.addEventListener("input", () => {
  const value = frontEditor.value;
  frontContent = value.trim()
    ? value.endsWith("\n")
      ? value
      : `${value}\n`
    : null;
  documentSession.state.update(
    combineFrontmatter(frontContent, handle?.getMarkdown() ?? ""),
  );
  autoGrow(frontEditor);
  refreshChrome();
});

appWindow.onCloseRequested(
  createCloseRequestHandler({
    isDirty: () => documentSession.state.dirty,
    confirm: () =>
      message(`Save changes to "${documentSession.name}" before closing?`, {
        title: "Unsaved changes",
        kind: "warning",
        buttons: {
          yes: "Save",
          no: "Close without saving",
          cancel: "Keep editing",
        },
      }),
    save: () => doSave(),
    destroy: () => appWindow.destroy(),
    showError,
  }),
);

/**
 * Files change under the editor (another editor, a sync tool, git). On focus
 * adopt the on-disk version when nothing is unsaved, and ask before replacing
 * a buffer whose edits are still in progress. Saving is guarded separately, so
 * this is a heads-up rather than the last line of defense.
 */
const acknowledgedExternalChanges = new Map<string, string>();

appWindow.onFocusChanged(async ({ payload: focused }) => {
  // Raw mode edits the source textarea, which the rich-editor buffers below
  // cannot adopt; its saves are still checked by the save guard.
  if (!focused || rawMode) return;
  const path = documentSession.path;
  if (!path) return;
  const status = await checkDocument(path).catch((error: unknown) => {
    void showError("Could not check the file", error);
    return null;
  });
  if (!status || status.status !== "changed") return;
  // One prompt per outside version, not per focus change.
  if (acknowledgedExternalChanges.get(path) === status.token) return;
  acknowledgedExternalChanges.set(path, status.token);
  await handleExternalChange({
    isDirty: () => documentSession.state.dirty,
    adopt: async () => {
      // The mode or the document may have changed while checking.
      if (rawMode || documentSession.path !== path) return;
      await replaceDocument(await loadDocument(path));
    },
    confirmReload: () =>
      ask(
        `"${documentSession.name}" changed on disk. Reload it and discard your unsaved edits?`,
        {
          title: "File changed on disk",
          kind: "warning",
          okLabel: "Reload",
          cancelLabel: "Keep editing",
        },
      ),
    showError,
  });
});

/** Focuses the editor, then runs an insert action from the native menu. */
function insertFromMenu(
  run: (insert: NonNullable<EditorHandle["insert"]>) => void,
): void {
  if (!handle) return;
  handle.focus();
  run(handle.insert);
}

async function menuAction(action: string): Promise<void> {
  switch (action) {
    case "new":
      return doNew();
    case "open":
      return doOpen();
    case "save":
      return void doSave();
    case "save-as":
      return void doSave(true);
    case "front-matter":
      return doFrontMatter();
    case "find":
      return searchPanel.open(false);
    case "insert-table": {
      const dims = await openTableDialog();
      if (dims && handle) {
        handle.focus();
        handle.insert.table(dims.rows, dims.cols);
      }
      return;
    }
    case "insert-hr":
      return void insertFromMenu((i) => i.horizontalRule());
    case "insert-code-block":
      return void insertFromMenu((i) => i.codeBlock());
    case "insert-alert-note":
      return void insertFromMenu((i) => i.alert("note"));
    case "insert-alert-tip":
      return void insertFromMenu((i) => i.alert("tip"));
    case "insert-alert-important":
      return void insertFromMenu((i) => i.alert("important"));
    case "insert-alert-warning":
      return void insertFromMenu((i) => i.alert("warning"));
    case "insert-alert-caution":
      return void insertFromMenu((i) => i.alert("caution"));
    case "insert-footnote":
      return void insertFromMenu((i) => i.footnote());
    case "close":
      return appWindow.close();
    case "focus":
      return void toggleFocusMode();
    case "raw":
      return void setRawMode(!rawMode);
    case "spell":
      return void toggleSpellCheck();
    case "theme":
      return void toggleTheme();
    case "undo":
      handle?.undo();
      return;
    case "redo":
      handle?.redo();
      return;
    case "cut":
    case "copy":
    case "paste":
    case "select-all":
      document.execCommand(action === "select-all" ? "selectAll" : action);
      return;
  }
}

await listen<string>("menu-action", ({ payload }) => {
  void menuAction(payload);
});

let startupDoc: OpenedDocument | null = null;
try {
  startupDoc = await invoke<OpenedDocument | null>("startup_document");
} catch (error) {
  await showError("Open failed", error);
}
await replaceDocument(
  startupDoc ?? { path: null, name: "Untitled", content: "" },
);
