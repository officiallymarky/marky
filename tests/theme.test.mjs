import assert from "node:assert/strict";
import { test } from "node:test";
import {
  THEMES,
  nextTheme,
  resolveTheme,
  themeById,
} from "../src/theme.ts";

test("THEMES lists every built-in palette with its dark-family flag", () => {
  assert.deepEqual(
    THEMES.map((theme) => [theme.id, theme.dark]),
    [
      ["light", false],
      ["sepia", false],
      ["solarized", false],
      ["dark", true],
      ["nord", true],
      ["dracula", true],
    ],
  );
});

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
  const order = ["light", "sepia", "solarized", "dark", "nord", "dracula"];
  let id = "light";
  const visited = [id];
  for (let i = 0; i < order.length * 2 - 1; i++) {
    id = nextTheme(id).id;
    if (i < order.length - 1) visited.push(id);
  }
  assert.deepEqual(visited, order);
  // One full cycle lands back on light.
  assert.equal(nextTheme("dracula").id, "light");
  assert.equal(nextTheme("light").id, "sepia");
});

test("themeById returns the definition for a valid id and throws otherwise", () => {
  assert.equal(themeById("dracula").label, "Dracula");
  assert.equal(themeById("solarized").dark, false);
  assert.equal(themeById("nord").label, "Nord");
  assert.equal(themeById("sepia").dark, false);
  assert.throws(() => themeById("neon"), /Unknown theme/);
});
