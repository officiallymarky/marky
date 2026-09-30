import assert from "node:assert/strict";
import { test } from "node:test";
import { nextFootnoteIndex, restoreFootnoteRefs } from "../src/footnote.ts";

test("footnote index starts at 1 for a fresh document", () => {
  assert.equal(nextFootnoteIndex(""), 1);
  assert.equal(nextFootnoteIndex("Hello world"), 1);
});

test("footnote index skips numbers already used as refs", () => {
  assert.equal(nextFootnoteIndex("see [^1] here"), 2);
  assert.equal(nextFootnoteIndex("a[^1] b[^2]"), 3);
});

test("footnote index recognizes definitions too", () => {
  assert.equal(nextFootnoteIndex("[^1]: the definition"), 2);
  // A different number in brackets is not a footnote ref.
  assert.equal(nextFootnoteIndex("[see 1]"), 1);
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
