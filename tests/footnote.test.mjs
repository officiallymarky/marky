import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@milkdown/kit/prose/model";
import { nextFootnoteIndex, restoreFootnoteRefs } from "../src/footnote.ts";

// Mirrors the @milkdown/preset-gfm footnote schemas: references are inline
// atoms and definitions are blocks, both carrying the label in `attrs.label`
// where a text scan cannot see it.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    blockquote: { group: "block", content: "block+" },
    footnote_definition: {
      group: "block",
      content: "block+",
      attrs: { label: { default: "" } },
    },
    footnote_reference: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { label: { default: "" } },
    },
    text: { group: "inline" },
  },
  marks: {},
});
const inline = (child) => (typeof child === "string" ? schema.text(child) : child);
const paragraph = (...children) =>
  schema.node("paragraph", null, children.map(inline));
const reference = (label) =>
  schema.nodes.footnote_reference.create({ label });
const definition = (label, ...children) =>
  schema.nodes.footnote_definition.create({ label }, children);
const doc = (...blocks) => schema.node("doc", null, blocks);

test("footnote index starts at 1 for a fresh document", () => {
  assert.equal(nextFootnoteIndex(doc(paragraph("Hello world"))), 1);
});

test("footnote index skips numbers stored in parsed references and definitions", () => {
  const parsed = doc(
    paragraph("see ", reference("1"), " here"),
    definition("1", paragraph("the definition")),
  );
  assert.equal(nextFootnoteIndex(parsed), 2);
  const twice = doc(
    paragraph("see ", reference("1"), " and ", reference("2")),
    definition("1", paragraph("one")),
    definition("2", paragraph("two")),
  );
  assert.equal(nextFootnoteIndex(twice), 3);
});

test("footnote index reserves parsed references and definitions independently", () => {
  assert.equal(nextFootnoteIndex(doc(paragraph(reference("1")))), 2);
  assert.equal(nextFootnoteIndex(doc(
    paragraph("Body without a reference"),
    definition("1", paragraph("the definition")),
  )), 2);
});

test("footnote index reserves literal refs inserted in the session", () => {
  assert.equal(nextFootnoteIndex(doc(paragraph("see [^1] here"))), 2);
  assert.equal(nextFootnoteIndex(doc(paragraph("a[^1] b[^2]"))), 3);
  // A session-inserted definition is literal `[^n]: ` paragraph text.
  assert.equal(nextFootnoteIndex(doc(paragraph("[^1]: the definition"))), 2);
});

test("footnote index allocates the smallest number across gaps", () => {
  // 2 was deleted; the next insert reuses it instead of appending 4.
  const gapped = doc(
    paragraph(reference("1"), " and ", reference("3")),
    definition("1", paragraph("one")),
    definition("3", paragraph("three")),
  );
  assert.equal(nextFootnoteIndex(gapped), 2);
});

test("footnote index mixes parsed nodes with session-inserted literals", () => {
  // Reopened document holding [^1] plus a literal [^2] typed this session.
  const mixed = doc(
    paragraph("see ", reference("1"), " and [^2]"),
    definition("1", paragraph("one")),
  );
  assert.equal(nextFootnoteIndex(mixed), 3);
});

test("footnote index ignores named labels", () => {
  const named = doc(
    paragraph("see ", reference("note")),
    definition("note", paragraph("note body")),
  );
  assert.equal(nextFootnoteIndex(named), 1);
  // Mixed numeric and named labels: only the number is reserved.
  const mixed = doc(
    paragraph(reference("1"), " and ", reference("note")),
    definition("1", paragraph("one")),
    definition("note", paragraph("note body")),
  );
  assert.equal(nextFootnoteIndex(mixed), 2);
});

test("footnote index finds references nested in blockquotes", () => {
  const nested = doc(
    schema.node("blockquote", null, [
      paragraph("quoted ", reference("1")),
      definition("1", paragraph("one")),
    ]),
  );
  assert.equal(nextFootnoteIndex(nested), 2);
});

test("footnote index scans text inside parsed definitions", () => {
  // The literal label in a parsed definition body must also be reserved.
  const body = doc(
    paragraph(reference("1")),
    definition("1", paragraph("body [^2]")),
  );
  assert.equal(nextFootnoteIndex(body), 3);
});

test("footnote index only counts footnote-shaped labels", () => {
  // `[see 1]` is not a footnote ref; `[^12]` does not reserve 1 or 2.
  assert.equal(nextFootnoteIndex(doc(paragraph("[see 1]"))), 1);
  assert.equal(nextFootnoteIndex(doc(paragraph("note [^12] here"))), 1);
  // A parsed reference with the default empty label reserves nothing.
  assert.equal(nextFootnoteIndex(doc(paragraph("see ", reference("")))), 1);
});

test("restoreFootnoteRefs un-escapes footnote refs and definitions", () => {
  assert.equal(restoreFootnoteRefs("\\[^1\\]"), "[^1]");
  assert.equal(restoreFootnoteRefs("\\[^1]"), "[^1]");
  assert.equal(restoreFootnoteRefs("\\[^12\\]: the definition"), "[^12]: the definition");
  // Only caret-prefixed bracket numbers count; other escapes stay.
  assert.equal(restoreFootnoteRefs("\\[1\\]"), "\\[1\\]");
  assert.equal(restoreFootnoteRefs("see \\[notes\\] here"), "see \\[notes\\] here");
});

test("restoreFootnoteRefs drops the empty-definition br filler", () => {
  assert.equal(restoreFootnoteRefs("[^1]: <br />"), "[^1]: ");
  assert.equal(restoreFootnoteRefs("[^2]:<br />"), "[^2]:");
  // A real definition body is untouched.
  assert.equal(
    restoreFootnoteRefs("[^1]: see <br /> docs"),
    "[^1]: see <br /> docs",
  );
});
