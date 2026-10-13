import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recoveryPromptText,
  runRecoveryPrompt,
} from "../src/recovery-prompt.ts";

const summary = (id, { name = "Note", path = null, updatedAt = 0 } = {}) => ({
  id,
  name,
  path,
  updatedAt,
});

/** Records every call; the scripted answers are consumed in order. */
const makeDeps = (
  snapshots,
  {
    choose: chooseAnswers = [],
    confirm: confirmAnswers = [],
    listErrors = [],
    listThrows = false,
    failRead = false,
    failDiscard = false,
  } = {},
) => {
  const calls = {
    choose: [],
    confirm: [],
    read: [],
    discard: [],
    release: [],
    errors: [],
  };
  const choices = [...chooseAnswers];
  const confirmations = [...confirmAnswers];
  return {
    calls,
    deps: {
      list: async () => {
        if (listThrows) throw new Error("the journal is unreadable");
        return { snapshots, errors: listErrors };
      },
      read: async (id) => {
        calls.read.push(id);
        if (failRead) throw new Error(`cannot read ${id}`);
        return { ...summary(id), content: `text of ${id}` };
      },
      discard: async (id) => {
        calls.discard.push(id);
        if (failDiscard) throw new Error(`cannot discard ${id}`);
      },
      release: async (id) => {
        calls.release.push(id);
      },
      choose: async (message) => {
        calls.choose.push(message);
        return choices.shift() ?? "Later";
      },
      confirm: async (message) => {
        calls.confirm.push(message);
        return confirmations.shift() ?? false;
      },
      showError: async (title, error) => {
        calls.errors.push([title, String(error)]);
      },
    },
  };
};

test("later stops asking and leaves every backup on disk", async () => {
  const { deps, calls } = makeDeps([summary("a"), summary("b"), summary("c")], {
    choose: ["Later"],
  });

  const restored = await runRecoveryPrompt(deps);

  assert.equal(restored, undefined);
  assert.equal(calls.choose.length, 1, "one decision is enough per launch");
  assert.deepEqual(calls.discard, [], "nothing is deleted");
  assert.deepEqual(calls.read, []);
  // The backups stay, but this instance no longer claims them.
  assert.deepEqual(calls.release, ["a", "b", "c"]);
});

test("the prompt counts the backups that are waiting", () => {
  assert.match(
    recoveryPromptText(summary("a", { path: "/tmp/note.md" }), 2),
    /2 other backups kept\./,
  );
  assert.match(recoveryPromptText(summary("a"), 1), /1 other backup kept\./);
  assert.doesNotMatch(recoveryPromptText(summary("a"), 0), /other backup/);
  assert.match(recoveryPromptText(summary("a", { path: "/tmp/note.md" }), 0), /Original: \/tmp\/note\.md/);
});

test("discarding one asks about the rest and keeps them when told to", async () => {
  const { deps, calls } = makeDeps([summary("a"), summary("b"), summary("c")], {
    choose: ["Discard", "Later"],
    confirm: [false],
  });

  const restored = await runRecoveryPrompt(deps);

  assert.equal(restored, undefined);
  assert.deepEqual(calls.discard, ["a"]);
  assert.equal(calls.confirm.length, 1);
  assert.match(calls.confirm[0], /Discard the other 2 backups too\?/);
  assert.equal(calls.choose.length, 2, "the next backup is still offered");
  assert.deepEqual(calls.release, ["a", "b", "c"]);
});

test("answering the follow-up clears the remaining backups in one go", async () => {
  const { deps, calls } = makeDeps([summary("a"), summary("b"), summary("c")], {
    choose: ["Discard"],
    confirm: [true],
  });

  const restored = await runRecoveryPrompt(deps);

  assert.equal(restored, undefined);
  assert.deepEqual(calls.discard, ["a", "b", "c"]);
  assert.equal(calls.choose.length, 1, "no further prompt after clearing them");
  assert.deepEqual(calls.release, ["a", "b", "c"]);
});

test("discarding the last backup asks nothing further", async () => {
  const { deps, calls } = makeDeps([summary("a")], { choose: ["Discard"] });

  await runRecoveryPrompt(deps);

  assert.deepEqual(calls.discard, ["a"]);
  assert.deepEqual(calls.confirm, []);
});

test("restoring fetches the text, stops asking, and keeps its claim", async () => {
  const { deps, calls } = makeDeps([summary("a"), summary("b"), summary("c")], {
    choose: ["Restore"],
  });

  const restored = await runRecoveryPrompt(deps);

  assert.equal(restored?.id, "a");
  assert.equal(restored?.content, "text of a");
  assert.deepEqual(calls.read, ["a"]);
  assert.equal(calls.choose.length, 1);
  // The restored snapshot stays claimed; the others are released untouched.
  assert.deepEqual(calls.release, ["b", "c"]);
});

test("a failed read is reported and the next backup is offered", async () => {
  const { deps, calls } = makeDeps([summary("a"), summary("b")], {
    choose: ["Restore", "Restore"],
    failRead: true,
  });

  const restored = await runRecoveryPrompt(deps);

  assert.equal(restored, undefined, "a failed read restores nothing");
  assert.deepEqual(calls.read, ["a", "b"], "the next backup is still offered");
  assert.deepEqual(calls.errors, [
    ["Could not read the recovery backup", "Error: cannot read a"],
    ["Could not read the recovery backup", "Error: cannot read b"],
  ]);
  assert.deepEqual(calls.release, ["a", "b"]);
});

test("an unreadable snapshot is reported without prompting", async () => {
  const { deps, calls } = makeDeps([], { listErrors: ["a is not a regular file"] });

  await runRecoveryPrompt(deps);

  assert.deepEqual(calls.errors, [
    ["Could not read a recovery backup", "a is not a regular file"],
  ]);
  assert.deepEqual(calls.choose, []);
});

test("a failed listing is reported once", async () => {
  const { deps, calls } = makeDeps([], { listThrows: true });

  const restored = await runRecoveryPrompt(deps);

  assert.equal(restored, undefined);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0][0], "Recovery failed");
  assert.deepEqual(calls.release, []);
});

test("a failed discard is reported and nothing stays claimed", async () => {
  const { deps, calls } = makeDeps([summary("a"), summary("b")], {
    choose: ["Discard"],
    failDiscard: true,
  });

  await runRecoveryPrompt(deps);

  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0][0], "Recovery failed");
  assert.deepEqual(calls.release, ["a", "b"]);
  assert.equal(calls.choose.length, 1, "the failed discard stops the walk");
});
