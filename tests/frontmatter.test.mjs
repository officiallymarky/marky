import assert from "node:assert/strict";
import { test } from "node:test";

import { combineFrontmatter, splitFrontmatter } from "../src/frontmatter.ts";

const MARK = "\uFEFF";

test("splits a front matter block off the body byte-exact", () => {
  assert.deepEqual(splitFrontmatter("---\ntitle: x\n---\nbody\n"), {
    bom: "",
    front: "---\ntitle: x\n---\n",
    body: "body\n",
  });
  // No trailing newline after the closing fence.
  assert.deepEqual(splitFrontmatter("---\ntitle: x\n---"), {
    bom: "",
    front: "---\ntitle: x\n---",
    body: "",
  });
  // CRLF endings are preserved.
  assert.deepEqual(splitFrontmatter("---\r\ntitle: x\r\n---\r\nbody"), {
    bom: "",
    front: "---\r\ntitle: x\r\n---\r\n",
    body: "body",
  });
});

test("recognizes an empty front matter block", () => {
  // The shape the front matter dialog itself generates for empty fields.
  assert.deepEqual(splitFrontmatter("---\n---\n\nBody\n"), {
    bom: "",
    front: "---\n---\n",
    body: "\nBody\n",
  });
  assert.deepEqual(splitFrontmatter("---\n---\n"), {
    bom: "",
    front: "---\n---\n",
    body: "",
  });
  assert.deepEqual(splitFrontmatter("---\r\n---\r\n"), {
    bom: "",
    front: "---\r\n---\r\n",
    body: "",
  });
  // The block stays as short as possible: a following rule is body text.
  assert.deepEqual(splitFrontmatter("---\n---\n---\n"), {
    bom: "",
    front: "---\n---\n",
    body: "---\n",
  });
});

test("reports a byte-order mark on its own, never as body text", () => {
  const document = `${MARK}---\ntitle: x\n---\nbody\n`;
  assert.deepEqual(splitFrontmatter(document), {
    bom: MARK,
    front: "---\ntitle: x\n---\n",
    body: "body\n",
  });
  const { bom, front, body } = splitFrontmatter(document);
  assert.equal(combineFrontmatter(bom, front, body), document);

  // A mark in a file with no front matter is the case a save used to drop it
  // in: the editor would parse the body, lose the mark, and write it back out.
  assert.deepEqual(splitFrontmatter(`${MARK}# heading\n`), {
    bom: MARK,
    front: null,
    body: "# heading\n",
  });

  // Only the first mark is the file's; a second one is body text.
  assert.deepEqual(splitFrontmatter(`${MARK}${MARK}text\n`), {
    bom: MARK,
    front: null,
    body: `${MARK}text\n`,
  });
});

test("recognizes a fence with trailing spaces", () => {
  const document = "--- \ntitle: x\n--- \nbody\n";
  assert.deepEqual(splitFrontmatter(document), {
    bom: "",
    front: "--- \ntitle: x\n--- \n",
    body: "body\n",
  });
});

test("leaves documents without front matter alone", () => {
  for (const markdown of [
    "",
    "---\n",
    "----\n----\n",
    "text\n---\n---\n",
    "# heading\n",
    "---\nno closing fence\n",
  ]) {
    assert.deepEqual(
      splitFrontmatter(markdown),
      { bom: "", front: null, body: markdown },
      JSON.stringify(markdown),
    );
  }
});

test("rejoining the split parts restores the document", () => {
  for (const markdown of [
    "---\n---\n\nBody\n",
    "---\ntitle: x\n---\nbody\n",
    "---\n\n---\n\nBody\n",
    "plain text\n",
    `${MARK}# heading\n`,
    `${MARK}---\ntitle: x\n---\nbody\n`,
    `${MARK}${MARK}text\n`,
  ]) {
    const { bom, front, body } = splitFrontmatter(markdown);
    assert.equal(
      combineFrontmatter(bom, front, body),
      markdown,
      JSON.stringify(markdown),
    );
  }
});

test("combining without a mark or block yields the body", () => {
  assert.equal(combineFrontmatter("", null, "body\n"), "body\n");
  assert.equal(combineFrontmatter("", "---\ntitle: x\n---", "body\n"), "---\ntitle: x\n---\nbody\n");
  assert.equal(combineFrontmatter(MARK, null, "body\n"), `${MARK}body\n`);
});
