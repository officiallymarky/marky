import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@milkdown/kit/prose/model";
import {
  EditorState,
  NodeSelection,
  TextSelection,
} from "@milkdown/kit/prose/state";
import { indentCodeBlock } from "../src/code-block-tab.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    code_block: {
      group: "block",
      content: "text*",
      marks: "",
      code: true,
      defining: true,
    },
    text: { group: "inline" },
  },
});

const node = (name, text) =>
  schema.node(name, null, text ? [schema.text(text)] : []);

const stateWith = (doc, selection) =>
  EditorState.create({ schema, doc, selection });

/** Runs the command with a dispatch spy; `tr` stays null when unhandled. */
const run = (state) => {
  let dispatched = null;
  const handled = indentCodeBlock(state, (tr) => {
    dispatched = tr;
  });
  return { handled, tr: dispatched };
};

test("indentCodeBlock inserts two spaces at the caret in a code block", () => {
  const doc = schema.node("doc", null, [node("code_block", "")]);
  const state = stateWith(doc, TextSelection.create(doc, 1));
  assert.equal(indentCodeBlock(state, null), true, "true on a dry run");
  const { handled, tr } = run(state);
  assert.equal(handled, true);
  assert.equal(tr.doc.textContent, "  ");
  assert.equal(tr.selection.from, 3, "caret lands after the spaces");
});

test("indentCodeBlock replaces a selection inside the code block", () => {
  const doc = schema.node("doc", null, [node("code_block", "ab")]);
  const state = stateWith(doc, TextSelection.create(doc, 1, 3));
  const { handled, tr } = run(state);
  assert.equal(handled, true);
  assert.equal(tr.doc.textContent, "  ");
});

test("indentCodeBlock declines outside a single code block", () => {
  const para = schema.node("doc", null, [node("paragraph", "hi")]);
  const paraState = stateWith(para, TextSelection.create(para, 1));
  assert.equal(run(paraState).handled, false);
  assert.equal(run(paraState).tr, null);

  // A selection over two blocks cannot be replaced by a bare text node.
  const two = schema.node("doc", null, [
    node("code_block", "ab"),
    node("code_block", "cd"),
  ]);
  const spanning = stateWith(two, TextSelection.create(two, 2, 7));
  assert.equal(run(spanning).handled, false, "cross-block selection");
  assert.equal(run(spanning).tr, null);

  const nodeSel = stateWith(two, NodeSelection.create(two, 0));
  assert.equal(run(nodeSel).handled, false, "node selection");
  assert.equal(run(nodeSel).tr, null);
});
