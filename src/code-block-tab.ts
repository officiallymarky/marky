import type { Command } from "@milkdown/kit/prose/state";
import { TextSelection } from "@milkdown/kit/prose/state";
import { $useKeymap } from "@milkdown/kit/utils";

/**
 * `Tab` inside a fenced code block: insert two spaces and consume the key.
 * Without a binding the key falls through to the browser, which moves focus
 * out of the editor — the fence is the only place the editor behaves worse
 * than a plain textarea. Returns false everywhere else so the list item
 * (`Tab` sinks the item) and table (`Tab` moves to the next cell) bindings
 * keep their key.
 */
export const indentCodeBlock: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return false;
  const { $from, $to } = selection;
  if ($from.parent.type.name !== "code_block") return false;
  // A selection over several blocks cannot be replaced by a bare text node,
  // and replacing it here would corrupt the document structure.
  if ($from.parent !== $to.parent) return false;
  if (dispatch) dispatch(state.tr.insertText("  "));
  return true;
};

/**
 * Milkdown runs every binding for one key as a priority-ordered chain
 * (default 50, highest first, first success wins), so this must outrank the
 * list item's `Tab` sink: a fence nested in a list item should indent, not
 * sink the item. gfm's table binding sits at 100, but table cells cannot hold
 * code blocks, so the two never compete.
 */
export const codeBlockTabKeymap = $useKeymap("codeBlockTabKeymap", {
  Indent: {
    shortcuts: "Tab",
    priority: 60,
    command: () => indentCodeBlock,
  },
});
