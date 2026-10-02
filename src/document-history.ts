/** A bounded document timeline shared by rich text, source and front matter. */
export class DocumentHistory<T> {
  private past: { before: T; after: T }[] = [];
  private future: { before: T; after: T }[] = [];
  private canJoin = false;

  private readonly limit: number;

  constructor(limit = 100) {
    this.limit = limit;
  }

  /** Join only consecutive edits in the same surface's existing edit group. */
  record(before: T, after: T, join = false): void {
    const previous = this.past.at(-1);
    if (join && this.canJoin && previous) {
      previous.after = after;
    } else {
      this.past.push({ before, after });
      if (this.past.length > this.limit) this.past.shift();
    }
    this.future = [];
    this.canJoin = true;
  }

  /** Mode switches, focus changes and undo/redo end the current typing group. */
  boundary(): void {
    this.canJoin = false;
  }

  undo(): T | null {
    this.boundary();
    const edit = this.past.pop();
    if (!edit) return null;
    this.future.push(edit);
    return edit.before;
  }

  redo(): T | null {
    this.boundary();
    const edit = this.future.pop();
    if (!edit) return null;
    this.past.push(edit);
    return edit.after;
  }

  /** Opening, reloading or restoring another document starts a new timeline. */
  clear(): void {
    this.past = [];
    this.future = [];
    this.boundary();
  }
}
