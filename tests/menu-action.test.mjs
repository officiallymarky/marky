import assert from "node:assert/strict";
import { test } from "node:test";
import { ALERT_KINDS } from "../src/alerts.ts";
import { FONT_FAMILIES, FONT_SIZES } from "../src/font.ts";
import { menuOption } from "../src/menu-action.ts";
import { THEMES } from "../src/theme.ts";

test("menuOption finds the option a prefixed menu id names", () => {
  assert.equal(menuOption("theme-nord", "theme-", THEMES)?.id, "nord");
  assert.equal(menuOption("theme-tokyo-night", "theme-", THEMES)?.id, "tokyo-night");
  assert.equal(menuOption("insert-alert-tip", "insert-alert-", ALERT_KINDS), "tip");
});

test("menuOption ignores other prefixes and unknown options", () => {
  assert.equal(menuOption("theme", "theme-", THEMES), undefined);
  assert.equal(menuOption("theme-unknown", "theme-", THEMES), undefined);
  assert.equal(menuOption("insert-toc", "insert-alert-", ALERT_KINDS), undefined);
  // `font-` must not claim a size id, whichever order the caller checks them.
  assert.equal(menuOption("font-size-small", "font-", FONT_FAMILIES), undefined);
  assert.equal(menuOption("font-serif", "font-size-", FONT_SIZES), undefined);
});
