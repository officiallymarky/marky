import assert from "node:assert/strict";
import { test } from "node:test";
import { DocumentState } from "../src/document-state.ts";
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function externalChangeFixture() {
  const state = new DocumentState();
  state.load("original");
  const disk = { path: "/a.md", name: "a.md", content: "disk version" };
  const current = { state };
  const fixture = {
    current,
    active: current,
    prompts: 0,
    errors: [],
    dependencies: {
      isCurrent: () => fixture.active === current,
      revision: () => state.revision,
      isDirty: () => state.dirty,
      load: async () => disk,
      replace: async (document) => { fixture.active.state.load(document.content); },
      confirmReload: async () => { fixture.prompts++; return true; },
      showError: async (title, error) => { fixture.errors.push([title, error.message]); },
    },
  };
  return fixture;
}

test("a clean buffer adopts an outside edit without asking", async () => {
  const fixture = externalChangeFixture();
  await handleExternalChange(fixture.dependencies);
  assert.equal(fixture.current.state.content, "disk version");
  assert.equal(fixture.current.state.dirty, false);
  assert.equal(fixture.prompts, 0);
});

test("unsaved edits are only replaced when the reload is confirmed", async () => {
  for (const confirmed of [true, false]) {
    const fixture = externalChangeFixture();
    fixture.current.state.update("unsaved");
    fixture.dependencies.confirmReload = async () => confirmed;
    await handleExternalChange(fixture.dependencies);
    assert.equal(fixture.current.state.content, confirmed ? "disk version" : "unsaved");
    assert.equal(fixture.current.state.dirty, !confirmed);
  }
});

test("edits made during a delayed read survive even if saved before it resolves", async () => {
  for (const saved of [false, true]) {
    const fixture = externalChangeFixture();
    const reading = deferred();
    fixture.dependencies.load = () => reading.promise;
    const pending = handleExternalChange(fixture.dependencies);
    fixture.current.state.update("typed while loading");
    if (saved) fixture.current.state.markSaved("typed while loading");
    reading.resolve({ content: "disk version" });
    await pending;
    assert.equal(fixture.current.state.content, "typed while loading");
    assert.equal(fixture.current.state.dirty, !saved);
  }
});

test("editing and undoing during a read still invalidates its revision", async () => {
  const fixture = externalChangeFixture();
  const reading = deferred();
  fixture.dependencies.load = () => reading.promise;
  const pending = handleExternalChange(fixture.dependencies);
  fixture.current.state.update("temporary edit");
  fixture.current.state.update("original");
  reading.resolve({ content: "disk version" });
  await pending;
  assert.equal(fixture.current.state.content, "original");
});

test("a delayed read cannot replace a newly opened document session", async () => {
  const fixture = externalChangeFixture();
  const reading = deferred();
  fixture.dependencies.load = () => reading.promise;
  const pending = handleExternalChange(fixture.dependencies);
  const other = new DocumentState();
  other.load("new document");
  fixture.active = { state: other };
  reading.resolve({ content: "disk version" });
  await pending;
  assert.equal(other.content, "new document");
  assert.equal(fixture.current.state.content, "original");
});

test("confirmation does not authorize edits or document switches made during the prompt", async () => {
  for (const switchDocument of [false, true]) {
    const fixture = externalChangeFixture();
    fixture.current.state.update("unsaved");
    const confirmation = deferred();
    fixture.dependencies.confirmReload = () => confirmation.promise;
    const pending = handleExternalChange(fixture.dependencies);
    if (switchDocument) {
      const other = new DocumentState();
      other.load("new document");
      fixture.active = { state: other };
    } else {
      fixture.current.state.update("newer edit");
    }
    confirmation.resolve(true);
    await pending;
    assert.equal(fixture.active.state.content, switchDocument ? "new document" : "newer edit");
  }
});

test("an unchanged content notification does not cancel a clean reload", async () => {
  const fixture = externalChangeFixture();
  const reading = deferred();
  fixture.dependencies.load = () => reading.promise;
  const pending = handleExternalChange(fixture.dependencies);
  fixture.current.state.update("original");
  reading.resolve({ content: "disk version" });
  await pending;
  assert.equal(fixture.current.state.content, "disk version");
});

test("a failed read is reported without replacing the buffer", async () => {
  const fixture = externalChangeFixture();
  fixture.dependencies.load = async () => { throw new Error("unreadable"); };
  await handleExternalChange(fixture.dependencies);
  assert.equal(fixture.current.state.content, "original");
  assert.deepEqual(fixture.errors, [["Reload failed", "unreadable"]]);
});
