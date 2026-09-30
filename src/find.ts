/**
 * Find/replace over the ProseMirror document.
 *
 * Matches live inside a single text node (they never span block or mark
 * boundaries), are highlighted with inline decorations, and are tracked by
 * the doc position of the current match so the highlight follows edits.
 */
import type { Node as ProsemirrorNode } from "@milkdown/kit/prose/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";

export interface FindQuery {
  needle: string;
  caseSensitive: boolean;
}

/** A match as string offsets into a single text string. */
export interface StringMatch {
  start: number;
  end: number;
}

/** A match as ProseMirror doc positions. */
export interface DocMatch {
  from: number;
  to: number;
}

export interface FindHandle {
  setQuery(query: FindQuery | null): void;
  /** 1-based position of the current match, `index: 0` when there are none. */
  count(): { total: number; index: number };
  next(): void;
  prev(): void;
  /** Replaces the current match; false when there is nothing to replace. */
  replaceCurrent(replacement: string): boolean;
  replaceAll(replacement: string): number;
}

/**
 * Finds every non-overlapping occurrence of `needle` in `text`. Comparison is
 * per character so case folding that changes string length (e.g. "İ") cannot
 * shift the reported offsets.
 */
export function findTextMatches(
  text: string,
  needle: string,
  caseSensitive: boolean,
): StringMatch[] {
  const matches: StringMatch[] = [];
  if (!needle) return matches;
  const len = needle.length;
  const same = caseSensitive
    ? (a: string, b: string) => a === b
    : (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  for (let i = 0; i + len <= text.length; i++) {
    if (!same(text[i], needle[0])) continue;
    let hit = true;
    for (let j = 1; j < len; j++) {
      if (!same(text[i + j], needle[j])) {
        hit = false;
        break;
      }
    }
    if (hit) {
      matches.push({ start: i, end: i + len });
      i += len - 1;
    }
  }
  return matches;
}

/** All matches in the document, in document order, per text node. */
export function computeMatches(
  doc: ProsemirrorNode,
  query: FindQuery | null,
): DocMatch[] {
  if (!query || !query.needle) return [];
  const out: DocMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const m of findTextMatches(
      node.text ?? "",
      query.needle,
      query.caseSensitive,
    )) {
      out.push({ from: pos + m.start, to: pos + m.end });
    }
    return false;
  });
  return out;
}

/**
 * Index of the match containing `from` (end-inclusive), else the last match
 * starting before it, else -1.
 */
export function locateMatch(matches: DocMatch[], from: number | null): number {
  if (from === null) return -1;
  let lastBefore = -1;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m.from <= from && from <= m.to) return i;
    if (m.from < from) lastBefore = i;
    if (m.from > from) break;
  }
  return lastBefore;
}

/** First match starting at/after `from`, wrapping to the first; -1 if empty. */
export function nextMatchFrom(matches: DocMatch[], from: number): number {
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].from >= from) return i;
  }
  return matches.length ? 0 : -1;
}

/** First match starting at/after the caret, else the first; -1 if empty. */
export function pickInitialMatch(matches: DocMatch[], head: number): number {
  return nextMatchFrom(matches, head);
}

/** Builds a transaction replacing `m` with `replacement`, keeping text marks. */
export function replaceMatch(
  state: EditorState,
  m: DocMatch,
  replacement: string,
): Transaction {
  const tr = state.tr;
  if (replacement === "") {
    tr.delete(m.from, m.to);
    return tr;
  }
  const marks = state.doc.nodeAt(m.from)?.marks;
  tr.replaceWith(m.from, m.to, state.schema.text(replacement, marks));
  return tr;
}

/**
 * Transaction replacing the match at the tracked position (`currentFrom`; the
 * match containing it, else the nearest before, else the first). The returned
 * position tracks where the search continues: the next old match mapped
 * through the edit — never wrapping back onto the replacement — or the
 * replacement's own start when it was the last match. Null when there is no
 * match to replace.
 */
export function replaceCurrentTr(
  state: EditorState,
  query: FindQuery,
  currentFrom: number | null,
  replacement: string,
): { tr: Transaction; currentFrom: number } | null {
  const found = computeMatches(state.doc, query);
  if (!found.length) return null;
  let current = locateMatch(found, currentFrom ?? state.selection.head);
  if (current === -1) current = 0;
  const m = found[current];
  const tr = replaceMatch(state, m, replacement);
  // The next old match at/after the replaced range — without wrapping, so a
  // replacement containing the needle is never re-replaced.
  let after = -1;
  for (let i = 0; i < found.length; i++) {
    if (found[i].from >= m.to) {
      after = i;
      break;
    }
  }
  return {
    tr,
    currentFrom:
      after >= 0 ? tr.mapping.map(found[after].from) : tr.mapping.map(m.from),
  };
}

/** Single transaction replacing every match; caret parked at the first one. */
export function replaceAllTr(
  state: EditorState,
  query: FindQuery,
  replacement: string,
): { tr: Transaction; count: number } {
  const found = computeMatches(state.doc, query);
  const tr = state.tr;
  // Descending order keeps earlier (smaller) positions valid.
  for (let i = found.length - 1; i >= 0; i--) {
    const m = found[i];
    if (replacement === "") {
      tr.delete(m.from, m.to);
      continue;
    }
    const marks = state.doc.nodeAt(m.from)?.marks;
    tr.replaceWith(m.from, m.to, state.schema.text(replacement, marks));
  }
  if (found.length) {
    tr.setSelection(TextSelection.create(tr.doc, found[0].from));
  }
  return { tr, count: found.length };
}

interface FindPluginState {
  query: FindQuery | null;
  /** Doc position where the current match starts (or ended, after a replace). */
  currentFrom: number | null;
}

interface FindMeta {
  query?: FindQuery | null;
  currentFrom?: number | null;
}

export const findPluginKey = new PluginKey<FindPluginState>("MARKY_FIND");

const emptyState: FindPluginState = { query: null, currentFrom: null };

export const findPlugin = new Plugin<FindPluginState>({
  key: findPluginKey,
  state: {
    init: () => emptyState,
    apply(tr, value) {
      const meta = tr.getMeta(findPluginKey) as FindMeta | undefined;
      if (meta && "currentFrom" in meta) {
        return {
          query: "query" in meta ? (meta.query ?? null) : value.query,
          currentFrom: meta.currentFrom ?? null,
        };
      }
      if (!tr.docChanged) return value;
      return {
        query: value.query,
        currentFrom:
          value.currentFrom === null
            ? null
            : tr.mapping.map(value.currentFrom),
      };
    },
  },
  props: {
    decorations(state) {
      const st = findPluginKey.getState(state) ?? emptyState;
      if (!st.query) return DecorationSet.empty;
      const matches = computeMatches(state.doc, st.query);
      const current =
        st.currentFrom === null ? -1 : locateMatch(matches, st.currentFrom);
      return DecorationSet.create(
        state.doc,
        matches.map((m, i) =>
          Decoration.inline(m.from, m.to, {
            class:
              i === current ? "find-match find-match-current" : "find-match",
          }),
        ),
      );
    },
  },
});

export function createFindApi(view: EditorView): FindHandle {
  const state = () => findPluginKey.getState(view.state) ?? emptyState;
  const matches = () => computeMatches(view.state.doc, state().query);

  /**
   * Scrolls the highlighted current match into view. ProseMirror's own
   * `tr.scrollIntoView()` is skipped whenever the editor does not have DOM
   * focus (the caret lives in the find bar), so we scroll the decoration
   * element directly.
   */
  const scrollToCurrent = (): void => {
    const el = view.dom.querySelector(".find-match-current");
    if (el) el.scrollIntoView({ block: "nearest" });
  };

  return {
    setQuery(query) {
      const q = query && query.needle ? query : null;
      let currentFrom: number | null = null;
      if (q) {
        const found = computeMatches(view.state.doc, q);
        const idx = found.length
          ? pickInitialMatch(found, view.state.selection.head)
          : -1;
        currentFrom = idx >= 0 ? found[idx].from : null;
      }
      view.dispatch(
        view.state.tr.setMeta(findPluginKey, { query: q, currentFrom }),
      );
    },
    count() {
      const found = matches();
      const index = locateMatch(found, state().currentFrom);
      return { total: found.length, index: index + 1 };
    },
    next: () => move(1),
    prev: () => move(-1),
    replaceCurrent(replacement) {
      const st = state();
      if (!st.query) return false;
      const res = replaceCurrentTr(
        view.state,
        st.query,
        st.currentFrom,
        replacement,
      );
      if (!res) return false;
      res.tr
        .setMeta(findPluginKey, { currentFrom: res.currentFrom })
        .setSelection(TextSelection.create(res.tr.doc, res.currentFrom))
        .scrollIntoView();
      view.dispatch(res.tr);
      scrollToCurrent();
      return true;
    },
    replaceAll(replacement) {
      const st = state();
      if (!st.query) return 0;
      const res = replaceAllTr(view.state, st.query, replacement);
      view.dispatch(res.tr);
      scrollToCurrent();
      return res.count;
    },
  };

  function move(delta: 1 | -1): void {
    const found = matches();
    if (!found.length) return;
    const cur = locateMatch(found, state().currentFrom);
    const idx =
      delta === 1
        ? (cur + 1) % found.length
        : cur <= 0
          ? found.length - 1
          : cur - 1;
    const m = found[idx];
    view.dispatch(
      view.state.tr
        .setMeta(findPluginKey, { currentFrom: m.from })
        .setSelection(TextSelection.create(view.state.doc, m.from, m.to))
        .scrollIntoView(),
    );
    scrollToCurrent();
  }
}
