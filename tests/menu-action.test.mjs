import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ALERT_KINDS } from "../src/alerts.ts";
import { FONT_FAMILIES, FONT_SIZES } from "../src/font.ts";
import { menuOption } from "../src/menu-action.ts";
import { THEMES } from "../src/theme.ts";

const menuIds = [
  ...readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8")
    .matchAll(/\.text\("([^"]+)"/g),
].map((match) => match[1]);

/** Option ids the native menu offers under `prefix`, minus longer prefixes. */
function offered(prefix, ...excluded) {
  return menuIds
    .filter((id) => id.startsWith(prefix) && !excluded.some((other) => id.startsWith(other)))
    .map((id) => id.slice(prefix.length));
}

const ids = (options) => options.map((option) => option.id);

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

test("the native menu offers exactly the frontend's options", () => {
  assert.deepEqual(offered("theme-"), ids(THEMES));
  assert.deepEqual(offered("font-", "font-size-"), ids(FONT_FAMILIES));
  assert.deepEqual(offered("font-size-"), ids(FONT_SIZES));
  assert.deepEqual(offered("insert-alert-"), ALERT_KINDS);
});
