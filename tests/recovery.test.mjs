import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecoveryJournal } from "../src/recovery.ts";

/** Lets microtasks queued behind timer callbacks finish before asserting. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
};

/**
 * A fake backend store: records every attempted write, keeps only the last
 * successful one per id, so tests can reconcile actual journal state.
 */
const makeStore = () => {
  const store = new Map();
  const writes = [];
  const removed = [];
  const errors = [];
  let pendingFailures = 0;
  let pendingRemoveFailures = 0;
  let hangGate = null;
  const deps = {
    write: async (snapshot) => {
      writes.push({ ...snapshot });
      if (hangGate !== null) {
        const gate = hangGate;
        hangGate = null;
        await gate;
      }
      if (pendingFailures > 0) {
        pendingFailures -= 1;
        throw new Error("recovery write failed");
      }
      store.set(snapshot.id, { ...snapshot });
    },
    remove: async (id) => {
      removed.push(id);
      if (pendingRemoveFailures > 0) {
        pendingRemoveFailures -= 1;
        throw new Error("recovery remove failed");
      }
      store.delete(id);
    },
    showError: (error) => errors.push(error),
  };
  return {
    deps,
    store,
    writes,
    removed,
    errors,
    failNext(count = 1) {
      pendingFailures = count;
    },
    failNextRemove(count = 1) {
      pendingRemoveFailures = count;
    },
    /** Suspends the next write until the returned release is called. */
    hangNextWrite() {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      hangGate = gate;
      return release;
    },
  };
};

const snapshot = (id, content, path = null, name = "Note") => ({
  id,
  path,
  name,
  content,
});

test("scheduled writes debounce, capture immutable payloads, and dedupe", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes } = makeStore();
  const journal = createRecoveryJournal(deps);

  const payload = snapshot("d1", "first draft\n");
  journal.schedule(payload, true);
  payload.content = "mutated after scheduling\n";
  await settle();
  assert.equal(writes.length, 0, "nothing before the debounce window closes");

  timers.tick(500);
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(store.get("d1")?.content, "first draft\n");

  journal.schedule(snapshot("d1", "first draft\n"), true);
  timers.tick(2000);
  await settle();
  assert.equal(writes.length, 1, "identical snapshot is deduped");

  journal.schedule(snapshot("d1", "second draft\n"), true);
  timers.tick(500);
  await settle();
  assert.equal(writes.length, 2);
  assert.equal(store.get("d1")?.content, "second draft\n");
});

test("continuous input persists within the two second bound", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes } = makeStore();
  const journal = createRecoveryJournal(deps);

  journal.schedule(snapshot("d1", "edit 0\n"), true);
  for (let i = 1; i <= 9; i += 1) {
    timers.tick(200);
    journal.schedule(snapshot("d1", `edit ${i}\n`), true);
  }
  timers.tick(200); // deadline timer set at t=0 fires at t=2000
  await settle();
  assert.equal(writes.length, 1, "max-wait flushes once, not per keystroke");
  assert.equal(store.get("d1")?.content, "edit 9\n");

  timers.tick(1000);
  await settle();
  assert.equal(writes.length, 1, "no further writes without new input");
});

test("clean clear at save time drops pending edits, then reconciliation repersists", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes, removed } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";

  journal.schedule(snapshot(id, "pre-save\n"), true);
  timers.tick(500);
  await settle();
  assert.equal(store.get(id)?.content, "pre-save\n");

  // Save submits the persisted snapshot and journals it while writing.
  await journal.checkpoint(snapshot(id, "submitted\n"), true);
  assert.equal(store.get(id)?.content, "submitted\n");

  // The user keeps typing while the save is in flight.
  journal.schedule(snapshot(id, "edit during save\n"), true);
  // Save completes: a clean checkpoint clears the journal entry.
  await journal.checkpoint(snapshot(id, "submitted\n"), false);
  assert.deepEqual(removed, [id]);
  assert.equal(store.size, 0);

  timers.tick(2000);
  await settle();
  assert.equal(writes.length, 2, "the cancelled timer never fires stale edits");

  // Periodic reconciliation rediscovers the dirty editor and repersists.
  journal.schedule(snapshot(id, "edit during save\n"), true);
  timers.tick(500);
  await settle();
  assert.equal(writes.length, 3);
  assert.equal(store.get(id)?.content, "edit during save\n");
});

test("explicit discard drains an in-flight write, cancels queued ones, removes", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes, removed, hangNextWrite } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";

  journal.schedule(snapshot(id, "in-flight\n"), true);
  timers.tick(500);
  const release = hangNextWrite();
  await settle();
  assert.equal(writes.length, 1, "first write is in flight");

  journal.schedule(snapshot(id, "queued\n"), true);
  timers.tick(500);
  const discarding = journal.discard(id);
  await settle();
  assert.equal(writes.length, 1, "queued write was cancelled before running");

  release();
  await discarding;
  assert.deepEqual(removed, [id], "removal runs after the drained write");
  assert.equal(store.size, 0);

  journal.schedule(snapshot(id, "after discard\n"), true);
  timers.tick(2000);
  await settle();
  assert.equal(writes.length, 1, "retired ids schedule nothing");
});

test("discarding before the debounce window prevents any write", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";

  journal.schedule(snapshot(id, "never written\n"), true);
  await journal.discard(id);
  timers.tick(2000);
  await settle();
  assert.deepEqual(writes, []);
  assert.equal(store.size, 0);
});

test("failures report once per repeated failure until success, then reconcile", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes, errors, failNext } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";
  const payload = snapshot(id, "repeated content\n");

  failNext(2);
  journal.schedule(payload, true);
  timers.tick(500);
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(errors.length, 1, "first failure is reported");
  assert.equal(store.size, 0);

  journal.schedule(payload, true);
  timers.tick(500);
  await settle();
  assert.equal(writes.length, 2, "a failed write is retried");
  assert.equal(errors.length, 1, "the repeated failure is not reported again");

  journal.schedule(payload, true);
  timers.tick(500);
  await settle();
  assert.equal(writes.length, 3);
  assert.equal(errors.length, 1);
  assert.equal(store.get(id)?.content, "repeated content\n");

  journal.schedule(payload, true);
  timers.tick(500);
  await settle();
  assert.equal(writes.length, 3, "the now-persisted snapshot is deduped");

  failNext(1);
  journal.schedule(snapshot(id, "different content\n"), true);
  timers.tick(500);
  await settle();
  assert.equal(errors.length, 2, "a failure after success is reported again");
  assert.equal(store.get(id)?.content, "repeated content\n");
});

test("checkpoint errors propagate to the caller without poisoning the queue", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, errors, failNext } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";

  failNext(1);
  await assert.rejects(
    journal.checkpoint(snapshot(id, "checked\n"), true),
    /recovery write failed/,
  );
  assert.deepEqual(errors, [], "propagated errors are not also reported");
  assert.equal(store.size, 0);

  journal.schedule(snapshot(id, "checked\n"), true);
  timers.tick(500);
  await settle();
  assert.equal(store.get(id)?.content, "checked\n", "queue still works");
});

test("a queued duplicate write collapses once the first one persists", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes, hangNextWrite } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";

  journal.schedule(snapshot(id, "same\n"), true);
  timers.tick(500);
  const release = hangNextWrite();
  await settle();
  assert.equal(writes.length, 1);

  journal.schedule(snapshot(id, "same\n"), true);
  timers.tick(500);
  release();
  await settle();
  assert.equal(writes.length, 1, "duplicate resolved against persisted state");
  assert.equal(store.get(id)?.content, "same\n");

  journal.schedule(snapshot(id, "same\n", "/tmp/note.md"), true);
  timers.tick(500);
  await settle();
  assert.equal(writes.length, 2, "path changes defeat the dedupe");
  assert.equal(store.get(id)?.path, "/tmp/note.md");
});

test("clean checkpoints do not retire an id; discard does", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes, removed } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";

  await journal.checkpoint(snapshot(id, "clean\n"), false);
  await settle();
  assert.deepEqual(removed, [id], "an unknown id is cleared once");

  journal.schedule(snapshot(id, "dirty\n"), true);
  timers.tick(500);
  await settle();
  assert.equal(store.get(id)?.content, "dirty\n");

  await journal.checkpoint(snapshot(id, "clean\n"), false);
  assert.deepEqual(removed, [id, id]);
  assert.equal(store.size, 0);

  journal.schedule(snapshot(id, "reused\n"), true);
  timers.tick(500);
  await settle();
  assert.equal(writes.length, 2, "the cleared id stays usable");

  await journal.discard(id);
  journal.schedule(snapshot(id, "ignored\n"), true);
  timers.tick(2000);
  await settle();
  assert.equal(writes.length, 2, "discarded ids schedule nothing");
  assert.deepEqual(removed, [id, id, id]);
  assert.equal(store.size, 0);
});

test("discarding an orphan snapshot the controller never wrote removes it", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, removed, failNextRemove } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "orphan";

  // A previous process left a snapshot behind; this controller never wrote it.
  store.set(id, { id, path: null, name: "Note", content: "orphaned\n" });

  failNextRemove(1);
  await assert.rejects(journal.discard(id), /recovery remove failed/);
  assert.equal(store.get(id)?.content, "orphaned\n", "failed discard retries");

  await journal.discard(id);
  assert.deepEqual(removed, [id, id]);
  assert.equal(store.size, 0);

  // Retired or not, the cleared id is not removed again without new writes.
  await journal.discard(id);
  journal.schedule(snapshot(id, "ignored\n"), false);
  await settle();
  assert.deepEqual(removed, [id, id], "cleared ids dedupe removals");
});

test("a clean schedule clears a backend snapshot and dedupes afterwards", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, removed } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";

  store.set(id, { id, path: null, name: "Note", content: "leftover\n" });

  journal.schedule(snapshot(id, "leftover\n"), false);
  await settle();
  assert.equal(store.size, 0);

  journal.schedule(snapshot(id, "leftover\n"), false);
  await settle();
  assert.deepEqual(removed, [id], "clean ids are removed only once");
});
