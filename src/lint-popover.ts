/**
 * The suggestion panel for one lint: the message, Harper's fixes, and the
 * ignore/dictionary actions. It floats next to the flagged text and is owned
 * by the spell-check instance, which hides it whenever the document changes
 * under it.
 */
import type { EditorView } from "@milkdown/kit/prose/view";
import type { DocLint, SpellSuggestion } from "./harper.ts";
import { SUGGESTION_INSERT_AFTER, SUGGESTION_REMOVE } from "./harper.ts";

export interface LintPopoverHandlers {
  apply(lint: DocLint, suggestion: SpellSuggestion): void;
  ignore(lint: DocLint): void;
  addToDictionary(lint: DocLint): void;
}

export interface LintPopover {
  show(lint: DocLint): void;
  hide(): void;
  destroy(): void;
}

/** Harper sometimes offers many near-identical fixes; five is plenty. */
const MAX_SUGGESTIONS = 5;
const MARGIN = 8;

function fixLabel(lint: DocLint, suggestion: SpellSuggestion): string {
  if (suggestion.kind === SUGGESTION_REMOVE) return `Delete “${lint.problem}”`;
  if (suggestion.kind === SUGGESTION_INSERT_AFTER) {
    return `Insert “${suggestion.text}”`;
  }
  return suggestion.text;
}

export function createLintPopover(
  view: EditorView,
  handlers: LintPopoverHandlers,
): LintPopover {
  const root = document.createElement("div");
  root.className = "lint-popover";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Spelling and grammar suggestions");
  document.body.append(root);

  // Keep the caret and selection in the editor; the buttons act on click.
  root.addEventListener("mousedown", (event) => event.preventDefault());

  function actionButton(label: string, className: string, run: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", run);
    return button;
  }

  function contents(lint: DocLint): HTMLElement[] {
    const close = (run: () => void) => () => {
      hide();
      run();
    };
    const parts: HTMLElement[] = [];
    const kind = document.createElement("div");
    kind.className = "lint-kind";
    kind.textContent = lint.kind;
    const message = document.createElement("div");
    message.className = "lint-message";
    message.textContent = lint.message;
    parts.push(kind, message);

    if (lint.suggestions.length) {
      const fixes = document.createElement("div");
      fixes.className = "lint-fixes";
      for (const suggestion of lint.suggestions.slice(0, MAX_SUGGESTIONS)) {
        fixes.append(
          actionButton(fixLabel(lint, suggestion), "lint-fix", close(() => handlers.apply(lint, suggestion))),
        );
      }
      parts.push(fixes);
    }

    const actions = document.createElement("div");
    actions.className = "lint-actions";
    actions.append(
      actionButton("Ignore", "lint-action", close(() => handlers.ignore(lint))),
    );
    if (lint.severity === "spelling") {
      actions.append(
        actionButton("Add to dictionary", "lint-action", close(() => handlers.addToDictionary(lint))),
      );
    }
    parts.push(actions);
    return parts;
  }

  function position(lint: DocLint): void {
    const coords = view.coordsAtPos(lint.from);
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    const left = Math.max(
      MARGIN,
      Math.min(coords.left, window.innerWidth - width - MARGIN),
    );
    let top = coords.bottom + 6;
    if (top + height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, coords.top - height - 6);
    }
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
  }

  function hide(): void {
    if (root.hidden) return;
    root.hidden = true;
    root.replaceChildren();
  }

  function show(lint: DocLint): void {
    root.replaceChildren(...contents(lint));
    root.hidden = false;
    position(lint);
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || root.hidden) return;
    hide();
    view.focus();
    event.stopPropagation();
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (root.hidden) return;
    const target = event.target;
    if (target instanceof Node && root.contains(target)) return;
    hide();
  };
  const onScrollOrResize = (): void => {
    hide();
  };
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize);

  return {
    show,
    hide,
    destroy() {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      root.remove();
    },
  };
}
