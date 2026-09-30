import assert from "node:assert/strict";
import { test } from "node:test";
import { runOpenFlow } from "../src/open-flow.ts";

test("open failures are reported without replacing the current document", async () => {
  const openError = new Error("Could not open notes.md");
  const reportedErrors = [];
  let replacementStarted = false;

  await runOpenFlow({
    open: async () => { throw openError; },
    replace: async () => { replacementStarted = true; },
    showError: async (title, error) => { reportedErrors.push({ title, error }); },
  });

  assert.equal(replacementStarted, false);
  assert.deepEqual(reportedErrors, [{ title: "Open failed", error: openError }]);
});
