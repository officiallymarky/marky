import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { collectTocHeadings, createTocInputRule, tocSchema } from "../src/toc.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: {
      group: "block", content: "inline*",
      attrs: { level: { default: 1 }, id: { default: "" } },
    },
    code_block: { group: "block", content: "text*", code: true },
    blockquote: { group: "block", content: "block+" },
    bullet_list: { group: "block", content: "list_item+" },
    list_item: { content: "paragraph block*" },
    toc: tocSchema,
    text: { group: "inline" },
  },
  marks: { strong: {}, code: {} },
});

function heading(level, text, id = text) {
  return schema.node("heading", { level, id }, text ? schema.text(text) : null);
}

function typeClosingBracket(text, type = "paragraph", cursor = text.length, marks = []) {
  const doc = schema.node("doc", null, [
    schema.node(type, null, text ? schema.text(text, marks) : null),
  ]);
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, cursor + 1) });
  const rule = createTocInputRule(schema.nodes.toc);
  const match = rule.match.exec(text.slice(0, cursor) + "]");
  if (!match) return null;
  const tr = rule.handler(state, match, 1, cursor + 1);
  return tr ? state.apply(tr) : null;
}

test("TOC hierarchy follows heading ancestry across skipped levels and repeated titles", () => {
  const doc = schema.node("doc", null, [
    heading(2, "Overview", "overview"),
    heading(4, "Details", "details"),
    heading(3, "Details", "details-2"),
    heading(1, "Next", "next"),
    heading(6, "Deep", "deep"),
    heading(2, "", "empty"),
    schema.node("code_block", null, schema.text("# Not a heading")),
  ]);
  assert.deepEqual(collectTocHeadings(doc).map(({ text, id, level, depth }) =>
    ({ text, id, level, depth })), [
    { text: "Overview", id: "overview", level: 2, depth: 0 },
    { text: "Details", id: "details", level: 4, depth: 1 },
    { text: "Details", id: "details-2", level: 3, depth: 1 },
    { text: "Next", id: "next", level: 1, depth: 0 },
    { text: "Deep", id: "deep", level: 6, depth: 1 },
  ]);
  const positions = collectTocHeadings(doc).map(({ pos }) => pos);
  assert.deepEqual(positions.map((pos) => doc.nodeAt(pos).attrs.id),
    ["overview", "details", "details-2", "next", "deep"]);
});

test("typing either TOC marker creates a block and leaves an editable caret after it", () => {
  for (const marker of ["[TOC]", "[[TOC]]"]) {
    const state = typeClosingBracket(marker.slice(0, -1));
    assert.equal(state.doc.firstChild.type.name, "toc");
    assert.equal(state.doc.firstChild.attrs.marker, marker);
    assert.equal(state.selection.$from.parent.type.name, "paragraph");
    assert.equal(state.selection.from, 2);
  }
});

test("TOC typing does not convert code, marked text, inline mentions, or partial paragraphs", () => {
  assert.equal(typeClosingBracket("[TOC", "code_block"), null);
  assert.equal(typeClosingBracket("[TOC", "paragraph", 4, [schema.marks.code.create()]), null);
  assert.equal(typeClosingBracket("[TOC", "paragraph", 4, [schema.marks.strong.create()]), null);
  assert.equal(typeClosingBracket("See [TOC"), null);
  assert.equal(typeClosingBracket("\\[TOC"), null);
  assert.equal(typeClosingBracket("[[TOC"), null);
  assert.equal(typeClosingBracket("[TOC trailing", "paragraph", 4), null);
});

test("TOC typing leaves list and blockquote paragraphs intact", () => {
  const paragraph = schema.node("paragraph", null, schema.text("[TOC"));
  for (const wrapper of [
    schema.node("blockquote", null, paragraph),
    schema.node("bullet_list", null, schema.node("list_item", null, paragraph)),
  ]) {
    const doc = schema.node("doc", null, wrapper);
    let cursor;
    doc.descendants((node, pos) => {
      if (node.type.name === "paragraph") cursor = pos + 1 + node.content.size;
    });
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, cursor) });
    const rule = createTocInputRule(schema.nodes.toc);
    assert.equal(rule.handler(state, rule.match.exec("[TOC]"), cursor - 4, cursor), null);
  }
});

test("TOC heading text and target positions follow edits", () => {
  const doc = schema.node("doc", null, [
    schema.node("toc", { marker: "[[TOC]]" }),
    heading(1, "First"),
    heading(2, "Second"),
  ]);
  const state = EditorState.create({ doc });
  const changed = state.apply(state.tr.insertText("Updated ", 2));
  const entries = collectTocHeadings(changed.doc);
  assert.deepEqual(entries.map(({ text }) => text), ["Updated First", "Second"]);
  assert.equal(changed.doc.nodeAt(entries[1].pos).textContent, "Second");
});
