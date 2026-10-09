import assert from "node:assert/strict";
import { test } from "node:test";

import { restoreMarkdownMarkers } from "../src/markdown-markers.ts";

test("restores escaped markers in prose", () => {
  assert.equal(
    restoreMarkdownMarkers("> \\[!NOTE]\\\n> Useful information.\n"),
    "> [!NOTE]\\\n> Useful information.\n",
  );
  assert.equal(restoreMarkdownMarkers("see \\[^1] here"), "see [^1] here");
  assert.equal(restoreMarkdownMarkers("\\[^12\\]: the definition"), "[^12]: the definition");
  // An empty parsed definition round-trips with a filler that is dropped.
  assert.equal(restoreMarkdownMarkers("[^1]: <br />"), "[^1]: ");
  assert.equal(restoreMarkdownMarkers("plain text"), "plain text");
});

test("leaves fenced code byte-exact", () => {
  const fence = "```\nhelZlo   \\[!NOTE] \\[^1] [^1]: <br />\n```\n\nQ\n";
  assert.equal(restoreMarkdownMarkers(fence), fence);
  const tilde = "~~~js\n\\[!TIP]\n~~~\n";
  assert.equal(restoreMarkdownMarkers(tilde), tilde);
  const indented = "  ```\n\\[!WARNING]\n  ```\n";
  assert.equal(restoreMarkdownMarkers(indented), indented);
  // A longer fence protects the shorter runs inside it.
  const long = "````\n```\n\\[!NOTE]\n```\n````\n";
  assert.equal(restoreMarkdownMarkers(long), long);
  // An unclosed fence runs to the end of the document.
  const unclosed = "```\n\\[!NOTE]";
  assert.equal(restoreMarkdownMarkers(unclosed), unclosed);
});

test("leaves inline code byte-exact", () => {
  const inline = "write `\\[!NOTE]` for a literal marker\n";
  assert.equal(restoreMarkdownMarkers(inline), inline);
  const multi = "write ``\\[^1]`` and `\\[!TIP]`\n";
  assert.equal(restoreMarkdownMarkers(multi), multi);
});

test("restores prose around code without touching the code", () => {
  const markdown = [
    "\\[!NOTE] prose",
    "",
    "```",
    "\\[!NOTE] code",
    "```",
    "",
    "after `\\[^1]` the \\[^2] ref",
    "",
  ].join("\n");
  assert.equal(
    restoreMarkdownMarkers(markdown),
    [
      "[!NOTE] prose",
      "",
      "```",
      "\\[!NOTE] code",
      "```",
      "",
      "after `\\[^1]` the [^2] ref",
      "",
    ].join("\n"),
  );
});

test("a document without code is transformed end to end", () => {
  const markdown = "\\[!CAUTION]\n\nfirst \\[^1]\n\n[^1]: <br />\n";
  assert.equal(
    restoreMarkdownMarkers(markdown),
    "[!CAUTION]\n\nfirst [^1]\n\n[^1]: \n",
  );
});
