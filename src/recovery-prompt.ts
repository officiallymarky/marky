/**
 * The startup prompt for unsaved writing a crashed instance left behind.
 *
 * A backup is often the only copy of that writing, so nothing here deletes
 * one except a click: "Later" stops asking and leaves every backup on disk,
 * and clearing the rest is a second, explicit question.
 */
import type { RecoverySnapshot, RecoverySummary } from "./recovery";

/** The three-way choice; resolves the button label the shell reported. */
export interface RecoveryChoiceOptions {
  title: string;
  kind: "warning";
  buttons: { yes: string; no: string; cancel: string };
}

/** Yes/no for clearing the remaining backups. */
export interface RecoveryConfirmOptions {
  title: string;
  kind: "warning";
  okLabel: string;
  cancelLabel: string;
}

export interface RecoveryPromptDependencies {
  /** Orphan snapshots (metadata only) plus one message per unreadable one. */
  list(): Promise<{ snapshots: RecoverySummary[]; errors: string[] }>;
  /** Fetches one snapshot's text; the listing never ships it. */
  read(id: string): Promise<RecoverySnapshot>;
  /** Deletes one snapshot. */
  discard(id: string): Promise<void>;
  /** Drops this instance's claim on a snapshot without deleting it. */
  release(id: string): Promise<void>;
  choose(message: string, options: RecoveryChoiceOptions): Promise<string>;
  confirm(message: string, options: RecoveryConfirmOptions): Promise<boolean>;
  showError(title: string, error: unknown): Promise<void>;
}

/** One prompt's text: what was recovered, and how much else is waiting. */
export function recoveryPromptText(
  snapshot: RecoverySummary,
  waiting: number,
): string {
  const original = snapshot.path ? `\nOriginal: ${snapshot.path}` : "";
  const others =
    waiting > 0
      ? `\n${waiting} other backup${waiting === 1 ? "" : "s"} kept.`
      : "";
  const recovered = new Date(snapshot.updatedAt).toLocaleString();
  return `Unsaved writing for "${snapshot.name}" was recovered from ${recovered}.${original}${others}\n\nRestore opens an unsaved source copy; the original file is not changed.`;
}

/**
 * Asks about each orphan snapshot until one is restored or the user says
 * later, and returns the snapshot to open (undefined when none is).
 */
export async function runRecoveryPrompt(
  dependencies: RecoveryPromptDependencies,
): Promise<RecoverySnapshot | undefined> {
  let restored: RecoverySnapshot | undefined;
  let snapshots: RecoverySummary[] = [];
  try {
    const available = await dependencies.list();
    snapshots = available.snapshots;
    for (const error of available.errors) {
      await dependencies.showError("Could not read a recovery backup", error);
    }

    for (const [index, snapshot] of snapshots.entries()) {
      if (restored) break;
      const waiting = snapshots.length - index - 1;
      const choice = await dependencies.choose(
        recoveryPromptText(snapshot, waiting),
        {
          title: "Recover unsaved writing",
          kind: "warning",
          buttons: { yes: "Restore", no: "Discard", cancel: "Later" },
        },
      );

      if (choice === "Restore") {
        try {
          // The listing carries metadata only: fetch the text now, and never
          // restore nothing when the read fails.
          restored = await dependencies.read(snapshot.id);
        } catch (error) {
          await dependencies.showError("Could not read the recovery backup", error);
        }
        continue;
      }

      // "Later" means later: stop asking, and keep every backup on disk.
      if (choice !== "Discard") break;
      await dependencies.discard(snapshot.id);
      if (waiting === 0) continue;

      const clearRest = await dependencies.confirm(
        `Discard the other ${waiting} backups too?`,
        {
          title: "Recover unsaved writing",
          kind: "warning",
          okLabel: "Discard all",
          cancelLabel: "Keep them",
        },
      );
      if (!clearRest) continue;
      for (const other of snapshots.slice(index + 1)) {
        await dependencies.discard(other.id);
      }
      break;
    }
  } catch (error) {
    await dependencies.showError("Recovery failed", error);
  } finally {
    // A deferred, discarded or failed snapshot must not stay claimed by us.
    // Releasing an id whose file is gone is a no-op.
    for (const snapshot of snapshots) {
      if (snapshot.id === restored?.id) continue;
      await dependencies
        .release(snapshot.id)
        .catch((error: unknown) =>
          dependencies.showError("Could not release a recovery backup", error),
        );
    }
  }
  return restored;
}
