import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { insertBlockTr } from "../src/block-insert.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    blockquote: { group: "block", content: "block+" },
    code_block: {
      group: "block",
      content: "text*",
      marks: "",
      code: true,
      defining: true,
    },
    hr: { group: "block" },
    hardbreak: { inline: true, group: "inline" },
    text: { group: "inline" },
  },
});

const para = (text = "") =>
  schema.node("paragraph", null, text ? [schema.text(text)] : []);

const stateWith = (doc, caret) =>
  EditorState.create({ schema, doc, selection: TextSelection.create(doc, caret) });

/** Types one character at the resulting selection and returns the new state. */
const typeInto = (state, text) => state.apply(state.tr.insertText(text));

test("insertBlockTr moves the caret into a block inserted mid-paragraph", () => {
  const doc = schema.node("doc", null, [para("abc")]);
  const state = stateWith(doc, 3);
  const after = state.apply(insertBlockTr(state, schema.nodes.code_block.create()));
  assert.equal(
    after.selection.$from.parent.type.name,
    "code_block",
    "the caret lands inside the new fence",
  );
  const typed = typeInto(after, "x");
  assert.equal(typed.doc.child(0).textContent, "ab");
  assert.equal(typed.doc.child(1).type.name, "code_block");
  assert.equal(typed.doc.child(1).textContent, "x", "typing lands in the fence");
  assert.equal(typed.doc.child(2).textContent, "c");
});

test("insertBlockTr moves the caret into the block inserted after a paragraph", () => {
  const doc = schema.node("doc", null, [para("abc")]);
  const state = stateWith(doc, 4);
  const after = state.apply(insertBlockTr(state, schema.nodes.code_block.create()));
  assert.equal(
    after.selection.$from.parent.type.name,
    "code_block",
    "the caret lands inside the new fence",
  );
  const typed = typeInto(after, "x");
  assert.equal(typed.doc.child(0).textContent, "abc", "the paragraph keeps its text");
  assert.equal(typed.doc.child(1).type.name, "code_block");
  assert.equal(typed.doc.child(1).textContent, "x", "typing lands in the fence");
});

test("insertBlockTr appends a paragraph after a leaf block at the document end", () => {
  const doc = schema.node("doc", null, [para("abc")]);
  const state = stateWith(doc, 4);
  const after = state.apply(insertBlockTr(state, schema.nodes.hr.create()));
  assert.equal(after.doc.child(1).type.name, "hr");
  assert.equal(after.doc.child(2).type.name, "paragraph");
  const typed = typeInto(after, "x");
  assert.equal(typed.doc.child(2).textContent, "x", "typing lands after the rule");
});

test("insertBlockTr in an empty document parks the caret in the new block", () => {
  const doc = schema.node("doc", null, [para()]);
  const state = stateWith(doc, 1);
  const after = state.apply(insertBlockTr(state, schema.nodes.code_block.create()));
  assert.equal(after.doc.childCount, 1, "the empty paragraph is replaced");
  assert.equal(after.selection.$from.parent.type.name, "code_block");
});
