/**
 * Un-escaping of the marker escapes the Markdown serializer adds to prose.
 *
 * remark escapes `[` at the start of a line, which would stop GitHub and
 * Obsidian from recognizing alert markers and footnote refs. Undoing that with
 * a plain string replace would also rewrite the same characters inside code,
 * so the replacements run over a copy of the document whose code regions are
 * held aside. Serialized output only ever contains code as fenced blocks
 * (`mdast-util-to-markdown` indents code only when `fences` is false, which
 * marky never sets) or as inline code spans, so those two forms cover every
 * character the serializer emitted verbatim.
 */
import { restoreAlertMarkers } from "./alerts.ts";
import { restoreFootnoteRefs } from "./footnote.ts";

/** A run of backticks or tildes, as it opens or closes a fence. */
interface Fence {
  marker: string;
  length: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** The fence opened at `index` (the start of a line), if any. */
function openFence(markdown: string, index: number): Fence | null {
  const lineEnd = markdown.indexOf("\n", index);
  const line = markdown.slice(index, lineEnd < 0 ? markdown.length : lineEnd);
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const run = match[1]!;
  // A backtick fence's info string cannot contain a backtick.
  if (run[0] === "`" && line.slice(match[0].length).includes("`")) return null;
  return { marker: run[0]!, length: run.length };
}

/** Index just past the line closing `fence`, or the end of the document. */
function fenceEnd(markdown: string, start: number, fence: Fence): number {
  const closing = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`);
  let index = markdown.indexOf("\n", start);
  while (index >= 0 && index < markdown.length) {
    index += 1;
    const lineEnd = markdown.indexOf("\n", index);
    const end = lineEnd < 0 ? markdown.length : lineEnd;
    if (closing.test(markdown.slice(index, end))) return end;
    if (lineEnd < 0) break;
    index = lineEnd;
  }
  // An unclosed fence runs to the end of the document.
  return markdown.length;
}

/** Start of the next backtick run of exactly `length`, or -1. */
function closingRun(markdown: string, from: number, length: number): number {
  let index = from;
  while (index < markdown.length) {
    if (markdown[index] !== "`") {
      index += 1;
      continue;
    }
    let run = 0;
    while (markdown[index + run] === "`") run += 1;
    if (run === length) return index;
    index += run;
  }
  return -1;
}

/** Every `[start, end)` region of `markdown` that holds code. */
function codeRegions(markdown: string): { start: number; end: number }[] {
  const regions: { start: number; end: number }[] = [];
  let index = 0;
  let lineStart = true;
  while (index < markdown.length) {
    if (lineStart) {
      const fence = openFence(markdown, index);
      if (fence) {
        const end = fenceEnd(markdown, index, fence);
        regions.push({ start: index, end });
        index = end;
        lineStart = true;
        continue;
      }
    }
    if (markdown[index] === "`") {
      let run = 0;
      while (markdown[index + run] === "`") run += 1;
      const close = closingRun(markdown, index + run, run);
      if (close >= 0) {
        regions.push({ start: index, end: close + run });
        index = close + run;
        lineStart = false;
        continue;
      }
      index += run;
      lineStart = false;
      continue;
    }
    lineStart = markdown[index] === "\n";
    index += 1;
  }
  return regions;
}

/** Stands in for a code region; no Markdown source contains a NUL. */
const PLACEHOLDER = "\u0000";

/**
 * Restores the alert markers and footnote refs the serializer escaped, leaving
 * code fences and inline code byte-exact.
 */
export function restoreMarkdownMarkers(markdown: string): string {
  const regions = codeRegions(markdown);
  if (!regions.length) return restoreFootnoteRefs(restoreAlertMarkers(markdown));
  const code = regions.map(({ start, end }) => markdown.slice(start, end));
  let masked = "";
  let cursor = 0;
  for (const { start, end } of regions) {
    masked += markdown.slice(cursor, start) + PLACEHOLDER;
    cursor = end;
  }
  masked += markdown.slice(cursor);
  // Neither replacement matches the placeholder, so the regions come back in
  // the order they were removed.
  const restored = restoreFootnoteRefs(restoreAlertMarkers(masked));
  let out = "";
  cursor = 0;
  for (const region of code) {
    const at = restored.indexOf(PLACEHOLDER, cursor);
    if (at < 0) break;
    out += restored.slice(cursor, at) + region;
    cursor = at + PLACEHOLDER.length;
  }
  return out + restored.slice(cursor);
}
