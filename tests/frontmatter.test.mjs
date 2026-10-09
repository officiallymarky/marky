import assert from "node:assert/strict";
import { test } from "node:test";

import { combineFrontmatter, splitFrontmatter } from "../src/frontmatter.ts";

test("splits a front matter block off the body byte-exact", () => {
  assert.deepEqual(splitFrontmatter("---\ntitle: x\n---\nbody\n"), {
    front: "---\ntitle: x\n---\n",
    body: "body\n",
  });
  // No trailing newline after the closing fence.
  assert.deepEqual(splitFrontmatter("---\ntitle: x\n---"), {
    front: "---\ntitle: x\n---",
    body: "",
  });
  // CRLF endings are preserved.
  assert.deepEqual(splitFrontmatter("---\r\ntitle: x\r\n---\r\nbody"), {
    front: "---\r\ntitle: x\r\n---\r\n",
    body: "body",
  });
});

test("recognizes an empty front matter block", () => {
  // The shape the front matter dialog itself generates for empty fields.
  assert.deepEqual(splitFrontmatter("---\n---\n\nBody\n"), {
    front: "---\n---\n",
    body: "\nBody\n",
  });
  assert.deepEqual(splitFrontmatter("---\n---\n"), { front: "---\n---\n", body: "" });
  assert.deepEqual(splitFrontmatter("---\r\n---\r\n"), {
    front: "---\r\n---\r\n",
    body: "",
  });
  // The block stays as short as possible: a following rule is body text.
  assert.deepEqual(splitFrontmatter("---\n---\n---\n"), {
    front: "---\n---\n",
    body: "---\n",
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
      { front: null, body: markdown },
      JSON.stringify(markdown),
    );
  }
});

test("rejoining the split block restores the document", () => {
  for (const markdown of [
    "---\n---\n\nBody\n",
    "---\ntitle: x\n---\nbody\n",
    "---\n\n---\n\nBody\n",
    "plain text\n",
  ]) {
    const { front, body } = splitFrontmatter(markdown);
    assert.equal(combineFrontmatter(front, body), markdown, JSON.stringify(markdown));
  }
});
