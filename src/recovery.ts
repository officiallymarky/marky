export interface RecoveryWrite {
  id: string;
  path: string | null;
  name: string;
  content: string;
}

/** A stored recovery snapshot; `updatedAt` is assigned by the backend. */
export interface RecoverySnapshot extends RecoveryWrite {
  updatedAt: number;
}

export interface RecoveryJournalDependencies {
  write(snapshot: RecoveryWrite): Promise<void>;
  remove(id: string): Promise<void>;
  showError(error: unknown): void;
}

export interface RecoveryJournal {
  /**
   * Records what the editor shows. Dirty content is debounced (500ms quiet,
   * at most 2s of continuous input); a clean document clears the journal.
   */
  schedule(snapshot: RecoveryWrite, dirty: boolean): void;
  /** Immediately persists or clears a snapshot; errors propagate. */
  checkpoint(snapshot: RecoveryWrite, dirty: boolean): Promise<void>;
  /** Retires an id synchronously, drains outstanding writes, then removes. */
  discard(id: string): Promise<void>;
}

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 2000;

type TimerHandle = number;

interface ScheduledWrite {
  payload: RecoveryWrite | null;
  debounce: TimerHandle | undefined;
  deadline: TimerHandle | undefined;
}

interface Cancellable {
  cancelled: boolean;
}

/**
 * Keeps per-document recovery snapshots in step with the editor. Writes are
 * serialized so a later clean transition, save checkpoint, or discard always
 * wins over a write captured earlier, and a failing operation never blocks
 * the work queued behind it.
 */
export function createRecoveryJournal(
  dependencies: RecoveryJournalDependencies,
): RecoveryJournal {
  let queue: Promise<unknown> = Promise.resolve();
  const retired = new Set<string>();
  const persisted = new Map<string, RecoveryWrite>();
  // Ids whose snapshot is confirmed absent in the backend, so clean
  // transitions do not repeat removals for them.
  const cleared = new Set<string>();
  const reportedFailures = new Set<string>();
  const scheduled = new Map<string, ScheduledWrite>();
  const cancellable = new Map<string, Set<Cancellable>>();

  const sameSnapshot = (
    stored: RecoveryWrite | undefined,
    snapshot: RecoveryWrite,
  ): boolean =>
    stored !== undefined &&
    stored.content === snapshot.content &&
    stored.path === snapshot.path &&
    stored.name === snapshot.name;

  const reportFailure = (id: string, error: unknown): void => {
    if (reportedFailures.has(id)) return;
    reportedFailures.add(id);
    dependencies.showError(error);
  };

  /** Queued-but-unstarted operations for an id lose to a later transition. */
  const cancelQueued = (id: string): void => {
    const ops = cancellable.get(id);
    if (!ops) return;
    for (const op of ops) op.cancelled = true;
  };

  const enqueue = (id: string, run: () => Promise<void>): Promise<void> => {
    const op: Cancellable = { cancelled: false };
    let ops = cancellable.get(id);
    if (!ops) {
      ops = new Set();
      cancellable.set(id, ops);
    }
    ops.add(op);
    const result = queue.then(async (): Promise<void> => {
      ops.delete(op);
      if (ops.size === 0 && cancellable.get(id) === ops) {
        cancellable.delete(id);
      }
      if (op.cancelled) return;
      await run();
    });
    // A failing operation must not poison the work queued behind it.
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /** Dedupe compares against the last snapshot persistence confirmed. */
  const runWrite = (snapshot: RecoveryWrite, report: boolean) => async () => {
    const id = snapshot.id;
    if (retired.has(id)) return;
    if (sameSnapshot(persisted.get(id), snapshot)) return;
    try {
      await dependencies.write(snapshot);
      persisted.set(id, { ...snapshot });
      cleared.delete(id);
      reportedFailures.delete(id);
    } catch (error) {
      if (report) reportFailure(id, error);
      else throw error;
    }
  };

  /**
   * Removes the id's snapshot even when this controller never wrote it, so
   * startup can discard an orphan left by a previous process.
   */
  const runRemove = (id: string, report: boolean) => async () => {
    if (cleared.has(id)) return;
    try {
      await dependencies.remove(id);
      cleared.add(id);
      persisted.delete(id);
      reportedFailures.delete(id);
    } catch (error) {
      if (report) reportFailure(id, error);
      else throw error;
    }
  };

  const stopScheduled = (id: string): void => {
    const entry = scheduled.get(id);
    if (!entry) return;
    clearTimeout(entry.debounce);
    clearTimeout(entry.deadline);
    scheduled.delete(id);
  };

  const flush = (id: string): void => {
    const entry = scheduled.get(id);
    if (!entry) return;
    stopScheduled(id);
    if (entry.payload === null) return;
    enqueue(id, runWrite(entry.payload, true));
  };

  const clearJournal = (id: string): void => {
    stopScheduled(id);
    cancelQueued(id);
    enqueue(id, runRemove(id, true));
  };

  const schedule = (snapshot: RecoveryWrite, dirty: boolean): void => {
    const id = snapshot.id;
    // Retired ids schedule nothing and must not disturb pending cleanups.
    if (retired.has(id)) return;
    if (!dirty) {
      clearJournal(id);
      return;
    }
    let entry = scheduled.get(id);
    if (!entry) {
      entry = { payload: null, debounce: undefined, deadline: undefined };
      scheduled.set(id, entry);
      // Continuous typing must still persist within a bounded window.
      entry.deadline = setTimeout(() => flush(id), MAX_WAIT_MS);
    }
    // Capture the requested payload now; later edits must not leak into it.
    entry.payload = { ...snapshot };
    clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => flush(id), DEBOUNCE_MS);
  };

  const checkpoint = (snapshot: RecoveryWrite, dirty: boolean): Promise<void> => {
    const id = snapshot.id;
    if (retired.has(id)) return Promise.resolve();
    stopScheduled(id);
    if (!dirty) {
      cancelQueued(id);
      return enqueue(id, runRemove(id, false));
    }
    return enqueue(id, runWrite({ ...snapshot }, false));
  };

  /** Retires the id; a failed discard may be retried with the same id. */
  const discard = (id: string): Promise<void> => {
    retired.add(id);
    stopScheduled(id);
    cancelQueued(id);
    return enqueue(id, runRemove(id, false));
  };

  return { schedule, checkpoint, discard };

}
