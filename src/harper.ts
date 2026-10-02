/**
 * Spell and grammar checking over the document with Harper
 * (https://writewithharper.com), running entirely on-device.
 *
 * Harper lints *strings*, so the document's prose is flattened into one text
 * buffer with a per-character map back into document positions; code blocks
 * and inline code are left out, and block boundaries become separators that
 * map to null. Lint spans into that buffer are turned into document ranges
 * (`mapLints`), which a ProseMirror plugin renders as underlines, maps
 * through edits, and replaces on each debounced run. The linter runs in a web
 * worker, so a large document never blocks typing.
 */
import type { Node as ProsemirrorNode } from "@milkdown/kit/prose/model";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Lint, Linter } from "harper.js";
import { createLintPopover } from "./lint-popover.ts";

// The package's `exports` map does not list its wasm file, so it is addressed
// by path; Vite rewrites this known asset pattern to the emitted file in
// production and to the served path in development.
const wasmUrl = new URL(
  "../node_modules/harper.js/dist/harper_wasm_bg.wasm",
  import.meta.url,
).href;

/** Harper's SuggestionKind values (numbers so the wasm module stays lazy). */
export const SUGGESTION_REMOVE = 1;
export const SUGGESTION_INSERT_AFTER = 2;

/** Lint kinds shown as spelling mistakes. */
const SPELLING_KINDS = new Set(["Spelling", "Typo", "Malapropism", "Eggcorn"]);
/**
 * Lint kinds shown as grammar, punctuation, and usage issues. Stylistic
 * advice (Style, Readability, Redundancy, Repetition) is deliberately left
 * out: it would underline most prose without being a mistake.
 */
const GRAMMAR_KINDS = new Set([
  "Agreement",
  "BoundaryError",
  "Capitalization",
  "Enhancement",
  "Grammar",
  "Punctuation",
  "Usage",
  "WordChoice",
  "WordOrder",
]);

export type SpellSeverity = "spelling" | "grammar";

/** Underline class for a Harper lint kind, or null for kinds we do not show. */
export function severityOf(kind: string): SpellSeverity | null {
  if (SPELLING_KINDS.has(kind)) return "spelling";
  if (GRAMMAR_KINDS.has(kind)) return "grammar";
  return null;
}

export interface SpellSuggestion {
  /** Harper's SuggestionKind. */
  kind: number;
  text: string;
}

/** A lint as Harper reports it: character offsets into the flattened text. */
export interface RawLint {
  start: number;
  end: number;
  severity: SpellSeverity;
  kind: string;
  message: string;
  problem: string;
  suggestions: SpellSuggestion[];
}

/** A lint over document positions. */
export interface DocLint {
  from: number;
  to: number;
  severity: SpellSeverity;
  kind: string;
  message: string;
  /** The document text the lint points at; fixes are rejected when it changed. */
  problem: string;
  suggestions: SpellSuggestion[];
  /** Index into the raw lint list, used to reach the retained Harper object. */
  rawIndex: number;
}

/** The document's prose plus the position every character came from. */
export interface LintInput {
  text: string;
  positions: (number | null)[];
}

/**
 * Flattens the linter's view of the document: text nodes outside code blocks
 * and inline code, with a newline between blocks. Anything the buffer leaves
 * out (code, but also a mark boundary) becomes a separator that maps to null,
 * so a lint spanning two unrelated pieces of text is dropped rather than
 * misplaced.
 */
export function buildLintInput(doc: ProsemirrorNode): LintInput {
  const chars: string[] = [];
  const positions: (number | null)[] = [];
  const last = (): number | null =>
    positions.length ? positions[positions.length - 1]! : null;
  /** Starts a new segment unless the buffer already ends in a separator. */
  const separate = (): void => {
    if (!positions.length || last() === null) return;
    chars.push("\n");
    positions.push(null);
  };
  doc.descendants((node, pos) => {
    if (node.type.name === "code_block") {
      separate();
      return false;
    }
    if (node.isText) {
      if (node.marks.some((mark) => mark.type.name === "inline_code")) {
        separate();
        return false;
      }
      const text = node.text ?? "";
      for (let i = 0; i < text.length; i += 1) {
        const position = pos + i;
        const previous = last();
        if (previous !== null && previous !== position - 1) separate();
        chars.push(text[i]!);
        positions.push(position);
      }
      return false;
    }
    if (node.isTextblock) separate();
    return true;
  });
  return { text: chars.join(""), positions };
}

/** Most lints rendered at once; a document beyond this stays usable. */
const MAX_LINTS = 500;

/**
 * Turns the usable raw lints into document ranges. A lint is dropped when it
 * points outside the linted text or crosses a synthetic separator, and the
 * list is capped so a pathological document cannot bury the editor in
 * decorations.
 */
export function mapLints(
  input: LintInput,
  raw: RawLint[],
  limit = MAX_LINTS,
): DocLint[] {
  const { text, positions } = input;
  const usable = raw
    .map((lint, index) => ({ lint, index }))
    .filter(
      ({ lint }) =>
        lint.start >= 0 && lint.end > lint.start && lint.end <= text.length,
    )
    .sort((a, b) => a.lint.start - b.lint.start);
  const found: DocLint[] = [];
  for (const { lint, index } of usable) {
    if (found.length >= limit) break;
    let from: number | null = null;
    let to: number | null = null;
    let crosses = false;
    for (let i = lint.start; i < lint.end; i += 1) {
      const position = positions[i]!;
      if (position === null) {
        crosses = true;
        break;
      }
      if (from === null) from = position;
      to = position;
    }
    if (crosses || from === null || to === null) continue;
    found.push({
      from,
      to: to + 1,
      severity: lint.severity,
      kind: lint.kind,
      message: lint.message,
      problem: lint.problem,
      suggestions: lint.suggestions,
      rawIndex: index,
    });
  }
  return found;
}

/**
 * Transaction applying one suggestion, keeping the marks of the replaced
 * text. Null when the document no longer matches the lint (it went stale
 * between the run and the click).
 */
export function applySuggestionTr(
  state: EditorState,
  lint: DocLint,
  suggestion: SpellSuggestion,
): Transaction | null {
  if (state.doc.textBetween(lint.from, lint.to, "", "") !== lint.problem) {
    return null;
  }
  const tr = state.tr;
  if (suggestion.kind === SUGGESTION_REMOVE || suggestion.text === "") {
    tr.delete(lint.from, lint.to);
  } else if (suggestion.kind === SUGGESTION_INSERT_AFTER) {
    tr.insertText(suggestion.text, lint.to);
  } else {
    const marks = state.doc.nodeAt(lint.from)?.marks;
    tr.replaceWith(lint.from, lint.to, state.schema.text(suggestion.text, marks));
  }
  return tr;
}

interface SpellPluginState {
  lints: DocLint[];
}

export const spellPluginKey = new PluginKey<SpellPluginState>("MARKY_SPELL");

/** Woken after edits by the active spell-check instance. */
let onDocChanged: (() => void) | null = null;

export const spellPlugin = new Plugin<SpellPluginState>({
  key: spellPluginKey,
  state: {
    init: () => ({ lints: [] }),
    apply(tr, value) {
      const meta = tr.getMeta(spellPluginKey) as SpellPluginState | undefined;
      if (meta) return meta;
      if (!tr.docChanged) return value;
      onDocChanged?.();
      if (!value.lints.length) return value;
      const lints: DocLint[] = [];
      for (const lint of value.lints) {
        const from = tr.mapping.mapResult(lint.from);
        const to = tr.mapping.mapResult(lint.to, 1);
        if (from.deleted || to.deleted || to.pos <= from.pos) continue;
        lints.push({ ...lint, from: from.pos, to: to.pos });
      }
      return { lints };
    },
  },
  props: {
    decorations(state) {
      const lints = spellPluginKey.getState(state)?.lints ?? [];
      if (!lints.length) return DecorationSet.empty;
      return DecorationSet.create(
        state.doc,
        lints.map((lint) =>
          Decoration.inline(lint.from, lint.to, {
            class: `md-lint md-lint-${lint.severity}`,
          }),
        ),
      );
    },
  },
});

const ENABLED_KEY = "spell.enabled";
const WORDS_KEY = "spell.words";
const IGNORED_KEY = "spell.ignored";

/** Spell check is on unless the user turned it off. */
export function readSpellEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch (error) {
    console.error("Could not read the spell-check setting", error);
    return true;
  }
}

export function writeSpellEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch (error) {
    console.error("Could not save the spell-check setting", error);
  }
}

function readStoredWords(): string[] {
  const stored = readStored(WORDS_KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((word): word is string => typeof word === "string")
      : [];
  } catch (error) {
    console.error("Could not read the spell-check dictionary", error);
    return [];
  }
}

/** Reads one stored value; null when it is absent or storage is unavailable. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.error(`Could not read ${key}`, error);
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.error(`Could not save ${key}`, error);
  }
}

/** A lint whose Harper object is kept so it can be ignored later. */
interface RetainedLints {
  objects: Lint[];
  /** The text the objects were produced from; ignore hashes depend on it. */
  source: string;
}

export interface SpellCheckOptions {
  /** Surfaced for load and lint failures; the check keeps working without it. */
  onError?: (title: string, error: unknown) => void;
}

export interface SpellCheckHandle {
  setEnabled(on: boolean): void;
  destroy(): void;
}

const DEBOUNCE_MS = 400;
/** Longer documents take seconds to lint; they are left unmarked. */
const MAX_LINT_LENGTH = 400_000;

/**
 * Spell check for one editor instance. Re-reads the enabled flag on creation,
 * and persists ignored lints and dictionary words globally, so they survive
 * document and mode switches.
 */
export function createSpellCheck(
  view: EditorView,
  options: SpellCheckOptions = {},
): SpellCheckHandle {
  const report = (error: unknown): void => {
    if (options.onError) options.onError("Spell check failed", error);
    else console.error("Spell check failed", error);
  };

  let enabled = readSpellEnabled();
  let disposed = false;
  let timer: number | undefined;
  let inFlight = false;
  let queued = false;
  /** Bumped by every document edit; results from other versions are stale. */
  let docVersion = 0;
  /** Bumped when a run is superseded (disabled, destroyed, documents switch). */
  let generation = 0;
  let linter: Linter | null = null;
  let linterPromise: Promise<Linter> | null = null;
  let retained: RetainedLints | null = null;

  const popover = createLintPopover(view, {
    apply(lint, suggestion) {
      const tr = applySuggestionTr(view.state, lint, suggestion);
      if (!tr) {
        // The document moved on since this run; refresh and let the user retry.
        requestRun(0);
        return;
      }
      view.dispatch(tr);
      view.focus();
    },
    ignore(lint) {
      void ignoreLint(lint);
    },
    addToDictionary(lint) {
      void addWord(lint);
    },
  });

  const hook = (): void => {
    docVersion += 1;
    // The lints are about to be recomputed; a panel pointing at the old
    // positions must not stay up over the edit.
    popover.hide();
    requestRun(DEBOUNCE_MS);
  };
  onDocChanged = hook;

  const onClick = (event: MouseEvent): void => {
    const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
    const lints = spellPluginKey.getState(view.state)?.lints ?? [];
    const lint =
      pos === undefined || pos < 0
        ? undefined
        : lints.find((candidate) => candidate.from <= pos && pos <= candidate.to);
    if (lint) popover.show(lint);
    else popover.hide();
  };
  view.dom.addEventListener("click", onClick);

  function setLints(lints: DocLint[]): void {
    if (disposed) return;
    view.dispatch(view.state.tr.setMeta(spellPluginKey, { lints }));
  }

  function requestRun(delay: number): void {
    if (!enabled || disposed) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), delay);
  }

  async function run(): Promise<void> {
    if (!enabled || disposed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    const input = buildLintInput(view.state.doc);
    if (!input.text.trim() || input.text.length > MAX_LINT_LENGTH) {
      setLints([]);
      return;
    }
    inFlight = true;
    const version = docVersion;
    const myGeneration = generation;
    try {
      const { raw, objects } = await lintText(input.text);
      if (disposed || myGeneration !== generation) {
        release(objects);
        return;
      }
      if (version !== docVersion) {
        // The document changed while linting: this result is stale, but the
        // edit that invalidated it still needs a run.
        release(objects);
        queued = true;
        return;
      }
      releaseRetained();
      retained = { objects, source: input.text };
      setLints(mapLints(input, raw));
    } catch (error) {
      if (!disposed && myGeneration === generation) report(error);
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        requestRun(DEBOUNCE_MS);
      }
    }
  }

  /** Runs Harper and copies everything out of the wasm objects. */
  async function lintText(
    source: string,
  ): Promise<{ raw: RawLint[]; objects: Lint[] }> {
    const active = await ensureLinter();
    const lints = await active.lint(source, { language: "plaintext" });
    const raw: RawLint[] = [];
    const objects: Lint[] = [];
    for (const lint of lints) {
      const kind = lint.lint_kind();
      const severity = severityOf(kind);
      if (!severity) {
        lint.free();
        continue;
      }
      const span = lint.span();
      const suggestions = lint.suggestions();
      raw.push({
        start: span.start,
        end: span.end,
        severity,
        kind,
        message: lint.message(),
        problem: lint.get_problem_text(),
        suggestions: suggestions.map((suggestion) => ({
          kind: suggestion.kind(),
          text: suggestion.get_replacement_text(),
        })),
      });
      span.free();
      for (const suggestion of suggestions) suggestion.free();
      objects.push(lint);
    }
    return { raw, objects };
  }

  async function ignoreLint(lint: DocLint): Promise<void> {
    const active = linter;
    const entry = retained?.objects[lint.rawIndex];
    if (!active || !retained || !entry) return;
    popover.hide();
    try {
      await active.ignoreLints(retained.source, [entry]);
      store(IGNORED_KEY, await active.exportIgnoredLints());
      requestRun(0);
    } catch (error) {
      report(error);
    }
  }

  async function addWord(lint: DocLint): Promise<void> {
    const active = linter;
    if (!active) return;
    popover.hide();
    try {
      await active.importWords([lint.problem]);
      store(WORDS_KEY, JSON.stringify(await active.exportWords()));
      requestRun(0);
    } catch (error) {
      report(error);
    }
  }

  function ensureLinter(): Promise<Linter> {
    if (!linterPromise) {
      linterPromise = (async () => {
        // Runtime import on purpose: this keeps Harper's module and its web
        // worker out of the startup path, so a disabled spell checker costs
        // nothing until the first run.
        const { WorkerLinter, createBinaryModuleFromUrl } = await import("harper.js");
        const active = new WorkerLinter({
          binary: createBinaryModuleFromUrl(wasmUrl),
        });
        linter = active;
        await active.setup();
        const words = readStoredWords();
        if (words.length) await active.importWords(words);
        const ignored = readStored(IGNORED_KEY);
        if (ignored) await active.importIgnoredLints(ignored);
        return active;
      })();
      linterPromise.catch(() => {
        linterPromise = null;
        linter = null;
      });
    }
    return linterPromise;
  }

  function release(objects: Lint[]): void {
    for (const lint of objects) lint.free();
  }

  function releaseRetained(): void {
    if (!retained) return;
    release(retained.objects);
    retained = null;
  }

  function setEnabled(on: boolean): void {
    if (disposed || on === enabled) return;
    enabled = on;
    generation += 1;
    window.clearTimeout(timer);
    queued = false;
    if (!on) {
      releaseRetained();
      popover.hide();
      setLints([]);
      return;
    }
    requestRun(0);
  }

  function destroy(): void {
    if (disposed) return;
    disposed = true;
    generation += 1;
    window.clearTimeout(timer);
    popover.destroy();
    view.dom.removeEventListener("click", onClick);
    if (onDocChanged === hook) onDocChanged = null;
    releaseRetained();
    const active = linter;
    linter = null;
    if (active) {
      active.dispose().catch((error: unknown) => {
        console.error("Could not shut down the spell checker", error);
      });
    }
  }

  if (enabled) requestRun(0);

  return { setEnabled, destroy };
}
