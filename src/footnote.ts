import type { Node as ProsemirrorNode } from "@milkdown/kit/prose/model";

const LITERAL_FOOTNOTE_REF = /\[\^(\d+)\]/g;

/**
 * Returns the smallest free footnote number for the document.
 *
 * Identifiers live in two places: parsed `footnote_reference` and
 * `footnote_definition` nodes carry their label in node attributes (invisible
 * to text scanning), while footnotes inserted during the current session are
 * literal `[^n]` text. Both are reserved. Labels are matched verbatim, so a
 * named label like `[^note]` never blocks a numeric identifier.
 */
export function nextFootnoteIndex(doc: ProsemirrorNode): number {
  const used = new Set<string>();
  doc.descendants((node) => {
    if (
      node.type.name === "footnote_reference" ||
      node.type.name === "footnote_definition"
    ) {
      const label = node.attrs.label;
      if (typeof label === "string" && label) used.add(label);
    }
  });
  const docText = doc.textBetween(0, doc.content.size, "\n", "\n");
  for (const match of docText.matchAll(LITERAL_FOOTNOTE_REF)) {
    used.add(match[1]);
  }
  let n = 1;
  while (used.has(String(n))) n += 1;
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
