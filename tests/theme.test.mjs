import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextTheme,
  resolveTheme,
} from "../src/theme.ts";

test("resolveTheme prefers a stored theme id, including legacy values", () => {
  assert.equal(resolveTheme("sepia", true).id, "sepia");
  assert.equal(resolveTheme("nord", false).id, "nord");
  // Legacy storage from before multiple themes used exactly these values.
  assert.equal(resolveTheme("dark", false).id, "dark");
  assert.equal(resolveTheme("light", true).id, "light");
});

test("resolveTheme falls back to the OS preference for absent or unknown values", () => {
  assert.equal(resolveTheme(null, true).id, "dark");
  assert.equal(resolveTheme(null, false).id, "light");
  assert.equal(resolveTheme("neon", true).id, "dark");
  assert.equal(resolveTheme("", false).id, "light");
});

test("nextTheme cycles through every theme and wraps around", () => {
  const order = [
    "light",
    "sepia",
    "solarized",
    "dark",
    "nord",
    "dracula",
    "catppuccin",
    "tokyo-night",
  ];
  let id = "light";
  const visited = [id];
  for (let i = 0; i < order.length * 2 - 1; i++) {
    id = nextTheme(id).id;
    if (i < order.length - 1) visited.push(id);
  }
  assert.deepEqual(visited, order);
  // One full cycle lands back on light.
  assert.equal(nextTheme("tokyo-night").id, "light");
  assert.equal(nextTheme("dracula").id, "catppuccin");
  assert.equal(nextTheme("light").id, "sepia");
});
