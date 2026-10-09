import assert from "node:assert/strict";
import { test } from "node:test";
import { runOpenFlow } from "../src/open-flow.ts";

/**
 * Minimal stand-in for the live document: `isCurrent` and `revision` describe
 * the state an open was authorized for, and `open` may move both while it runs.
 */
function fixture(overrides = {}) {
  const replaced = [];
  const reported = [];
  const state = { current: true, revision: 7 };
  return {
    replaced,
    reported,
    state,
    dependencies: {
      open: async () => ({ path: "notes.md", content: "# Notes\n" }),
      replace: async (document) => {
        replaced.push(document);
      },
      showError: async (title, error) => {
        reported.push({ title, error });
      },
      isCurrent: () => state.current,
      revision: () => state.revision,
      ...overrides,
    },
  };
}

test("open failures are reported without replacing the current document", async () => {
  const openError = new Error("Could not open notes.md");
  const failure = fixture({
    open: async () => {
      throw openError;
    },
  });

  await runOpenFlow(failure.dependencies);

  assert.deepEqual(failure.replaced, []);
  assert.deepEqual(failure.reported, [{ title: "Open failed", error: openError }]);
});

test("a cancelled open leaves the current document alone", async () => {
  const cancelled = fixture({ open: async () => null });

  await runOpenFlow(cancelled.dependencies);

  assert.deepEqual(cancelled.replaced, []);
  assert.deepEqual(cancelled.reported, []);
});

test("an open result replaces the document when nothing moved meanwhile", async () => {
  const unchanged = fixture();

  await runOpenFlow(unchanged.dependencies);

  assert.deepEqual(unchanged.replaced, [{ path: "notes.md", content: "# Notes\n" }]);
});

test("edits made while the read ran are not discarded by a late result", async () => {
  const edited = fixture({
    open: async () => {
      edited.state.revision += 1;
      return { path: "notes.md", content: "# Notes\n" };
    },
  });

  await runOpenFlow(edited.dependencies);

  assert.deepEqual(edited.replaced, []);
});

test("a late result cannot replace a document that was switched meanwhile", async () => {
  const switched = fixture({
    open: async () => {
      switched.state.current = false;
      return { path: "notes.md", content: "# Notes\n" };
    },
  });

  await runOpenFlow(switched.dependencies);

  assert.deepEqual(switched.replaced, []);
  assert.deepEqual(switched.reported, []);
});
