import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloseRequestHandler } from "../src/close-flow.ts";

test("discarding changes force-closes without repeating the close request", async () => {
  let dirty = true;
  let preventCount = 0;
  let promptCount = 0;
  let destroyCount = 0;
  const handler = createCloseRequestHandler({
    isDirty: () => dirty,
    confirm: async () => {
      promptCount += 1;
      return "Close without saving";
    },
    save: async () => false,
    destroy: async () => {
      destroyCount += 1;
      dirty = false;
    },
    showError: async () => {},
  });

  await handler({ preventDefault: () => { preventCount += 1; } });

  assert.deepEqual({ preventCount, promptCount, destroyCount }, {
    preventCount: 1,
    promptCount: 1,
    destroyCount: 1,
  });
});

test("saving closes only if the document is still clean afterward", async () => {
  let dirty = true;
  let destroyCount = 0;
  const handler = createCloseRequestHandler({
    isDirty: () => dirty,
    confirm: async () => "Save",
    save: async () => {
      dirty = false;
      return true;
    },
    destroy: async () => { destroyCount += 1; },
    showError: async () => {},
  });

  await handler({ preventDefault() {} });
  assert.equal(destroyCount, 1);

  dirty = true;
  const saveWithLaterEdits = createCloseRequestHandler({
    isDirty: () => dirty,
    confirm: async () => "Save",
    save: async () => true,
    destroy: async () => { destroyCount += 1; },
    showError: async () => {},
  });
  await saveWithLaterEdits({ preventDefault() {} });
  assert.equal(destroyCount, 1);
});
