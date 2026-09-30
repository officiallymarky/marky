import assert from "node:assert/strict";
import { test } from "node:test";
import { getDocumentTitle } from "../src/frontmatter.ts";

test("reads plain and quoted YAML title scalars", () => {
  assert.equal(
    getDocumentTitle("---\ntitle: Project notes\n---\n", "notes.md"),
    "Project notes",
  );
  assert.equal(
    getDocumentTitle('---\ntitle: "Release: #1"\n---\n', "notes.md"),
    "Release: #1",
  );
  assert.equal(
    getDocumentTitle("---\ntitle: 'Reader''s guide'\n---\n", "notes.md"),
    "Reader's guide",
  );
  assert.equal(
    getDocumentTitle("---\ntitle: Project notes # comment\n---\n", "notes.md"),
    "Project notes",
  );
  assert.equal(
    getDocumentTitle('---\r\ntitle:\t"# Heading"\r\n---\r\n', "notes.md"),
    "# Heading",
  );
});

test("falls back to the file name for missing or unsupported title values", () => {
  for (const frontmatter of [
    null,
    "---\nsummary: A note\n---\n",
    "---\nsummary:\n  title: Nested title\n---\n",
    "---\ntitle:\n---\n",
    "---\ntitle:\ndate: 2026-09-27\n---\n",
    "---\r\ntitle:\t\r\ndate: 2026-09-27\r\n---\r\n",
    "---\ntitle: # no title\n---\n",
    "---\ntitle:\n# no title\ndate: 2026-09-27\n---\n",
    "---\ntitle: 42\n---\n",
    "---\ntitle: 0x2A\n---\n",
    "---\ntitle: >-\n  Multi-line title\n---\n",
    "---\ntitle: [unterminated\n---\n",
  ]) {
    assert.equal(getDocumentTitle(frontmatter, "notes.md"), "notes.md");
  }
});
