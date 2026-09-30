export class DocumentState {
  private savedContent = "";
  private liveContent = "";
  private contentRevision = 0;
  private recovered = false;

  get content(): string {
    return this.liveContent;
  }

  get revision(): number {
    return this.contentRevision;
  }

  get dirty(): boolean {
    return this.liveContent !== this.savedContent || this.recovered;
  }

  load(content: string): void {
    if (content !== this.liveContent) this.contentRevision++;
    this.savedContent = content;
    this.liveContent = content;
    this.recovered = false;
  }

  update(content: string): void {
    if (content !== this.liveContent) this.contentRevision++;
    this.liveContent = content;
  }

  /** Loads recovered content as an unsaved buffer: dirty even when empty. */
  restore(content: string): void {
    if (content !== this.liveContent) this.contentRevision++;
    this.liveContent = content;
    this.recovered = true;
  }

  markSaved(content: string): void {
    this.savedContent = content;
    this.recovered = false;
  }
}
