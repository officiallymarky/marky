import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveFont,
  resolveFontSize,
} from "../src/font.ts";

test("resolveFont keeps a stored family id and defaults otherwise", () => {
  assert.equal(resolveFont("serif"), "serif");
  assert.equal(resolveFont("mono"), "mono");
  assert.equal(resolveFont("system"), "system");
  assert.equal(resolveFont(null), "system");
  assert.equal(resolveFont("comic-sans"), "system");
  assert.equal(resolveFont(""), "system");
});

test("resolveFontSize keeps a stored size id and defaults otherwise", () => {
  assert.equal(resolveFontSize("small"), "small");
  assert.equal(resolveFontSize("large"), "large");
  assert.equal(resolveFontSize(null), "medium");
  assert.equal(resolveFontSize("huge"), "medium");
  assert.equal(resolveFontSize(""), "medium");
});
