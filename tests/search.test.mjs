import assert from "node:assert/strict";
import { test } from "node:test";

import { createSearchPanel } from "../src/search.ts";
import { DocumentHistory } from "../src/document-history.ts";

/**
 * Minimal DOM stand-in covering exactly the surface search.ts uses: element
 * lookup by id, event listeners, selection/focus, execCommand("insertText")
 * (which mutates the value and fires `input`, like a real textarea), and the
 * bits of CSS class/attribute plumbing the panel touches.
 */
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.attributes = new Map();
    this.classes = new Set();
    const self = this;
    this.classList = {
      toggle(name, force) {
        if (force) self.classes.add(name);
        else self.classes.delete(name);
      },
    };
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatch(type, event = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      handler({
        target: this,
        key: "",
        shiftKey: false,
        preventDefault() {},
        ...event,
      });
    }
  }

  focus() {
    document.activeElement = this;
  }

  select() {}

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

const PANEL_IDS = [
  ["find-bar", "div"],
  ["find-input", "input"],
  ["find-count", "span"],
  ["find-case", "button"],
  ["find-prev", "button"],
  ["find-next", "button"],
  ["find-close", "button"],
  ["replace-toggle", "button"],
  ["replace-row", "div"],
  ["replace-input", "input"],
  ["replace-one", "button"],
  ["replace-all", "button"],
];

/**
 * Builds an isolated panel over a fake raw textarea. `syncRefresh` mirrors
 * main.ts, where the textarea's `input` event synchronously refreshes the
 * open panel; the off case covers environments where that wiring is absent.
 */
function harness({ syncRefresh = true } = {}) {
  const byId = new Map();
  for (const [id, tag] of PANEL_IDS) byId.set(id, new FakeElement(tag));
  const findInput = byId.get("find-input");
  const findCount = byId.get("find-count");
  const nextBtn = byId.get("find-next");
  const prevBtn = byId.get("find-prev");
  const replaceInput = byId.get("replace-input");
  const replaceOne = byId.get("replace-one");
  const replaceAll = byId.get("replace-all");
  const editor = new FakeElement("textarea");

  const errors = [];
  const history = new DocumentHistory();
  let before = "";
  editor.addEventListener("beforeinput", () => { before = editor.value; });
  // Allow joining to expose missing boundaries around a search action.
  editor.addEventListener("input", () => history.record(before, editor.value, true));
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => byId.get(id) ?? null,
    execCommand(command, _ui, text) {
      if (command !== "insertText") return false;
      const { selectionStart: start, selectionEnd: end, value } = editor;
      editor.dispatch("beforeinput");
      editor.value = value.slice(0, start) + text + value.slice(end);
      editor.selectionStart = editor.selectionEnd = start + text.length;
      editor.dispatch("input");
      return true;
    },
  };
  globalThis.HTMLElement = FakeElement;

  const panel = createSearchPanel({
    rawEditor: editor,
    surface: () => "raw",
    rich: () => null,
    focusSurface() {},
    historyBoundary: () => history.boundary(),
    showError(error) {
      errors.push(error);
    },
  });
  if (syncRefresh) editor.addEventListener("input", () => panel.refresh());

  const search = (needle, replacement = "") => {
    panel.open(true);
    findInput.value = needle;
    findInput.dispatch("input");
    replaceInput.value = replacement;
  };

  return {
    panel,
    editor,
    errors,
    search,
    count: () => findCount.textContent,
    countEl: findCount,
    next: () => nextBtn.dispatch("click"),
    prev: () => prevBtn.dispatch("click"),
    replaceOne: () => replaceOne.dispatch("click"),
    replaceAll: () => replaceAll.dispatch("click"),
    undo() {
      const value = history.undo();
      if (value !== null) editor.value = value;
      panel.refresh();
      return value;
    },
    redo() {
      const value = history.redo();
      if (value !== null) editor.value = value;
      panel.refresh();
      return value;
    },
  };
}

const selection = (editor) => [editor.selectionStart, editor.selectionEnd];

/** Deletes [start, end) or inserts `text` through execCommand (fires input). */
function edit(editor, start, end, text) {
  editor.setSelectionRange(start, end);
  document.execCommand("insertText", false, text);
}

test("deleting the selected match keeps replace working on the survivor", () => {
  const h = harness();
  h.editor.value = "x x";
  h.search("x", "y");
  h.next(); // select the second match
  assert.deepEqual(selection(h.editor), [2, 3]);

  edit(h.editor, 2, 3, ""); // delete it; input fires → synchronous refresh
  assert.equal(h.editor.value, "x ");
  assert.equal(h.count(), "1 of 1");
  assert.equal(h.errors.length, 0);

  h.replaceOne();
  assert.equal(h.editor.value, "y ");
  assert.equal(h.errors.length, 0);
  assert.equal(h.count(), "No results");
});

test("replace-current recomputes matches even when input does not refresh", () => {
  const h = harness({ syncRefresh: false });
  h.editor.value = "x x";
  h.search("x", "y");

  h.replaceOne();
  assert.equal(h.editor.value, "y x");
  assert.deepEqual(selection(h.editor), [2, 3]);
  assert.equal(h.count(), "1 of 1");

  h.replaceOne();
  assert.equal(h.editor.value, "y y");
  assert.equal(h.errors.length, 0);
  assert.equal(h.count(), "No results");
});

test("replacement containing the needle advances past itself, never wrapping", () => {
  const h = harness();
  h.editor.value = "x x";
  h.search("x", "xy");

  h.replaceOne();
  assert.equal(h.editor.value, "xy x");
  // The original second match, not the freshly written "xy" at 0.
  assert.deepEqual(selection(h.editor), [3, 4]);

  h.replaceOne();
  assert.equal(h.editor.value, "xy xy");
  // Replaced [3,4]; the caret parks after it with no wrapped re-target.
  assert.deepEqual(selection(h.editor), [5, 5]);
  assert.equal(h.count(), "0 of 2");
  assert.equal(h.errors.length, 0);
  h.replaceOne();
  assert.equal(h.editor.value, "xy xy");
  assert.equal(h.count(), "0 of 2");
});

test("insertion before the current match retargets by position, not index", () => {
  const h = harness();
  h.editor.value = "x x x";
  h.search("x", "y");
  h.next();
  h.next(); // third match [4,5]
  assert.deepEqual(selection(h.editor), [4, 5]);

  edit(h.editor, 0, 0, "q");
  assert.equal(h.editor.value, "qx x x");
  assert.equal(h.count(), "3 of 3"); // still the same (shifted) match

  h.replaceOne();
  assert.equal(h.editor.value, "qx x y");
  assert.equal(h.errors.length, 0);
});

test("a long insertion before the tracked match keeps its target", () => {
  const h = harness();
  h.editor.value = "x x x";
  h.search("x", "y");
  h.next();
  h.next();

  edit(h.editor, 0, 0, "a long prefix ");
  const focus = document.activeElement;
  const caret = selection(h.editor);
  h.panel.refresh();
  assert.equal(document.activeElement, focus);
  assert.deepEqual(selection(h.editor), caret);
  h.replaceOne();
  assert.equal(h.editor.value, "a long prefix x x y");
  assert.equal(h.errors.length, 0);
});

test("repeated text does not make an earlier insertion look like an append", () => {
  const h = harness();
  h.editor.value = "x x x";
  h.search("x", "y");
  h.next();

  edit(h.editor, 0, 0, "x ");
  h.replaceOne();
  assert.equal(h.editor.value, "x x y x");
  assert.equal(h.errors.length, 0);
});

test("repeated text does not make an earlier deletion look like truncation", () => {
  const h = harness();
  h.editor.value = "x x x";
  h.search("x", "y");
  h.next();

  edit(h.editor, 0, 2, "");
  h.replaceOne();
  assert.equal(h.editor.value, "y x");
  assert.equal(h.errors.length, 0);
});

test("deleting an earlier match keeps the tracked current match", () => {
  const h = harness();
  h.editor.value = "x x x";
  h.search("x", "y");
  h.next();
  h.next(); // third match [4,5]

  edit(h.editor, 0, 1, ""); // delete the first match
  assert.equal(h.editor.value, " x x");
  assert.equal(h.count(), "2 of 2"); // third match, shifted to [3,4]

  h.replaceOne();
  assert.equal(h.editor.value, " x y");
  assert.equal(h.errors.length, 0);
});

for (const { source, replacement, replaced } of [
  {
    source: "# Note\nx 🐈 **X**\nplain x.\n",
    replacement: "longer x$&\n",
    replaced: "# Note\nlonger x$&\n 🐈 **longer x$&\n**\nplain longer x$&\n.\n",
  },
  { source: "xxx", replacement: "", replaced: "" },
]) {
  test(`replace-all undo/redo stays separate from neighboring edits (${JSON.stringify(replacement)})`, () => {
    const h = harness();
    h.editor.value = source;
    edit(h.editor, 0, 0, "Before\n");
    h.search("x", replacement);

    h.replaceAll();
    assert.equal(h.editor.value, `Before\n${replaced}`);
    edit(h.editor, h.editor.value.length, h.editor.value.length, "After\n");
    assert.equal(h.undo(), `Before\n${replaced}`);
    assert.equal(h.undo(), `Before\n${source}`);
    assert.equal(h.undo(), source);
    assert.equal(h.redo(), `Before\n${source}`);
    assert.equal(h.redo(), `Before\n${replaced}`);
    assert.equal(h.redo(), `Before\n${replaced}After\n`);
    assert.equal(h.errors.length, 0);
  });
}

test("replace-all is stable when replacements contain the needle", () => {
  const h = harness();
  h.editor.value = "x x";
  h.search("x", "x.");

  h.replaceAll();
  assert.equal(h.editor.value, "x. x.");
  assert.equal(h.errors.length, 0);
});

test("no matches disables replacement and keeps the count coherent", () => {
  const h = harness();
  h.editor.value = "x x";
  h.search("z", "y");

  assert.equal(h.count(), "No results");
  assert.ok(h.countEl.classes.has("no-results"));

  h.replaceOne();
  assert.equal(h.editor.value, "x x");
  h.replaceAll();
  assert.equal(h.editor.value, "x x");
  h.next();
  h.prev();
  assert.deepEqual(selection(h.editor), [0, 0]);
  assert.equal(h.errors.length, 0);
});

test("next and prev wrap around the surviving matches", () => {
  const h = harness();
  h.editor.value = "x x";
  h.search("x", "y");
  assert.deepEqual(selection(h.editor), [0, 1]);

  h.next();
  assert.deepEqual(selection(h.editor), [2, 3]);
  h.next();
  assert.deepEqual(selection(h.editor), [0, 1]); // wrapped forward
  h.prev();
  assert.deepEqual(selection(h.editor), [2, 3]);
  h.prev();
  assert.deepEqual(selection(h.editor), [0, 1]); // wrapped backward
  assert.equal(h.errors.length, 0);
});

test("adjacent matches stay individually reachable and replaceable", () => {
  const h = harness();
  h.editor.value = "hello";
  h.search("l", "L");
  assert.deepEqual(selection(h.editor), [2, 3]);
  assert.equal(h.count(), "1 of 2");

  // The second "l" starts where the first ends.
  h.next();
  assert.deepEqual(selection(h.editor), [3, 4]);
  assert.equal(h.count(), "2 of 2");

  h.replaceOne();
  assert.equal(h.editor.value, "helLo");
  assert.equal(h.errors.length, 0);
});
