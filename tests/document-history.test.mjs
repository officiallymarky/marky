import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { DocumentHistory } from "../src/document-history.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
  marks: { strong: {} },
});
const rich = EditorState.create({
  schema,
  doc: schema.node("doc", null, [schema.node("paragraph", null, schema.text("seed"))]),
});

test("undo and redo traverse rich, source and front-matter edits in order", () => {
  const history = new DocumentHistory();
  const tr = rich.tr.addMark(1, 5, schema.marks.strong.create());
  const formatted = rich.apply(tr.setSelection(TextSelection.create(tr.doc, 2, 4)));
  const initial = { state: rich, front: "title: Original\n" };
  const bold = { state: formatted, front: initial.front };
  const source = { text: "---\ntitle: Source\n---\n\n**seed** and source\n", start: 52, end: 52 };
  const front = { text: source.text.replace("Source", "Changed"), start: 18, end: 18 };
  history.record(initial, bold);
  history.boundary(); // Enter source; switching alone records nothing.
  history.record(bold, source);
  history.record(source, front);
  history.boundary(); // Return to rich.

  assert.deepEqual(history.undo(), source);
  assert.deepEqual(history.undo(), bold);
  const restored = history.undo();
  assert.equal(restored.state.doc.textContent, "seed");
  assert.equal(restored.state.doc.firstChild.firstChild.marks.length, 0);
  assert.equal(restored.front, "title: Original\n");
  assert.equal(history.undo(), null);
  const redone = history.redo();
  assert.equal(redone.state.doc.firstChild.firstChild.marks[0].type.name, "strong");
  assert.equal(redone.state.selection.from, 2);
  assert.equal(redone.state.selection.to, 4);
  assert.deepEqual(history.redo(), source);
  assert.deepEqual(history.redo(), front);
  assert.equal(history.redo(), null);
});

test("typing groups stay separate across switches and undo/redo", () => {
  const history = new DocumentHistory();
  history.record("", "a");
  history.record("a", "ab", true);
  history.boundary();
  history.record("ab", "abc", true);
  assert.equal(history.undo(), "ab");
  assert.equal(history.undo(), "");
  assert.equal(history.redo(), "ab");
  history.record("ab", "abd", true);
  assert.equal(history.undo(), "ab");
  assert.equal(history.redo(), "abd");
});

test("editing after undo discards the old redo branch, but boundaries do not", () => {
  const history = new DocumentHistory();
  history.record("a", "b");
  history.record("b", "c");
  assert.equal(history.undo(), "b");
  history.boundary();
  assert.equal(history.redo(), "c");
  assert.equal(history.undo(), "b");
  history.record("b", "new");
  assert.equal(history.redo(), null);
  assert.equal(history.undo(), "b");
  assert.equal(history.undo(), "a");
});

test("history is bounded by edit groups and a replacement document cannot undo into the old one", () => {
  const history = new DocumentHistory(2);
  history.record("a", "b");
  history.record("b", "c");
  history.record("c", "d");
  assert.equal(history.undo(), "c");
  assert.equal(history.undo(), "b");
  assert.equal(history.undo(), null);
  history.clear();
  assert.equal(history.redo(), null);
  history.record("other document", "other edit", true);
  assert.equal(history.undo(), "other document");
  assert.equal(history.undo(), null);
});
