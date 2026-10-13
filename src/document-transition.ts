/**
 * Serializes document transitions (open, new, reload, recovery restore).
 *
 * Rebuilding the editor is asynchronous and touches shared state: the document
 * session, the editor handle, the history and the recovery backup. Two
 * transitions that overlap — a focus-driven reload and an Open, say — would
 * otherwise mount two editors and leave the session and the handle describing
 * different documents.
 *
 * Transitions run one at a time, in request order, and the newest request wins:
 * a transition that a later one has already superseded never starts, so the
 * editor always ends up showing the last document the user asked for.
 */
export interface DocumentTransitions {
  /**
   * Runs `rebuild`, unless a later transition was requested first. Resolves
   * true when it ran, false when it was superseded: a caller that reports
   * success to the user must not claim a rebuild that never happened.
   */
  run(rebuild: () => Promise<void>): Promise<boolean>;
}

export function createDocumentTransitions(): DocumentTransitions {
  let queue: Promise<void> = Promise.resolve();
  let epoch = 0;
  return {
    run(rebuild) {
      const token = (epoch += 1);
      const result = queue.then(async () => {
        if (token !== epoch) return false;
        await rebuild();
        return true;
      });
      // A failed rebuild must not poison the transitions queued behind it.
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
