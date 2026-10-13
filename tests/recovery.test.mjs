import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecoveryJournal } from "../src/recovery.ts";

/**
 * Waits for the journal's asynchronous work to satisfy `condition`, re-checking
 * after each turn instead of spinning a fixed number of turns and hoping. One
 * turn is yielded first so work the mocked debounce timer queued can start; the
 * generous deadline makes a condition that never holds fail loudly rather than
 * hang or pass by accident.
 */
const waitFor = async (condition, message, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((resolve) => setImmediate(resolve));
    if (condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${message}`);
    }
  }
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
  await waitFor(
    () => writes.length === 0,
    "nothing before the debounce window closes",
  );

  timers.tick(500);
  await waitFor(() => writes.length === 1, "the debounce flush to persist");
  assert.equal(store.get("d1")?.content, "first draft\n");

  journal.schedule(snapshot("d1", "first draft\n"), true);
  timers.tick(2000);
  await waitFor(() => writes.length === 1, "the identical snapshot to be deduped");

  journal.schedule(snapshot("d1", "second draft\n"), true);
  timers.tick(500);
  await waitFor(() => writes.length === 2, "the second draft to persist");
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
  await waitFor(() => writes.length === 1, "the max-wait flush to persist once");
  assert.equal(store.get("d1")?.content, "edit 9\n");

  timers.tick(1000);
  await waitFor(() => writes.length === 1, "no further writes without new input");
});

test("clean clear at save time drops pending edits, then reconciliation repersists", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes, removed } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";

  journal.schedule(snapshot(id, "pre-save\n"), true);
  timers.tick(500);
  await waitFor(
    () => store.get(id)?.content === "pre-save\n",
    "the first flush to persist",
  );

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
  await waitFor(() => writes.length === 2, "the cancelled timer never to fire");

  // Periodic reconciliation rediscovers the dirty editor and repersists.
  journal.schedule(snapshot(id, "edit during save\n"), true);
  timers.tick(500);
  await waitFor(() => writes.length === 3, "the rediscovered edit to repersist");
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
  await waitFor(() => writes.length === 1, "the first write to start and stall");

  journal.schedule(snapshot(id, "queued\n"), true);
  timers.tick(500);
  const discarding = journal.discard(id);
  await waitFor(() => writes.length === 1, "the queued write to be cancelled");

  release();
  await discarding;
  assert.deepEqual(removed, [id], "removal runs after the drained write");
  assert.equal(store.size, 0);

  journal.schedule(snapshot(id, "after discard\n"), true);
  timers.tick(2000);
  await waitFor(() => writes.length === 1, "a retired id to schedule nothing");
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
  await waitFor(() => writes.length === 0, "the discarded snapshot to write nothing");
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
  await waitFor(
    () => writes.length === 1 && errors.length === 1,
    "the first failure to be reported once",
  );
  assert.equal(store.size, 0);

  journal.schedule(payload, true);
  timers.tick(500);
  await waitFor(
    () => writes.length === 2 && errors.length === 1,
    "the failed write to be retried without a second report",
  );

  journal.schedule(payload, true);
  timers.tick(500);
  await waitFor(
    () => writes.length === 3 && errors.length === 1,
    "the retry to persist the snapshot",
  );
  assert.equal(store.get(id)?.content, "repeated content\n");

  journal.schedule(payload, true);
  timers.tick(500);
  await waitFor(() => writes.length === 3, "the now-persisted snapshot to dedupe");

  failNext(1);
  journal.schedule(snapshot(id, "different content\n"), true);
  timers.tick(500);
  await waitFor(
    () => errors.length === 2,
    "a failure after success to be reported again",
  );
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
  await waitFor(() => store.get(id)?.content === "checked\n", "the queue to keep working");
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
  await waitFor(() => writes.length === 1, "the first write to start and stall");

  journal.schedule(snapshot(id, "same\n"), true);
  timers.tick(500);
  release();
  await waitFor(
    () => store.get(id)?.content === "same\n" && writes.length === 1,
    "the drained write to persist and the duplicate to dedupe",
  );

  journal.schedule(snapshot(id, "same\n", "/tmp/note.md"), true);
  timers.tick(500);
  await waitFor(() => writes.length === 2, "the path change to defeat the dedupe");
  assert.equal(store.get(id)?.path, "/tmp/note.md");
});

test("clean checkpoints do not retire an id; discard does", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes, removed } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";

  await journal.checkpoint(snapshot(id, "clean\n"), false);
  await waitFor(() => removed.length === 1, "an unknown id to be cleared once");

  journal.schedule(snapshot(id, "dirty\n"), true);
  timers.tick(500);
  await waitFor(() => store.get(id)?.content === "dirty\n", "the dirty snapshot to persist");

  await journal.checkpoint(snapshot(id, "clean\n"), false);
  assert.deepEqual(removed, [id, id]);
  assert.equal(store.size, 0);

  journal.schedule(snapshot(id, "reused\n"), true);
  timers.tick(500);
  await waitFor(() => writes.length === 2, "the cleared id to stay usable");

  await journal.discard(id);
  journal.schedule(snapshot(id, "ignored\n"), true);
  timers.tick(2000);
  await waitFor(() => writes.length === 2, "a discarded id to schedule nothing");
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
  await waitFor(() => removed.length === 2, "cleared ids to dedupe removals");
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
  await waitFor(() => store.size === 0, "the clean schedule to clear the snapshot");

  journal.schedule(snapshot(id, "leftover\n"), false);
  await waitFor(() => removed.length === 1, "clean ids to be removed only once");
});

test("a discarded id can be put back under protection after a failed teardown", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, writes, removed, errors } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";

  await journal.checkpoint(snapshot(id, "draft\n"), true);
  await journal.discard(id);
  assert.equal(store.size, 0);

  journal.schedule(snapshot(id, "typed while retired\n"), true);
  timers.tick(2000);
  await waitFor(() => writes.length === 1, "a retired id to schedule nothing");

  // The close failed and the window is still open: protect the document again.
  await journal.resume(snapshot(id, "typed after the failed close\n"), true);
  assert.equal(store.get(id)?.content, "typed after the failed close\n");

  journal.schedule(snapshot(id, "more typing\n"), true);
  timers.tick(500);
  await waitFor(
    () => store.get(id)?.content === "more typing\n",
    "the re-armed id to persist",
  );
  assert.deepEqual(removed, [id], "the snapshot is not removed twice");
  assert.deepEqual(errors, []);
});

test("resuming after a failed discard retries the removal or rewrites", async (t) => {
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  const { deps, store, removed, errors, failNextRemove } = makeStore();
  const journal = createRecoveryJournal(deps);
  const id = "d1";
  await journal.checkpoint(snapshot(id, "draft\n"), true);

  failNextRemove();
  await assert.rejects(journal.discard(id), /recovery remove failed/);
  assert.equal(store.get(id)?.content, "draft\n", "the snapshot survived");

  await journal.resume(snapshot(id, "still writing\n"), true);
  assert.equal(store.get(id)?.content, "still writing\n");
  assert.deepEqual(removed, [id], "only the failed removal was attempted");
  assert.deepEqual(errors, []);

  // A clean resume clears the snapshot instead of rewriting it.
  await journal.discard(id);
  assert.equal(store.size, 0);
  await journal.resume(snapshot(id, "clean\n"), false);
  assert.deepEqual(removed, [id, id], "a clean resume removes, never writes");
  assert.equal(store.size, 0);
});
