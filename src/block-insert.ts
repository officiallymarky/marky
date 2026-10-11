import type { Node as ProsemirrorNode } from "@milkdown/kit/prose/model";
import {
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@milkdown/kit/prose/state";

/**
 * Position of the freshly inserted `node` in the transaction's new document,
 * or null when it is not there. A block inserted inside a textblock splits it,
 * so the replacement can carry extra nodes: neither the old caret nor the last
 * step's start is the node's own position, but the node instance is. Callers
 * must pass a node that is not already present in the document.
 */
function insertedNodePos(
  tr: Transaction,
  node: ProsemirrorNode,
): number | null {
  let found: number | null = null;
  tr.doc.descendants((candidate, pos) => {
    if (found !== null) return false;
    if (candidate === node) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Transaction replacing the selection with `node`, parking the caret at the
 * first selectable position after it and appending a paragraph when the node
 * ends the document (nothing left to select).
 */
export function insertBlockTr(
  state: EditorState,
  node: ProsemirrorNode,
): Transaction {
  const tr = state.tr.replaceSelectionWith(node);
  const start = insertedNodePos(tr, node) ?? state.selection.from;
  const next = Selection.findFrom(tr.doc.resolve(start), 1, true);
  if (next) {
    tr.setSelection(next);
  } else {
    tr.insert(tr.doc.content.size, state.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
  }
  return tr.scrollIntoView();
}
