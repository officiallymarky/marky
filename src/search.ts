/**
 * The find/replace panel: a fixed overlay shared by both editing surfaces.
 * The rich editor is driven through its `FindHandle`; raw mode gets a
 * textarea-backed surface that keeps the textarea's native undo by replacing
 * selections with `execCommand("insertText")`.
 */
import { findTextMatches, type FindHandle, type FindQuery, type StringMatch } from "./find";

export interface SearchPanelDeps {
  rawEditor: HTMLTextAreaElement;
  /** The active editing surface. */
  surface: () => "rich" | "raw";
  /** The rich editor's find API; null while no editor exists. */
  rich: () => FindHandle | null;
  /** Focus the underlying editing surface (on close). */
  focusSurface: () => void;
  /** UI error path (e.g. a failed raw-mode replacement). */
  showError: (error: unknown) => void;
}

export interface SearchPanel {
  open(withReplace: boolean): void;
  isOpen(): boolean;
  /** Re-applies the current query to the active surface. */
  retarget(): void;
  /** Refreshes the match count (call after document edits). */
  refresh(): void;
}

interface Surface
  extends Pick<
    FindHandle,
    | "setQuery"
    | "count"
    | "next"
    | "prev"
    | "replaceCurrent"
    | "replaceAll"
  > {
  /** Recomputes matches after an outside edit (raw mode only). */
  rescan?(): void;
}

/** Textarea-backed find/replace for raw mode. */
function createRawSurface(editor: HTMLTextAreaElement): Surface {
  let query: FindQuery | null = null;
  let matches: StringMatch[] = [];
  let current = -1;

  const scan = (): void => {
    matches = query?.needle
      ? findTextMatches(editor.value, query.needle, query.caseSensitive)
      : [];
  };

  /** Selects a match, scrolling to it, without stealing focus from the panel. */
  const select = (i: number): void => {
    const m = matches[i];
    const active = document.activeElement;
    editor.focus();
    editor.setSelectionRange(m.start, m.end);
    if (active instanceof HTMLElement && active !== editor) active.focus();
  };

  /** First match starting at/after `pos`, else the first, else none. */
  const from = (pos: number): number => {
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].start >= pos) return i;
    }
    return matches.length ? 0 : -1;
  };

  const swap = (text: string): void => {
    if (!document.execCommand("insertText", false, text)) {
      throw new Error("Raw-mode replacement failed");
    }
  };

  return {
    setQuery(q) {
      query = q && q.needle ? q : null;
      scan();
      current = matches.length
        ? from(editor.selectionStart)
        : -1;
      if (current >= 0) select(current);
    },
    count() {
      return { total: matches.length, index: current + 1 };
    },
    next() {
      if (!matches.length) return;
      current = (current + 1) % matches.length;
      select(current);
    },
    prev() {
      if (!matches.length) return;
      current = current <= 0 ? matches.length - 1 : current - 1;
      select(current);
    },
    replaceCurrent(text) {
      if (current < 0) return false;
      const m = matches[current];
      editor.focus();
      editor.setSelectionRange(m.start, m.end);
      swap(text);
      // Next match: first one starting at/after the inserted text (no wrap,
      // so a replacement containing the needle is never re-replaced).
      current = -1;
      for (let i = 0; i < matches.length; i++) {
        if (matches[i].start >= m.start + text.length) {
          current = i;
          break;
        }
      }
      if (current >= 0) select(current);
      return true;
    },
    replaceAll(text) {
      if (!query?.needle) return 0;
      scan();
      const count = matches.length;
      if (!count) return 0;
      editor.focus();
      // Descending order keeps earlier (smaller) offsets valid.
      for (let i = count - 1; i >= 0; i--) {
        const m = matches[i];
        editor.setSelectionRange(m.start, m.end);
        swap(text);
      }
      scan();
      current = -1;
      return count;
    },
    rescan: scan,
  };
}

export function createSearchPanel(deps: SearchPanelDeps): SearchPanel {
  const root = document.getElementById("find-bar")!;
  const findInput = document.getElementById("find-input") as HTMLInputElement;
  const findCount = document.getElementById("find-count")!;
  const caseBtn = document.getElementById("find-case") as HTMLButtonElement;
  const prevBtn = document.getElementById("find-prev") as HTMLButtonElement;
  const nextBtn = document.getElementById("find-next") as HTMLButtonElement;
  const closeBtn = document.getElementById("find-close") as HTMLButtonElement;
  const replaceToggle = document.getElementById(
    "replace-toggle",
  ) as HTMLButtonElement;
  const replaceRow = document.getElementById("replace-row")!;
  const replaceInput = document.getElementById(
    "replace-input",
  ) as HTMLInputElement;
  const replaceOneBtn = document.getElementById(
    "replace-one",
  ) as HTMLButtonElement;
  const replaceAllBtn = document.getElementById(
    "replace-all",
  ) as HTMLButtonElement;

  const rawSurface = createRawSurface(deps.rawEditor);

  let open = false;
  let replaceVisible = false;
  let query: FindQuery = { needle: "", caseSensitive: false };

  const active = (): Surface | null =>
    deps.surface() === "raw" ? rawSurface : deps.rich();

  /** Runs a surface action, routing failures to the UI error path. */
  const run = (action: (s: Surface) => void): void => {
    const s = active();
    if (!s) return;
    try {
      action(s);
    } catch (error) {
      deps.showError(error);
    }
    refresh();
  };

  function refresh(): void {
    if (deps.surface() === "raw") rawSurface.rescan?.();
    const s = active();
    const c = s ? s.count() : { total: 0, index: 0 };
    findCount.textContent = c.total
      ? `${Math.min(c.index, c.total)} of ${c.total}`
      : query.needle
        ? "No results"
        : "";
    findCount.classList.toggle("no-results", !c.total && query.needle !== "");
  }

  function retarget(): void {
    const s = active();
    if (s) s.setQuery(query.needle ? { ...query } : null);
    refresh();
  }

  findInput.addEventListener("input", () => {
    query = { needle: findInput.value, caseSensitive: query.caseSensitive };
    run((s) => s.setQuery(query.needle ? { ...query } : null));
  });

  caseBtn.addEventListener("click", () => {
    query.caseSensitive = !query.caseSensitive;
    caseBtn.setAttribute("aria-pressed", String(query.caseSensitive));
    run((s) => s.setQuery(query.needle ? { ...query } : null));
  });

  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const s = active();
    if (!s) return;
    if (event.target === replaceInput && !event.shiftKey) {
      run((t) => void t.replaceCurrent(replaceInput.value));
    } else if (event.shiftKey) {
      run((t) => t.prev());
    } else {
      run((t) => t.next());
    }
  });

  /** Shows/hides the replace row; Ctrl+H opens the panel with it visible. */
  const setReplaceVisible = (visible: boolean): void => {
    replaceVisible = visible;
    replaceRow.hidden = !visible;
    replaceToggle.setAttribute("aria-expanded", String(visible));
  };

  nextBtn.addEventListener("click", () => run((s) => s.next()));
  prevBtn.addEventListener("click", () => run((s) => s.prev()));
  replaceOneBtn.addEventListener("click", () =>
    run((s) => void s.replaceCurrent(replaceInput.value)),
  );
  replaceAllBtn.addEventListener("click", () =>
    run((s) => void s.replaceAll(replaceInput.value)),
  );
  replaceToggle.addEventListener("click", () =>
    setReplaceVisible(!replaceVisible),
  );
  closeBtn.addEventListener("click", () => close());

  function openPanel(withReplace: boolean): void {
    open = true;
    setReplaceVisible(replaceVisible || withReplace);
    root.hidden = false;
    retarget();
    findInput.focus();
    findInput.select();
  }

  function close(): void {
    open = false;
    root.hidden = true;
    const s = active();
    if (s) s.setQuery(null);
    deps.focusSurface();
  }

  return {
    open: openPanel,
    isOpen: () => open,
    retarget,
    refresh,
  };
}
