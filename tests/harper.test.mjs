import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import {
  applySuggestionTr,
  buildLintInput,
  mapLints,
  severityOf,
  spellPlugin,
  spellPluginKey,
} from "../src/harper.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*" },
    code_block: { group: "block", content: "text*", marks: "" },
    text: { group: "inline" },
  },
  marks: { strong: {}, inline_code: {} },
});

const paragraph = (...content) =>
  schema.node("paragraph", null, content.map((c) => schema.text(c)));
const doc = (...blocks) => schema.node("doc", null, blocks);

const stateWith = (document) =>
  EditorState.create({ schema, plugins: [spellPlugin], doc: document });

const lint = (overrides) => ({
  start: 0,
  end: 1,
  severity: "spelling",
  kind: "Spelling",
  message: "message",
  problem: "x",
  suggestions: [],
  ...overrides,
});

test("buildLintInput skips code blocks and keeps document positions", () => {
  // "Hi wrld" | code_block "bad speling" | "A ok"
  const input = buildLintInput(
    doc(
      paragraph("Hi wrld"),
      schema.node("code_block", null, [schema.text("bad speling")]),
      paragraph("A ok"),
    ),
  );
  assert.equal(input.text, "Hi wrld\nA ok");
  assert.deepEqual(input.positions, [1, 2, 3, 4, 5, 6, 7, null, 23, 24, 25, 26]);
});

test("buildLintInput drops inline code and separates it with a null", () => {
  // "see " | inline_code "x y" | "ok"
  const input = buildLintInput(
    doc(
      schema.node("paragraph", null, [
        schema.text("see "),
        schema.text("x y", [schema.marks.inline_code.create()]),
        schema.text("ok"),
      ]),
    ),
  );
  assert.equal(input.text, "see \nok");
  assert.deepEqual(input.positions, [1, 2, 3, 4, null, 8, 9]);
});

test("mapLints turns buffer spans into document ranges", () => {
  const input = buildLintInput(doc(paragraph("alpha beta"), paragraph("beta gamma")));
  const [first] = mapLints(input, [lint({ start: 6, end: 10, problem: "beta" })]);
  assert.deepEqual(
    { from: first.from, to: first.to, problem: first.problem, rawIndex: first.rawIndex },
    { from: 7, to: 11, problem: "beta", rawIndex: 0 },
  );
  const text = schema.node("doc", null, [paragraph("alpha beta"), paragraph("beta gamma")]);
  assert.equal(text.textBetween(first.from, first.to, "", ""), "beta");
});

test("mapLints drops lints that cross separators or leave the text", () => {
  const input = buildLintInput(doc(paragraph("one"), paragraph("two")));
  assert.equal(input.text, "one\ntwo");
  // Spans the block separator.
  assert.deepEqual(mapLints(input, [lint({ start: 2, end: 5 })]), []);
  // Outside the linted text.
  assert.deepEqual(mapLints(input, [lint({ start: 6, end: 9 })]), []);
  assert.deepEqual(mapLints(input, [lint({ start: 4, end: 4 })]), []);
  assert.deepEqual(mapLints(input, [lint({ start: -1, end: 2 })]), []);
});

test("mapLints sorts by position and caps the result", () => {
  const input = buildLintInput(doc(paragraph("abcdef")));
  const raw = [
    lint({ start: 4, end: 5 }),
    lint({ start: 0, end: 1 }),
    lint({ start: 2, end: 3 }),
  ];
  assert.deepEqual(
    mapLints(input, raw).map((l) => l.from),
    [1, 3, 5],
  );
  assert.deepEqual(
    mapLints(input, raw, 2).map((l) => l.from),
    [1, 3],
  );
  // rawIndex points at the entry in the caller's list, not at the mapped order.
  assert.deepEqual(
    mapLints(input, raw).map((l) => l.rawIndex),
    [1, 2, 0],
  );
});

test("severityOf maps Harper kinds and hides stylistic advice", () => {
  assert.equal(severityOf("Spelling"), "spelling");
  assert.equal(severityOf("Typo"), "spelling");
  assert.equal(severityOf("Grammar"), "grammar");
  assert.equal(severityOf("Punctuation"), "grammar");
  assert.equal(severityOf("Style"), null);
  assert.equal(severityOf("Readability"), null);
});

test("applySuggestionTr replaces, deletes, and inserts after, keeping marks", () => {
  const bold = schema.node("paragraph", null, [
    schema.text("a "),
    schema.text("tset", [schema.marks.strong.create()]),
  ]);
  const state = stateWith(doc(bold));
  const target = lint({ problem: "tset", from: 3, to: 7 });

  const replaced = applySuggestionTr(state, target, { kind: 0, text: "test" });
  assert.ok(replaced);
  const afterReplace = state.apply(replaced);
  assert.equal(afterReplace.doc.textContent, "a test");
  assert.equal(afterReplace.doc.nodeAt(3).marks[0].type.name, "strong");

  const removed = applySuggestionTr(state, target, { kind: 1, text: "" });
  assert.ok(removed);
  assert.equal(state.apply(removed).doc.textContent, "a ");

  const inserted = applySuggestionTr(state, target, { kind: 2, text: "!" });
  assert.ok(inserted);
  assert.equal(state.apply(inserted).doc.textContent, "a tset!");
});

test("applySuggestionTr refuses a lint whose text changed", () => {
  const state = stateWith(doc(paragraph("a tset here")));
  const stale = lint({ problem: "tset", from: 3, to: 7 });
  const edited = state.apply(state.tr.insertText("zz", 1));
  assert.equal(applySuggestionTr(edited, stale, { kind: 0, text: "test" }), null);
  const matching = lint({ problem: "zz", from: 1, to: 3 });
  assert.ok(applySuggestionTr(edited, matching, { kind: 0, text: "" }));
});

test("plugin decorations follow the lints and their mapped positions", () => {
  const state = stateWith(doc(paragraph("a tset here")));
  const withLints = state.apply(
    state.tr.setMeta(spellPluginKey, {
      lints: [lint({ problem: "tset", from: 3, to: 7, severity: "grammar" })],
    }),
  );
  assert.deepEqual(
    spellPluginKey.getState(withLints).lints.map((l) => [l.from, l.to]),
    [[3, 7]],
  );
  // An edit before the lint shifts it.
  const shifted = withLints.apply(withLints.tr.insertText("xy", 1));
  assert.deepEqual(
    spellPluginKey.getState(shifted).lints.map((l) => [l.from, l.to]),
    [[5, 9]],
  );
  // A replacement overlapping the lint maps its boundaries too.
  const replaced = withLints.apply(withLints.tr.insertText("s", 3));
  assert.deepEqual(
    spellPluginKey.getState(replaced).lints.map((l) => [l.from, l.to]),
    [[4, 8]],
  );
  // Deleting the lint's text drops it.
  const removedText = withLints.apply(withLints.tr.delete(3, 7));
  assert.deepEqual(spellPluginKey.getState(removedText).lints, []);
  // Selection-only transactions keep them.
  const moved = withLints.apply(withLints.tr.setSelection(withLints.selection));
  assert.deepEqual(
    spellPluginKey.getState(moved).lints.map((l) => [l.from, l.to]),
    [[3, 7]],
  );
});

test("plugin decorations render one inline decoration per lint", () => {
  const state = stateWith(doc(paragraph("a tset here")));
  const withLints = state.apply(
    state.tr.setMeta(spellPluginKey, {
      lints: [lint({ problem: "tset", from: 3, to: 7, severity: "spelling" })],
    }),
  );
  const decorations = spellPlugin.spec.props.decorations(withLints);
  assert.equal(decorations.find().length, 1);
  const [decoration] = decorations.find();
  assert.equal(decoration.from, 3);
  assert.equal(decoration.to, 7);
  assert.match(decoration.type.attrs.class, /md-lint-spelling/);
});

test("recorded Harper spans map onto the matching words", () => {
  // Spans recorded from harper.js 2.10.0 for this sentence (plaintext mode).
  const input = buildLintInput(
    doc(paragraph("This is a tset of spel chekcing.")),
  );
  const mapped = mapLints(input, [
    lint({ start: 10, end: 14, problem: "tset" }),
    lint({ start: 18, end: 22, problem: "spel" }),
    lint({ start: 23, end: 31, problem: "chekcing" }),
  ]);
  assert.deepEqual(
    mapped.map((l) => input.text.slice(l.from - 1, l.to - 1)),
    ["tset", "spel", "chekcing"],
  );
});
