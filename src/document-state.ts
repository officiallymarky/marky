export class DocumentState {
  private savedContent = "";
  private liveContent = "";
  private contentRevision = 0;

  get content(): string {
    return this.liveContent;
  }

  get revision(): number {
    return this.contentRevision;
  }

  get dirty(): boolean {
    return this.liveContent !== this.savedContent;
  }

  load(content: string): void {
    if (content !== this.liveContent) this.contentRevision++;
    this.savedContent = content;
    this.liveContent = content;
  }

  update(content: string): void {
    if (content !== this.liveContent) this.contentRevision++;
    this.liveContent = content;
  }

  markSaved(content: string): void {
    this.savedContent = content;
  }
}
