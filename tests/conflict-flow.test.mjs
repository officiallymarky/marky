import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleExternalChange,
  resolveSaveConflict,
} from "../src/conflict-flow.ts";

/** Collects the order in which the flow calls its dependencies. */
function trace() {
  const calls = [];
  return {
    calls,
    entry: (name) => {
      calls.push(name);
      return Promise.resolve();
    },
  };
}

test("overwriting writes the buffer over the version on disk", async () => {
  const { calls, entry } = trace();
  const saved = await resolveSaveConflict("changed", {
    choose: async (kind) => {
      calls.push(`choose:${kind}`);
      return "overwrite";
    },
    overwrite: async () => {
      await entry("overwrite");
      return true;
    },
    alternate: () => entry("alternate").then(() => false),
    showError: () => entry("error").then(() => undefined),
  });

  assert.equal(saved, true);
  assert.deepEqual(calls, ["choose:changed", "overwrite"]);
});

test("adopting the on-disk version also leaves the document in sync", async () => {
  const { calls, entry } = trace();
  const saved = await resolveSaveConflict("removed", {
    choose: async (kind) => {
      calls.push(`choose:${kind}`);
      return "alternate";
    },
    overwrite: () => entry("overwrite").then(() => false),
    alternate: async () => {
      await entry("alternate");
      return true;
    },
    showError: () => entry("error").then(() => undefined),
  });

  assert.equal(saved, true);
  assert.deepEqual(calls, ["choose:removed", "alternate"]);
});

test("keeping the edits writes nothing and reports the document as unsaved", async () => {
  const { calls } = trace();
  const saved = await resolveSaveConflict("changed", {
    choose: async () => "keep-editing",
    overwrite: () => Promise.resolve(true),
    alternate: () => Promise.resolve(true),
    showError: (title) => Promise.resolve(calls.push(`error:${title}`)),
  });

  assert.equal(saved, false);
  assert.deepEqual(calls, []);
});

test("a failure while asking is reported as a save failure", async () => {
  const reported = [];
  const saved = await resolveSaveConflict("changed", {
    choose: async () => {
      throw new Error("dialog unavailable");
    },
    overwrite: () => Promise.resolve(true),
    alternate: () => Promise.resolve(true),
    showError: async (title, error) => {
      reported.push([title, error.message]);
    },
  });

  assert.equal(saved, false);
  assert.deepEqual(reported, [["Save failed", "dialog unavailable"]]);
});

test("a failed overwrite and a failed reload report their own titles", async () => {
  const reported = [];
  const dependencies = (choice) => ({
    choose: async () => choice,
    overwrite: async () => {
      throw new Error("disk full");
    },
    alternate: async () => {
      throw new Error("gone");
    },
    showError: async (title, error) => {
      reported.push([title, error.message]);
    },
  });

  assert.equal(await resolveSaveConflict("changed", dependencies("overwrite")), false);
  assert.equal(await resolveSaveConflict("changed", dependencies("alternate")), false);
  assert.deepEqual(reported, [
    ["Save failed", "disk full"],
    ["Reload failed", "gone"],
  ]);
});

test("a clean buffer adopts an outside edit without asking", async () => {
  const { calls, entry } = trace();
  await handleExternalChange({
    isDirty: () => false,
    adopt: () => entry("adopt"),
    confirmReload: async () => {
      await entry("confirm");
      return false;
    },
    showError: () => entry("error").then(() => undefined),
  });

  assert.deepEqual(calls, ["adopt"]);
});

test("unsaved edits are only replaced when the reload is confirmed", async () => {
  const confirmed = trace();
  await handleExternalChange({
    isDirty: () => true,
    adopt: () => confirmed.entry("adopt"),
    confirmReload: () => confirmed.entry("confirm").then(() => true),
    showError: () => confirmed.entry("error").then(() => undefined),
  });
  assert.deepEqual(confirmed.calls, ["confirm", "adopt"]);

  const declined = trace();
  await handleExternalChange({
    isDirty: () => true,
    adopt: () => declined.entry("adopt"),
    confirmReload: () => declined.entry("confirm").then(() => false),
    showError: () => declined.entry("error").then(() => undefined),
  });
  assert.deepEqual(declined.calls, ["confirm"]);
});

test("a failed adoption is reported instead of thrown", async () => {
  const reported = [];
  await handleExternalChange({
    isDirty: () => false,
    adopt: async () => {
      throw new Error("unreadable");
    },
    confirmReload: () => Promise.resolve(true),
    showError: async (title, error) => {
      reported.push([title, error.message]);
    },
  });

  assert.deepEqual(reported, [["Reload failed", "unreadable"]]);
});
