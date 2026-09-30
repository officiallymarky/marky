/**
 * Returns the next unused footnote number for the given document text.
 * Footnotes are plain markdown text: `[^1]` refs and `[^1]: text` definitions,
 * so existing refs are found by scanning for the literal `[^n]` pattern.
 */
export function nextFootnoteIndex(docText: string): number {
  let n = 1;
  while (docText.includes(`[^${n}]`)) n += 1;
  return n;
}

/**
 * The markdown serializer escapes the brackets of `[^n]` footnote refs and
 * definitions, which would stop GitHub and Obsidian from recognizing them.
 * Undo that for the footnote pattern only; the escaped form parses back to
 * the same text, and an empty definition's `<br />` filler is dropped, so
 * this stays round-trip stable.
 */
export function restoreFootnoteRefs(markdown: string): string {
  const unescaped = markdown.replace(/\\\[(\^\d+)\\?\]/g, "[$1]");
  // An empty parsed definition round-trips as `[^1]: <br />`; keep it empty.
  return unescaped.replace(/^(\[\^\d+\]: ?)<br\s*\/>$/gm, "$1");
}
