import {
  Editor,
  editorViewCtx,
  rootCtx,
  defaultValueCtx,
  prosePluginsCtx,
  parserCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import {
  EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
} from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { Fragment } from "@milkdown/kit/prose/model";
import type { Node as ProsemirrorNode, NodeType } from "@milkdown/kit/prose/model";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
// Retain ProseMirror's grouping rules, but route undo/redo through the shared
// document timeline rather than a rich-only keymap.
import {
  historyProviderConfig,
  historyProviderPlugin,
} from "@milkdown/kit/plugin/history";
import { closeHistory, undoDepth } from "@milkdown/kit/prose/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { getMarkdown, callCommand } from "@milkdown/kit/utils";
import { mermaidPlugin } from "./mermaid";
import { prism, prismConfig } from "@milkdown/plugin-prism";
import { codeLanguageAliases, codeLanguages } from "./highlight";
import { linkInputRule } from "./inline";
import {
  createCodeBlockCommand,
  insertImageCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import {
  insertTableCommand,
  toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import { createSelectionToolbar } from "./toolbar";
import {
  ALERT_TEXT,
  parseAlertMarker,
  restoreAlertMarkers,
  type AlertKind,
} from "./alerts";
import { nextFootnoteIndex, restoreFootnoteRefs } from "./footnote";
import { createFindApi, findPlugin, type FindHandle } from "./find";
import { createSpellCheck, spellPlugin, type SpellCheckHandle } from "./harper";
import { codeBlockTabKeymap } from "./code-block-tab";
import { tocInputRule, tocNode, tocPlugin, tocRemark } from "./toc";

export interface EditorHandle {
  /** Current document serialized back to markdown. */
  getMarkdown(): string;
  /** Synchronous edit revision, including changes not yet serialized. */
  readonly revision: number;
  /** Toggle focus mode: dim every block except the one holding the caret. */
  setFocusMode(on: boolean): void;
  focus(): void;
  /** Immutable rich state retained by the document's shared undo timeline. */
  snapshot(): EditorState;
  /** Restore a rich snapshot, or parse source without recording a new edit. */
  restore(snapshot: EditorState | string): void;
  breakHistoryGroup(): void;
  /** Insert actions shared by the toolbar menu and the native Insert menu. */
  insert: {
    table(rows: number, cols: number): void;
    horizontalRule(): void;
    codeBlock(): void;
    alert(kind: AlertKind): void;
    footnote(): void;
    toc(): void;
  };
  /** Find/replace over the document; a null query clears highlights. */
  search: FindHandle;
  /** Spell and grammar check; disabled while the user turned it off. */
  spelling: SpellCheckHandle;
  destroy(): Promise<void>;
}

/** Clicking a task item's checkbox (the item's own box, not its text) flips `checked`. */
const taskListTogglePlugin = new Plugin({
  key: new PluginKey("MARKY_TASK_LIST_TOGGLE"),
  props: {
    handleDOMEvents: {
      click: (view, event) => {
        const target = event.target;
        if (!(target instanceof Element)) return false;
        const li = target.closest("li[data-item-type=task]");
        if (!li || li !== target) return false;
        const pos = view.posAtDOM(li, 0);
        const $pos = view.state.doc.resolve(pos);
        for (let depth = $pos.depth; depth >= 0; depth--) {
          const node = $pos.node(depth);
          if (node.type.name !== "list_item") continue;
          if (node.attrs.checked == null) return false;
          view.dispatch(
            view.state.tr.setNodeMarkup($pos.before(depth), undefined, {
              ...node.attrs,
              checked: !node.attrs.checked,
            }),
          );
          return true;
        }
        return false;
      },
    },
  },
});
/** Adds a kind class to GitHub-style alert blockquotes so CSS can color them. */
const alertDecorationPlugin = new Plugin({
  key: new PluginKey("MARKY_ALERT_DECORATIONS"),
  props: {
    decorations(state) {
      const found: Decoration[] = [];
      /** Alerts may be nested inside other blockquotes; walk them all. */
      const walk = (node: ProsemirrorNode, offset: number): void => {
        node.forEach((child, childOffset) => {
          const pos = offset + childOffset;
          if (child.type.name !== "blockquote") return;
          const first = child.firstChild;
          if (first && first.type.name === "paragraph") {
            const textNode = first.firstChild;
            const kind = parseAlertMarker(
              textNode && textNode.isText ? textNode.text : null,
            );
            if (kind) {
              found.push(
                Decoration.node(pos, pos + child.nodeSize, {
                  class: `md-alert md-alert-${kind}`,
                }),
              );
            }
          }
          walk(child, pos + 1);
        });
      };
      walk(state.doc, 0);
      return DecorationSet.create(state.doc, found);
    },
  },
});
export async function createEditor(
  container: HTMLElement,
  initial: string,
  onUpdate: (markdown: string) => void,
  onError: (title: string, error: unknown) => void,
  onEdit: (before: EditorState, after: EditorState, join: boolean) => void,
): Promise<EditorHandle> {
  let focusEnabled = false;
  let revision = 0;
  let restoring = false;
  const revisionPlugin = new Plugin({
    key: new PluginKey("MARKY_EDIT_REVISION"),
    state: {
      init: () => null,
      apply: (tr) => {
        if (tr.docChanged) revision++;
        return null;
      },
    },
  });
  const editHistoryPlugin = new Plugin({
    key: new PluginKey("MARKY_DOCUMENT_HISTORY"),
    view: () => ({
      update(view, before) {
        if (restoring || view.state.doc.eq(before.doc)) return;
        onEdit(before, view.state, undoDepth(before) === undoDepth(view.state));
      },
    }),
  });

  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, container);
      ctx.set(defaultValueCtx, initial);
      ctx.get(listenerCtx).updated((current, doc) => {
        // A queued callback from before a mode switch/undo cannot adopt old text.
        if (!current.get(editorViewCtx).state.doc.eq(doc)) return;
        onUpdate(
          restoreFootnoteRefs(restoreAlertMarkers(current.get(serializerCtx)(doc))),
        );
      });
      ctx.update(prismConfig.key, (opts) => {
        opts.configureRefractor = (refractor) => {
          codeLanguages.forEach((language) => refractor.register(language));
          refractor.alias(codeLanguageAliases);
          return refractor;
        };
        return opts;
      });
      ctx.update(prosePluginsCtx, (plugins) => [
        ...plugins,
        revisionPlugin,
        editHistoryPlugin,
        taskListTogglePlugin,
        alertDecorationPlugin,
        findPlugin,
        spellPlugin,
      ]);
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .use(historyProviderConfig)
    .use(historyProviderPlugin)
    .use(clipboard)
    .use(trailing)
    .use(mermaidPlugin)
    .use(linkInputRule)
    .use(tocRemark)
    .use(tocNode)
    .use(tocInputRule)
    .use(tocPlugin)
    .use(codeBlockTabKeymap);

  for (const plugin of prism) editor.use(plugin);

  await editor.create();

  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const find = createFindApi(view);
  const spelling = createSpellCheck(view, { onError });
  const proseMirror = container.querySelector(".ProseMirror");

  /** Task lists are list items with a `checked` attr; gfm renders a checkbox. */
  const setTaskChecked = (checked: boolean): void => {
    const { from, to } = view.state.selection;
    const tr = view.state.tr;
    let changed = false;
    view.state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name !== "list_item") return true;
      if (node.attrs.checked === checked) return false;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
      changed = true;
      return false;
    });
    if (changed) view.dispatch(tr);
  };


  const updateFocusedBlock = () => {
    if (!proseMirror) return;
    const blocks = Array.from(proseMirror.children) as Element[];
    const selection = window.getSelection();
    let target: Element | null = null;
    if (
      focusEnabled &&
      selection?.anchorNode &&
      proseMirror.contains(selection.anchorNode)
    ) {
      let node: Node | null = selection.anchorNode;
      while (node && node.parentElement !== proseMirror) {
        node = node.parentElement;
      }
      target = node instanceof Element ? node : null;
    }
    for (const block of blocks) {
      block.classList.toggle("focused-block", block === target);
    }
  };

  document.addEventListener("selectionchange", updateFocusedBlock);

  /**
   * Block inserts must not land inside nodes that cannot hold them (table
   * cells, code blocks): ProseMirror would "helpfully" replace larger parts
   * of the structure and corrupt the document. When the caret's own context
   * cannot contain the node, move the caret to the nearest enclosing
   * boundary where it fits. Inside a plain paragraph the normal split
   * behavior is kept. `avoid` marks node types that are valid containers but
   * never a sensible home for a freshly inserted block (e.g. an alert inside
   * another alert).
   */
  const relocateForBlockInsert = (
    nodeType: NodeType,
    avoid: string[] = [],
  ): void => {
    const fill = nodeType.createAndFill();
    if (!fill) return;
    // A selected block node (NodeSelection) must not be replaced by the
    // insert; move the caret after it first.
    if (view.state.selection instanceof NodeSelection) {
      const { selection } = view.state;
      view.dispatch(
        view.state.tr
          .setSelection(Selection.near(view.state.doc.resolve(selection.to)))
          .scrollIntoView(),
      );
    }
    const { state } = view;
    const fits = (pos: number): boolean => {
      const parent = state.doc.resolve(pos).parent;
      return (
        !avoid.includes(parent.type.name) &&
        parent.type.validContent(Fragment.from(fill))
      );
    };
    const { $from } = state.selection;
    const nearest = $from.after($from.depth);
    if (fits(nearest)) return;
    for (let depth = $from.depth - 1; depth >= 0; depth -= 1) {
      const pos = $from.after(depth);
      if (fits(pos)) {
        view.dispatch(
          state.tr
            .setSelection(Selection.near(state.doc.resolve(pos)))
            .scrollIntoView(),
        );
        return;
      }
    }
  };

  /**
   * Shared transaction tail for block inserts: replaces the selection with
   * `node`, parks the caret at the first selectable position after it and
   * appends a paragraph when the node ends the document (nothing to select).
   */
  const dispatchBlockInsert = (node: ProsemirrorNode): void => {
    const { state } = view;
    const { from } = state.selection;
    const tr = state.tr.replaceSelectionWith(node);
    const next = Selection.findFrom(tr.doc.resolve(from), 1, true);
    if (next) {
      tr.setSelection(next);
    } else {
      // Nothing selectable after the node (document end): add a paragraph.
      tr.insert(tr.doc.content.size, state.schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
    }
    tr.scrollIntoView();
    view.dispatch(tr);
  };
  /** A thematic break as its own block; keeps any paragraph splits intact. */
  const insertHr = (): void => {
    relocateForBlockInsert(view.state.schema.nodes.hr);
    dispatchBlockInsert(view.state.schema.nodes.hr.create());
  };
  const toolbar = createSelectionToolbar({
    view,
    actions: {
      bold: () => editor.action(callCommand(toggleStrongCommand.key)),
      italic: () => editor.action(callCommand(toggleEmphasisCommand.key)),
      code: () => editor.action(callCommand(toggleInlineCodeCommand.key)),
      strike: () => editor.action(callCommand(toggleStrikethroughCommand.key)),
      link: (href) => editor.action(callCommand(toggleLinkCommand.key, { href })),
      image: (src, alt) =>
        editor.action(callCommand(insertImageCommand.key, { src, alt })),
      quote: () => editor.action(callCommand(wrapInBlockquoteCommand.key)),
      // Lists can only wrap paragraph blocks: headings are converted first.
      bullet: () => {
        if (view.state.selection.$from.parent.type.name !== "paragraph") {
          editor.action(callCommand(turnIntoTextCommand.key));
        }
        editor.action(callCommand(wrapInBulletListCommand.key));
      },
      ordered: () => {
        if (view.state.selection.$from.parent.type.name !== "paragraph") {
          editor.action(callCommand(turnIntoTextCommand.key));
        }
        editor.action(callCommand(wrapInOrderedListCommand.key));
      },
      taskList: () => {
        if (view.state.selection.$from.parent.type.name !== "paragraph") {
          editor.action(callCommand(turnIntoTextCommand.key));
        }
        editor.action(callCommand(wrapInBulletListCommand.key));
        setTaskChecked(false);
      },
      heading: (level) =>
        editor.action(callCommand(wrapInHeadingCommand.key, level)),
      paragraph: () => editor.action(callCommand(turnIntoTextCommand.key)),
      codeBlock: () => editor.action(callCommand(createCodeBlockCommand.key)),
      insertCodeBlock: () => insert.codeBlock(),
      table: (rows, cols) => insert.table(rows, cols),
      horizontalRule: () => insert.horizontalRule(),
      alert: (kind) => insert.alert(kind),
      footnote: () => insert.footnote(),
      toc: () => insert.toc(),
    },
  });

  /**
   * A `[^n]: ` definition: a paragraph holding the definition text (freshly
   * inserted) or a parsed `footnote_definition` node (after a reload).
   */
  const isFootnoteDefinition = (node: ProsemirrorNode): boolean =>
    node.type.name === "footnote_definition" ||
    (node.type.name === "paragraph" &&
      /^\[\^\d+\]: /.test(node.textContent));

  /**
   * Moves the caret out of a footnote definition (to the end of the body)
   * when it is parked in one, so inserts never land inside a definition.
   */
  const leaveFootnoteDefinition = (): void => {
    const state = view.state;
    const { $from } = state.selection;
    // A NodeSelection (e.g. a selected hr after a reload) has no depth-1 node.
    const topNode = $from.depth >= 1 ? $from.node(1) : null;
    if (!topNode || !isFootnoteDefinition(topNode)) return;
    let defPos: number | null = null;
    state.doc.forEach((node, offset) => {
      if (defPos === null && isFootnoteDefinition(node)) defPos = offset;
    });
    if (defPos !== null) {
      view.dispatch(
        state.tr
          .setSelection(Selection.near(state.doc.resolve(defPos), -1))
          .scrollIntoView(),
      );
    }
  };

  /** A footnote ref is literal text inside a code block; insert after it. */
  const leaveCodeBlock = (): void => {
    const { state } = view;
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name !== "code_block") continue;
      view.dispatch(
        state.tr
          .setSelection(Selection.near(state.doc.resolve($from.after(depth))))
          .scrollIntoView(),
      );
      return;
    }
  };

  /** Plain markdown footnotes: a `[^n]` ref at the caret plus a definition. */
  const insertFootnote = (): void => {
    leaveFootnoteDefinition();
    leaveCodeBlock();
    const { state } = view;
    const ref = `[^${nextFootnoteIndex(state.doc)}]`;
    const tr = state.tr.replaceSelectionWith(state.schema.text(ref));
    // The definition goes at the very end of the document, caret inside it.
    // A trailing empty paragraph is reused so no blank line is left behind.
    const last = tr.doc.lastChild;
    const defText = state.schema.text(`${ref}: `);
    if (
      last &&
      last.type.name === "paragraph" &&
      last.content.size === 0
    ) {
      tr.insert(tr.doc.content.size - 1, defText);
    } else {
      tr.insert(
        tr.doc.content.size,
        state.schema.nodes.paragraph.create(null, defText),
      );
    }
    tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
    tr.scrollIntoView();
    view.dispatch(tr);
  };
  /** A fresh empty fenced code block as its own block. */
  const insertCodeBlock = (): void => {
    leaveFootnoteDefinition();
    relocateForBlockInsert(view.state.schema.nodes.code_block, ["blockquote"]);
    dispatchBlockInsert(view.state.schema.nodes.code_block.create());
  };

  /** GitHub-style alert: a blockquote whose first line is `[!KIND]`. */
  const insertAlert = (kind: AlertKind): void => {
    leaveFootnoteDefinition();
    relocateForBlockInsert(view.state.schema.nodes.blockquote, ["blockquote"]);
    const { state } = view;
    const schema = state.schema;
    const paragraph = schema.nodes.paragraph.create(null, [
      schema.text(`[!${kind.toUpperCase()}]`),
      schema.nodes.hardbreak.create(),
      schema.text(ALERT_TEXT[kind]),
    ]);
    const quote = schema.nodes.blockquote.create(null, paragraph);
    const { from } = state.selection;
    const tr = state.tr.replaceSelectionWith(quote);
    // Park the caret at the end of the alert body so typing continues inside.
    tr.setSelection(TextSelection.create(tr.doc, from + quote.nodeSize - 1));
    tr.scrollIntoView();
    view.dispatch(tr);
  };

  const insert = {
    table: (rows: number, cols: number) => {
      leaveFootnoteDefinition();
      relocateForBlockInsert(view.state.schema.nodes.table, ["blockquote"]);
      editor.action(
        callCommand(insertTableCommand.key, { row: rows, col: cols }),
      );
    },
    horizontalRule: insertHr,
    codeBlock: insertCodeBlock,
    alert: insertAlert,
    footnote: insertFootnote,
    toc: () => {
      leaveFootnoteDefinition();
      relocateForBlockInsert(view.state.schema.nodes.toc, ["blockquote"]);
      dispatchBlockInsert(view.state.schema.nodes.toc.create());
    },
  };

  return {
    get revision() {
      return revision;
    },
    getMarkdown: () =>
      restoreFootnoteRefs(restoreAlertMarkers(editor.action(getMarkdown()))),
    insert,
    search: find,
    spelling,
    setFocusMode(on: boolean) {
      focusEnabled = on;
      container.classList.toggle("focus-mode", on);
      updateFocusedBlock();
    },
    focus: () => view.focus(),
    snapshot: () => view.state,
    restore(snapshot) {
      let state =
        typeof snapshot === "string"
          ? EditorState.create({
              schema: view.state.schema,
              plugins: view.state.plugins,
              doc: editor.action((ctx) => ctx.get(parserCtx)(snapshot)),
            })
          : snapshot;
      restoring = true;
      try {
        if (typeof snapshot === "string") {
          // Run trailing-node normalization inside the restore, not on the
          // next focus transaction (which would create a spurious undo step).
          state = state.applyTransaction(state.tr.setMeta("addToHistory", false)).state;
        }
        revision++;
        view.updateState(state);
      } finally {
        restoring = false;
      }
    },
    breakHistoryGroup: () => view.dispatch(closeHistory(view.state.tr)),
    destroy: async () => {
      document.removeEventListener("selectionchange", updateFocusedBlock);
      spelling.destroy();
      toolbar.destroy();
      await editor.destroy();
    },
  };
}
