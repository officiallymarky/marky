import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import {
  createLinkInputRule,
  parseLinkDestination,
} from "../src/inline.ts";

// Mirrors the shape of milkdown's linkSchema mark (attrs href/title, default
// inclusiveness) plus a strong mark, so rule behavior matches the editor's.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
  marks: {
    strong: {},
    link: {
      attrs: { href: {}, title: { default: null } },
    },
  },
});
const linkType = schema.marks.link;
const strongType = schema.marks.strong;

/** Builds a doc/paragraph state whose text runs carry optional marks. */
function stateWithRuns(runs) {
  const children = runs.map((run) =>
    schema.text(run.text, run.marks ?? []),
  );
  const doc = schema.node("doc", null, [schema.node("paragraph", null, children)]);
  const cursor = doc.content.size - 1;
  return EditorState.create({ doc, selection: TextSelection.create(doc, cursor) });
}

/**
 * Replicates prosemirror-inputrules' `run()` for typed text: the rule matches
 * the text before the caret plus the typed character, and the handler receives
 * positions in the document as it is before that character is inserted.
 */
function typeChar(state, ch) {
  const rule = createLinkInputRule(linkType);
  const { from, to } = state.selection;
  const $from = state.doc.resolve(from);
  const textBefore =
    $from.parent.textBetween(
      Math.max(0, $from.parentOffset - 500),
      $from.parentOffset,
      null,
      "\ufffc",
    ) + ch;
  const match = rule.match.exec(textBefore);
  if (!match) return null;
  const start = from - (match[0].length - ch.length);
  const tr = rule.handler(state, match, start, to);
  return tr ? state.apply(tr) : null;
}

function linkMarkOf(state) {
  let found = null;
  state.doc.nodesBetween(0, state.doc.content.size, (node) => {
    const mark = node.marks.find((mark) => mark.type === linkType);
    if (node.isText && mark) found = mark;
  });
  return found;
}

test("parenthesized URL segment keeps the full balanced href", () => {
  // Typing the first `)` of `…(b))` closes the inner pair only: no conversion.
  const partial = stateWithRuns([{ text: "[article](https://example.com/a_(b" }]);
  assert.equal(typeChar(partial, ")"), null);

  // After the inner pair is closed, the second `)` completes the link with the
  // whole URL instead of stopping at the first `)`.
  const inner = stateWithRuns([{ text: "[article](https://example.com/a_(b)" }]);
  const converted = typeChar(inner, ")");
  assert.ok(converted, "rule should fire once the outer paren closes");
  assert.equal(converted.doc.textContent, "article");
  assert.equal(
    linkMarkOf(converted)?.attrs.href,
    "https://example.com/a_(b)",
  );
});

test("destination parses like CommonMark for parens, escapes, and titles", () => {
  // Tails include the destination's closing `)`.
  assert.deepEqual(parseLinkDestination("https://example.com/a_(b))"), {
    href: "https://example.com/a_(b)",
    title: null,
  });
  assert.deepEqual(parseLinkDestination("b(c)d)"), {
    href: "b(c)d",
    title: null,
  });
  assert.equal(parseLinkDestination("b(c"), null);
  assert.equal(parseLinkDestination("b)extra"), null);
  assert.equal(parseLinkDestination(""), null);
  // Backslash-escaped punctuation is unescaped and never balanced.
  assert.deepEqual(parseLinkDestination("b\\(c\\))"), { href: "b(c)", title: null });
  assert.deepEqual(parseLinkDestination('b "Docs")'), {
    href: "b",
    title: "Docs",
  });
  assert.equal(parseLinkDestination('b "Docs'), null);
});

test("simple link with title converts", () => {
  const state = stateWithRuns([
    { text: '[check](https://example.com "Docs"' },
  ]);
  const converted = typeChar(state, ")");
  assert.ok(converted);
  assert.equal(converted.doc.textContent, "check");
  const mark = linkMarkOf(converted);
  assert.equal(mark?.attrs.href, "https://example.com");
  assert.equal(mark?.attrs.title, "Docs");
});

test("label marks survive conversion instead of being rebuilt as plain text", () => {
  const state = stateWithRuns([
    { text: "[" },
    { text: "bold", marks: [strongType.create()] },
    { text: "](https://example.com" },
  ]);
  const converted = typeChar(state, ")");
  assert.ok(converted);
  assert.equal(converted.doc.textContent, "bold");

  const runs = [];
  converted.doc.nodesBetween(0, converted.doc.content.size, (node, pos) => {
    if (node.isText) {
      runs.push({
        text: node.text,
        marks: node.marks.map((mark) => mark.type.name),
      });
    }
  });
  assert.deepEqual(runs, [{ text: "bold", marks: ["strong", "link"] }]);
});

test("link mark does not bleed into text typed after the link", () => {
  const state = stateWithRuns([
    { text: "[" },
    { text: "bold", marks: [strongType.create()] },
    { text: "](https://example.com" },
  ]);
  const converted = typeChar(state, ")");
  const stored = converted.storedMarks ?? [];
  assert.ok(
    !stored.some((mark) => mark.type === linkType),
    `link mark leaked into stored marks: ${JSON.stringify(stored)}`,
  );
  // Typing mode keeps the label's own marks (strong), only the link is cleared.
  assert.ok(stored.every((mark) => mark.type === strongType));
});

test("unbalanced or incomplete destinations stay raw text", () => {
  const incomplete = stateWithRuns([{ text: "[article](https://example.com" }]);
  assert.equal(typeChar(incomplete, "x"), null);

  const unbalanced = stateWithRuns([{ text: "[article](https://example.com/a(b" }]);
  assert.equal(typeChar(unbalanced, ")"), null);
  const unbalancedWithTitle = stateWithRuns([{ text: '[a](b(c "Title"' }]);
  assert.equal(typeChar(unbalancedWithTitle, ")"), null);

  // A `)` that closes the pattern early with junk following stays raw too.
  const junk = stateWithRuns([{ text: "[a](b)c" }]);
  assert.equal(typeChar(junk, "d"), null);
});
