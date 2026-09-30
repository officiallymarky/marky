export class DocumentState {
  private savedContent = "";
  private liveContent = "";

  get content(): string {
    return this.liveContent;
  }

  get dirty(): boolean {
    return this.liveContent !== this.savedContent;
  }

  load(content: string): void {
    this.savedContent = content;
    this.liveContent = content;
  }

  update(content: string): void {
    this.liveContent = content;
  }

  markSaved(content: string): void {
    this.savedContent = content;
  }
}
