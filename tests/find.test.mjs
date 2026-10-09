import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import {
  computeMatches,
  findPlugin,
  findPluginKey,
  findTextMatches,
  locateMatch,
  nextMatchFrom,
  replaceAllTr,
  replaceCurrentTr,
  replaceMatch,
} from "../src/find.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
  marks: { strong: {} },
});

const plain = (...paragraphs) =>
  EditorState.create({
    schema,
    plugins: [findPlugin],
    doc: schema.node("doc", null, paragraphs.map((t) => paragraphWith(t))),
  });

const paragraphWith = (content) =>
  schema.node("paragraph", null, typeof content === "string" ? [schema.text(content)] : content);

const stateWith = (doc) => EditorState.create({ schema, plugins: [findPlugin], doc });

test("findTextMatches finds every occurrence, honoring case and overlap", () => {
  assert.deepEqual(findTextMatches("ab ab ab", "ab", true), [
    { from: 0, to: 2 },
    { from: 3, to: 5 },
    { from: 6, to: 8 },
  ]);
  assert.deepEqual(findTextMatches("Ab aB ab", "ab", false), [
    { from: 0, to: 2 },
    { from: 3, to: 5 },
    { from: 6, to: 8 },
  ]);
  assert.deepEqual(findTextMatches("Ab aB ab", "ab", true), [{ from: 6, to: 8 }]);
  // Non-overlapping: "aaa" matches at 0 and 2, not at 1.
  assert.deepEqual(findTextMatches("aaa", "aa", true), [{ from: 0, to: 2 }]);
  assert.deepEqual(findTextMatches("abc", "", true), []);
});

test("computeMatches reports doc positions across paragraphs and marks", () => {
  // "alpha beta" | "beta gamma"
  const state = plain("alpha beta", "beta gamma");
  assert.deepEqual(computeMatches(state.doc, { needle: "beta", caseSensitive: true }), [
    { from: 7, to: 11 },
    { from: 13, to: 17 },
  ]);
  // Matches inside marked text.
  const bold = paragraphWith([
    schema.text("say "),
    schema.text("bold", [schema.marks.strong.create()]),
    schema.text(" end"),
  ]);
  const marked = stateWith(schema.node("doc", null, [bold]));
  assert.deepEqual(computeMatches(marked.doc, { needle: "bold", caseSensitive: true }), [
    { from: 5, to: 9 },
  ]);
  assert.deepEqual(computeMatches(marked.doc, { needle: "BOLD", caseSensitive: true }), []);
  assert.deepEqual(computeMatches(marked.doc, { needle: "BOLD", caseSensitive: false }), [
    { from: 5, to: 9 },
  ]);
});

test("locateMatch tracks containment and the nearest earlier match", () => {
  const matches = [
    { from: 0, to: 3 },
    { from: 10, to: 13 },
  ];
  assert.equal(locateMatch(matches, 0), 0);
  assert.equal(locateMatch(matches, 3), 0);
  assert.equal(locateMatch(matches, 10), 1);
  assert.equal(locateMatch(matches, 5), 0);
  assert.equal(locateMatch(matches, 20), 1);
  assert.equal(locateMatch(matches, null), -1);
  assert.equal(nextMatchFrom(matches, 11), 0); // wraps
  assert.equal(nextMatchFrom(matches, 12), 0); // wraps
  assert.equal(nextMatchFrom([], 0), -1);
});

test("locateMatch resolves adjacent matches to the later one", () => {
  // "aaaaaa" as "aa": a match start is also the previous match's end.
  const matches = findTextMatches("aaaaaa", "aa", true);
  assert.deepEqual(matches, [
    { from: 0, to: 2 },
    { from: 2, to: 4 },
    { from: 4, to: 6 },
  ]);
  assert.equal(locateMatch(matches, 0), 0);
  assert.equal(locateMatch(matches, 2), 1);
  assert.equal(locateMatch(matches, 4), 2);
  // A position at the last match's end still resolves to that match.
  assert.equal(locateMatch(matches, 6), 2);
  // A single-character needle repeats adjacently just as often.
  const single = findTextMatches("hello", "l", true);
  assert.deepEqual(single, [
    { from: 2, to: 3 },
    { from: 3, to: 4 },
  ]);
  assert.equal(locateMatch(single, 2), 0);
  assert.equal(locateMatch(single, 3), 1);
});

test("replaceCurrentTr replaces the adjacent match the search navigated to", () => {
  // "hello": one step past the first "l" tracks the second one (doc offset 4).
  const state = plain("hello");
  const query = { needle: "l", caseSensitive: true };
  const res = replaceCurrentTr(state, query, 4, "L");
  assert.ok(res);
  assert.equal(state.apply(res.tr).doc.textContent, "helLo");
});

test("replaceCurrentTr replaces the tracked match, keeping marks", () => {
  const bold = paragraphWith([
    schema.text("say "),
    schema.text("bold", [schema.marks.strong.create()]),
  ]);
  const query = { needle: "bold", caseSensitive: true };
  const state = stateWith(schema.node("doc", null, [bold]));
  const res = replaceCurrentTr(state, query, 5, "BOLD");
  assert.ok(res);
  const next = state.apply(res.tr);
  assert.equal(next.doc.textContent, "say BOLD");
  const node = next.doc.nodeAt(5);
  assert.equal(node.marks.length, 1);
  assert.equal(node.marks[0].type.name, "strong");
  // Only match left: continue tracking the replacement itself.
  assert.equal(res.currentFrom, 5);
});

test("replaceCurrentTr advances past the replacement, never re-replacing it", () => {
  // "X X" with needle "X": replacing the first with "XX" must leave the
  // tracked position on the second match, not the just-inserted "XX".
  const state = plain("X X");
  const query = { needle: "X", caseSensitive: true };
  const first = replaceCurrentTr(state, query, null, "XX");
  assert.ok(first);
  // Old second match at 3 maps past the one-char growth.
  assert.equal(first.currentFrom, 4);
  const next = state.apply(first.tr);
  assert.equal(next.doc.textContent, "XX X");
  // Replacing again consumes the real second match, not the inserted text.
  const second = replaceCurrentTr(next, query, first.currentFrom, "XX");
  assert.ok(second);
  assert.equal(next.apply(second.tr).doc.textContent, "XX XX");
  // Nothing left: empty replacement deletes the tracked match.
  const third = replaceCurrentTr(next.apply(second.tr), query, second.currentFrom, "");
  assert.ok(third);
  assert.equal(next.apply(second.tr).apply(third.tr).doc.textContent, "XX X");
});

test("replaceCurrentTr returns null with no matches", () => {
  const state = plain("nothing here");
  assert.equal(
    replaceCurrentTr(state, { needle: "zzz", caseSensitive: true }, null, "x"),
    null,
  );
});

test("replaceAllTr replaces every match in one transaction", () => {
  const state = plain("go go go", "also go");
  const query = { needle: "go", caseSensitive: true };
  const res = replaceAllTr(state, query, "stop");
  assert.equal(res.count, 4);
  const next = state.apply(res.tr);
  assert.equal(next.doc.textContent, "stop stop stopalso stop");
  // Caret parked at the first replacement.
  assert.equal(next.selection.from, res.tr.selection.from);
});

test("replaceAllTr with empty replacement deletes every match", () => {
  const state = plain("keep cut keep cut");
  const res = replaceAllTr(state, { needle: "cut", caseSensitive: true }, "");
  assert.equal(res.count, 2);
  assert.equal(state.apply(res.tr).doc.textContent, "keep  keep ");
});

test("plugin state stores the query and maps the tracked position through edits", () => {
  const state = plain("alpha beta");
  const query = { needle: "beta", caseSensitive: true };
  const withQuery = state.apply(
    state.tr.setMeta(findPluginKey, { query, currentFrom: 7 }),
  );
  assert.deepEqual(findPluginKey.getState(withQuery), { query, currentFrom: 7 });
  // An edit before the match shifts the tracked position.
  const edited = withQuery.apply(
    withQuery.tr.insert(1, schema.text("xx")),
  );
  assert.deepEqual(findPluginKey.getState(edited), { query, currentFrom: 9 });
  // Selection-only transactions leave the state untouched.
  const moved = edited.apply(
    edited.tr.setSelection(TextSelection.create(edited.doc, 3)),
  );
  assert.deepEqual(findPluginKey.getState(moved), { query, currentFrom: 9 });
  // An explicit position update is stored as-is (not re-mapped).
  const moved2 = edited.apply(
    edited.tr.setMeta(findPluginKey, { currentFrom: 2 }),
  );
  assert.deepEqual(findPluginKey.getState(moved2), { query, currentFrom: 2 });
});

test("replaceMatch keeps marks and deletes on empty replacement", () => {
  const bold = paragraphWith([
    schema.text("a "),
    schema.text("b", [schema.marks.strong.create()]),
  ]);
  const state = stateWith(schema.node("doc", null, [bold]));
  const kept = state.apply(replaceMatch(state, { from: 3, to: 4 }, "bb"));
  assert.equal(kept.doc.textContent, "a bb");
  assert.equal(kept.doc.nodeAt(3).marks[0].type.name, "strong");
  const gone = state.apply(replaceMatch(state, { from: 3, to: 4 }, ""));
  assert.equal(gone.doc.textContent, "a ");
});
