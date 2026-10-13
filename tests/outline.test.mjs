import assert from "node:assert/strict";
import { test } from "node:test";

import { collectSourceHeadings } from "../src/outline.ts";

// mdast-like nodes, hand-built with the body offsets the editor's remark parser
// reports: src/editor.ts hands collectSourceHeadings remark's mdast Root, whose
// heading positions are absolute offsets into the parsed body.
const text = (value) => ({ type: "text", value });
const image = (alt) => ({ type: "image", alt, url: "x.png" });
const link = (children) => ({ type: "link", url: "https://example.com", children });

const heading = (depth, children, start) => ({
  type: "heading",
  depth,
  children,
  position: { start: { offset: start }, end: { offset: start } },
});

const root = (...children) => ({ type: "root", children });

/** Parser stub: returns a fixed tree and records every body it was handed. */
function stub(...children) {
  const bodies = [];
  return {
    bodies,
    parse: (body) => {
      bodies.push(body);
      return root(...children);
    },
  };
}

/** The fields the outline shows; `id` is left out of most assertions because
 *  source headings invent none. */
const shape = (headings) =>
  headings.map(({ text: label, pos, level, depth }) => ({ text: label, pos, level, depth }));

test("front matter shifts heading positions so they index the whole source", () => {
  const cases = [
    {
      source: "---\ntitle: x\n---\n# Title\n## Sub\n",
      body: "# Title\n## Sub\n",
      spec: [
        [1, "Title", 0],
        [2, "Sub", 8],
      ],
      positions: [17, 25],
    },
    {
      // The byte-order mark belongs to the front matter block, so it shifts too.
      source: "\uFEFF---\ntitle: x\n---\n# Title\n",
      body: "# Title\n",
      spec: [[1, "Title", 0]],
      positions: [18],
    },
    {
      source: "---\r\ntitle: x\r\n---\r\n# Title\r\n",
      body: "# Title\r\n",
      spec: [[1, "Title", 0]],
      positions: [20],
    },
  ];
  for (const { source, body, spec, positions } of cases) {
    const { bodies, parse } = stub(
      ...spec.map(([depth, label, start]) => heading(depth, [text(label)], start)),
    );
    const headings = collectSourceHeadings(source, parse);
    // The parser only ever sees the body ...
    assert.deepEqual(bodies, [body], source);
    assert.deepEqual(headings.map(({ pos }) => pos), positions, source);
    // ... yet every position lands on the heading line of the full source.
    for (const pos of positions) assert.match(source.slice(pos), /^#{1,6} /, source);
  }
});

test("without front matter heading positions index the source unchanged", () => {
  const source = "Intro\n=====\n\ntext\n\n## Details\n";
  const { bodies, parse } = stub(heading(1, [text("Intro")], 0), heading(2, [text("Details")], 19));
  assert.deepEqual(shape(collectSourceHeadings(source, parse)), [
    { text: "Intro", pos: 0, level: 1, depth: 0 },
    { text: "Details", pos: 19, level: 2, depth: 1 },
  ]);
  assert.deepEqual(bodies, [source]);
});

test("ATX and Setext headings appear together in document order", () => {
  const source = "# First\n\nSecond\n======\n\n### Third\n";
  const { parse } = stub(
    heading(1, [text("First")], 0),
    heading(1, [text("Second")], 9),
    heading(3, [text("Third")], 24),
  );
  assert.deepEqual(shape(collectSourceHeadings(source, parse)), [
    { text: "First", pos: 0, level: 1, depth: 0 },
    // A Setext heading's position starts at its text line, not at the underline.
    { text: "Second", pos: 9, level: 1, depth: 0 },
    { text: "Third", pos: 24, level: 3, depth: 1 },
  ]);
  assert.equal(source.slice(9, 15), "Second");
  assert.equal(source.slice(16, 22), "======");
});

test("headings inside fenced code are excluded", () => {
  const source = "```md\n# Not a heading\n```\n\n# Real\n";
  // remark reports the whole fence as one code node, so its "#" is not a heading.
  const { parse } = stub(
    {
      type: "code",
      lang: "md",
      value: "# Not a heading",
      position: { start: { offset: 0 }, end: { offset: 26 } },
    },
    heading(1, [text("Real")], 27),
  );
  assert.deepEqual(shape(collectSourceHeadings(source, parse)), [
    { text: "Real", pos: 27, level: 1, depth: 0 },
  ]);
  assert.equal(source.slice(6, 21), "# Not a heading");
});

test("heading hierarchy nests by level and duplicate titles stay separately navigable", () => {
  const source = "# A\n\n## B\n\n## B\n\n### C\n\n# D\n";
  const { parse } = stub(
    heading(1, [text("A")], 0),
    heading(2, [text("B")], 5),
    heading(2, [text("B")], 11),
    heading(3, [text("C")], 17),
    heading(1, [text("D")], 24),
  );
  const headings = collectSourceHeadings(source, parse);
  assert.deepEqual(shape(headings), [
    { text: "A", pos: 0, level: 1, depth: 0 },
    { text: "B", pos: 5, level: 2, depth: 1 },
    // The second "B" is its own entry: same text and level, a different position.
    { text: "B", pos: 11, level: 2, depth: 1 },
    { text: "C", pos: 17, level: 3, depth: 2 },
    { text: "D", pos: 24, level: 1, depth: 0 },
  ]);
  assert.deepEqual(headings.map(({ id }) => id), ["", "", "", "", ""]);
});

test("headings with empty or whitespace-only text are skipped", () => {
  const source = "##   \n\n#\n\n## Real\n";
  const { parse } = stub(heading(2, [text("   ")], 0), heading(1, [], 7), heading(2, [text("Real")], 10));
  // Skipped headings never join the level stack, so "Real" starts at depth 0.
  assert.deepEqual(shape(collectSourceHeadings(source, parse)), [
    { text: "Real", pos: 10, level: 2, depth: 0 },
  ]);
});

test("heading text is assembled from child nodes, with image alt text standing in for the image", () => {
  const source =
    "# Hello **world** and `npm test`\n\n## ![diagram](d.png)\n\n### [docs](https://example.com)\n\n#### ![](x.png)\n";
  const { parse } = stub(
    heading(
      1,
      [
        text("Hello "),
        { type: "strong", children: [text("world")] },
        text(" and "),
        { type: "inlineCode", value: "npm test" },
      ],
      0,
    ),
    heading(2, [image("diagram")], 34),
    heading(3, [link([text("docs")])], 56),
    heading(4, [image("")], 89),
  );
  assert.deepEqual(shape(collectSourceHeadings(source, parse)), [
    { text: "Hello world and npm test", pos: 0, level: 1, depth: 0 },
    // An image contributes its alt text, never its URL.
    { text: "diagram", pos: 34, level: 2, depth: 1 },
    { text: "docs", pos: 56, level: 3, depth: 2 },
    // "#### ![](x.png)" has no alt text, so it has nothing to show and is skipped.
  ]);
});

test("headings inside blockquotes and list items keep their source offsets", () => {
  const source = "> # Quoted\n\n- ## Item\n\nBody\n";
  const { parse } = stub(
    { type: "blockquote", children: [heading(1, [text("Quoted")], 2)] },
    { type: "list", children: [{ type: "listItem", children: [heading(2, [text("Item")], 14)] }] },
  );
  assert.deepEqual(shape(collectSourceHeadings(source, parse)), [
    { text: "Quoted", pos: 2, level: 1, depth: 0 },
    { text: "Item", pos: 14, level: 2, depth: 1 },
  ]);
  assert.equal(source.slice(2, 10), "# Quoted");
  assert.equal(source.slice(14, 21), "## Item");
});

test("headings without a source position are skipped", () => {
  const source = "# Real\n";
  // A heading the parser could not locate cannot be scrolled to, so it is dropped
  // rather than listed with an unusable position.
  const { parse } = stub(
    { type: "heading", depth: 1, children: [text("Unpositioned")] },
    heading(1, [text("Real")], 0),
  );
  assert.deepEqual(shape(collectSourceHeadings(source, parse)), [
    { text: "Real", pos: 0, level: 1, depth: 0 },
  ]);
});

test("a reference-style image contributes its alt text like an inline one", () => {
  const source = "# ![diagram][d]\n\n# See ![icon][i] here\n\n[d]: d.png\n[i]: i.png\n";
  const reference = (alt, label) => ({
    type: "imageReference",
    alt,
    label,
    identifier: label,
  });
  const { parse } = stub(
    heading(1, [reference("diagram", "d")], 0),
    heading(1, [text("See "), reference("icon", "i"), text(" here")], 17),
  );
  // A reference image carries neither children nor a value, so reading only
  // `image` made the first heading empty and dropped it from the outline.
  assert.deepEqual(shape(collectSourceHeadings(source, parse)), [
    { text: "diagram", pos: 0, level: 1, depth: 0 },
    { text: "See icon here", pos: 17, level: 1, depth: 0 },
  ]);
});
