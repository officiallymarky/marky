import assert from "node:assert/strict";
import { test } from "node:test";
import { DocumentState } from "../src/document-state.ts";
import { createSaveHandler } from "../src/save-flow.ts";

function document(path, content) {
  const state = new DocumentState();
  state.load(content);
  return { path, name: path ?? "Untitled", state };
}

function deferred() {
  return Promise.withResolvers();
}

test("finishing an old document's save cannot redirect the current document's next save", async () => {
  const first = document("a.md", "original A");
  first.state.update("edited A");
  let current = first;
  const started = deferred();
  const release = deferred();
  const files = new Map();
  const save = createSaveHandler(() => current, async (path, content) => {
    if (path === "a.md") {
      started.resolve();
      await release.promise;
    }
    files.set(path, content);
    return { path, name: path };
  });

  const savingA = save();
  await started.promise;
  current = document("b.md", "original B");
  release.resolve();
  assert.deepEqual(
    await savingA,
    { kind: "stale" },
    "an old save must not authorize closing B",
  );
  assert.equal(current.path, "b.md");
  assert.equal(current.state.dirty, false);
  current.state.update("edited B");
  assert.deepEqual(await save(), { kind: "saved" });
  assert.deepEqual([...files], [["a.md", "edited A"], ["b.md", "edited B"]]);
  assert.equal(current.state.dirty, false);
});

test("overlapping saves finish in order and use the path selected by an earlier Save As", async () => {
  const current = document(null, "initial");
  current.state.update("first snapshot");
  const started = deferred();
  const release = deferred();
  const destinations = [];
  const files = new Map();
  let activeWrites = 0;
  let maximumWrites = 0;
  const save = createSaveHandler(() => current, async (path, content) => {
    activeWrites += 1;
    maximumWrites = Math.max(maximumWrites, activeWrites);
    destinations.push(path);
    if (path === null) {
      started.resolve();
      await release.promise;
      path = "chosen.md";
    }
    files.set(path, content);
    activeWrites -= 1;
    return { path, name: "chosen.md" };
  });

  const first = save(true);
  await started.promise;
  current.state.update("second snapshot");
  const second = save();
  current.state.update("unsaved edit");
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(maximumWrites, 1);
  assert.deepEqual(destinations, [null, "chosen.md"]);
  assert.equal(files.get("chosen.md"), "second snapshot");
  assert.equal(current.state.content, "unsaved edit");
  assert.equal(current.state.dirty, true);
});

test("a failed save leaves edits dirty and does not prevent the next save", async () => {
  const current = document("a.md", "original");
  current.state.update("edit");
  let fail = true;
  let persisted;
  const save = createSaveHandler(() => current, async (path, content) => {
    if (fail) throw new Error("write failed");
    persisted = content;
    return { path, name: "a.md" };
  });
  await assert.rejects(save(), /write failed/);
  assert.equal(current.state.dirty, true);
  fail = false;
  assert.deepEqual(await save(), { kind: "saved" });
  assert.equal(persisted, "edit");
  assert.equal(current.state.dirty, false);
});

test("a conflict leaves the document dirty and can be forced through", async () => {
  const current = document("a.md", "original");
  current.state.update("edit");
  const writes = [];
  const save = createSaveHandler(() => current, async (path, content, force) => {
    writes.push({ path, content, force });
    if (!force) return { path, name: "a.md", conflict: "changed" };
    return { path, name: "a.md" };
  });

  assert.deepEqual(await save(), { kind: "conflict", conflict: "changed" });
  assert.equal(current.state.dirty, true, "a blocked save must stay dirty");
  assert.deepEqual(await save(false, true), { kind: "saved" });
  assert.equal(current.state.dirty, false);
  assert.deepEqual(writes, [
    { path: "a.md", content: "edit", force: false },
    { path: "a.md", content: "edit", force: true },
  ]);
});

test("cancelling Save As preserves the document path and unsaved state", async () => {
  const current = document("a.md", "original");
  current.state.update("edit");
  const save = createSaveHandler(() => current, async () => ({ path: null, name: null }));
  assert.deepEqual(await save(true), { kind: "cancelled" });
  assert.equal(current.path, "a.md");
  assert.equal(current.state.dirty, true);
});
