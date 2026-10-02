/**
 * The find/replace panel: a fixed overlay shared by both editing surfaces.
 * The rich editor is driven through its `FindHandle`; raw mode replaces
 * selections with `execCommand("insertText")`, whose input events feed the
 * document's shared undo timeline.
 */
import { findTextMatches, type FindHandle, type FindQuery, type StringMatch } from "./find.ts";

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
  /**
   * Start offset of the current match, the raw counterpart of the rich
   * surface's tracked `currentFrom` (null when there is none). Match indexes
   * are re-derived from it after every scan, so an edit that deletes or
   * shifts the tracked match never leaves a stale numeric index behind.
   */
  let currentFrom: number | null = null;
  /** Text at the last scan, for mapping the tracked position through edits. */
  let scannedText = editor.value;

  const scan = (): void => {
    matches = query?.needle
      ? findTextMatches(editor.value, query.needle, query.caseSensitive)
      : [];
    scannedText = editor.value;
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

  /** The match containing `pos`, else the nearest one before it, else none. */
  const locateAt = (pos: number): number => {
    let lastBefore = -1;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      if (m.start <= pos && pos <= m.end) return i;
      if (m.start < pos) lastBefore = i;
      if (m.start > pos) break;
    }
    return lastBefore;
  };

  /** Index of the tracked current match (−1 when there is none). */
  const locate = (): number =>
    currentFrom === null || !matches.length ? -1 : Math.max(0, locateAt(currentFrom));

  /** Maps the tracked position through the changed text without moving focus. */
  const rescan = (): void => {
    const text = editor.value;
    if (currentFrom !== null && text !== scannedText) {
      // The caret marks the edit's new end. Constrain the diff around it so
      // repeated text cannot make an edit near the start look like one at EOF.
      const caret = editor.selectionStart;
      const delta = text.length - scannedText.length;
      const startLimit = Math.max(0, caret - Math.max(0, delta));
      let start = 0;
      while (
        start < startLimit && start < scannedText.length && start < text.length &&
        scannedText[start] === text[start]
      ) start += 1;
      let oldEnd = scannedText.length;
      let newEnd = text.length;
      while (
        oldEnd > start && newEnd > Math.max(start, caret) &&
        scannedText[oldEnd - 1] === text[newEnd - 1]
      ) {
        oldEnd -= 1;
        newEnd -= 1;
      }
      if (currentFrom >= oldEnd) currentFrom += newEnd - oldEnd;
      else if (currentFrom >= start) currentFrom = newEnd;
    }
    scan();
    if (!matches.length) currentFrom = null;
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
      const idx = matches.length ? from(editor.selectionStart) : -1;
      currentFrom = idx >= 0 ? matches[idx].start : null;
      if (idx >= 0) select(idx);
    },
    count() {
      return { total: matches.length, index: locate() + 1 };
    },
    next() {
      if (!matches.length) return;
      const idx = (locate() + 1) % matches.length;
      currentFrom = matches[idx].start;
      select(idx);
    },
    prev() {
      if (!matches.length) return;
      const cur = locate();
      const idx = cur <= 0 ? matches.length - 1 : cur - 1;
      currentFrom = matches[idx].start;
      select(idx);
    },
    replaceCurrent(text) {
      const cur = locate();
      if (cur < 0) return false;
      const m = matches[cur];
      const after = m.start + text.length;
      editor.focus();
      editor.setSelectionRange(m.start, m.end);
      swap(text);
      // A synchronous input→refresh may already have rescanned; scanning is
      // idempotent, so recompute from the live text either way.
      scan();
      // Advance past the inserted text without wrapping onto the replacement.
      currentFrom = null;
      for (let i = 0; i < matches.length; i++) {
        if (matches[i].start >= after) {
          currentFrom = matches[i].start;
          select(i);
          break;
        }
      }
      return true;
    },
    replaceAll(text) {
      if (!query?.needle) return 0;
      scan();
      // Snapshot: each swap's input event may rescan `matches` mid-loop, but
      // descending replacements keep the snapshot's offsets valid.
      const list = matches;
      const count = list.length;
      if (!count) return 0;
      editor.focus();
      for (let i = count - 1; i >= 0; i--) {
        const m = list[i];
        editor.setSelectionRange(m.start, m.end);
        swap(text);
      }
      scan();
      currentFrom = null;
      return count;
    },
    rescan,
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
