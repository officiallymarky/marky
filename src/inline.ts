import { linkSchema } from "@milkdown/kit/preset/commonmark";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { $inputRule } from "@milkdown/kit/utils";
import type { MarkType } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";

/**
 * Trigger pattern for the live link rule: any `[label](` prefix followed by at
 * least one character, ending at the caret. It is intentionally loose —
 * balanced parentheses and backslash escapes cannot be expressed by a bounded
 * regex — so `parseLinkDestination` decides whether the pattern is complete.
 */
const linkPattern = /\[(?<text>[^\]]+)\]\(.+$/;

const asciiPunctuation = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;

/**
 * Parses the bare link destination that follows `](`, up to and including the
 * closing `)`, following CommonMark rules: unescaped `(`/`)` must stay
 * balanced, backslash escapes apply to ASCII punctuation, the destination
 * contains no whitespace, and an optional `"title"` may follow. Since the rule
 * only fires while typing at the caret, the destination must close at the very
 * end of `tail` — a `)` that merely balances an earlier `(` does not convert.
 */
export function parseLinkDestination(
  tail: string,
): { href: string; title: string | null } | null {
  let href = "";
  // `1` accounts for the opening `(` of `](` that the caller already consumed.
  let depth = 1;
  let i = 0;
  while (i < tail.length) {
    const ch = tail[i];
    if (ch === "\\" && i + 1 < tail.length) {
      const next = tail[i + 1];
      href += asciiPunctuation.test(next) ? next : `\\${next}`;
      i += 2;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      href += ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i === tail.length - 1 ? { href, title: null } : null;
      }
      href += ch;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (depth !== 1) return null;
      const rest = tail.slice(i);
      const title = /^\s+"(?<title>[^"]*)"\)$/.exec(rest)?.groups?.title;
      return title === undefined ? null : { href, title };
    }
    href += ch;
    i += 1;
  }
  return null;
}

/**
 * Shared body of the live link rule, kept pure so Node tests can drive it with
 * a real ProseMirror document state (no browser/DOM required). `start` and
 * `end` are the doc positions prosemirror-inputrules passes to handlers:
 * the whole `[label](…` span up to the caret, the freshly typed character
 * included in `match` but not yet in the document.
 */
function applyLinkInputRule(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
  linkType: MarkType,
): Transaction | null {
  const label = match.groups?.text;
  if (!label) return null;
  const closeIndex = match[0].indexOf("]");
  const destStart = start + 1 + label.length; // position of the closing `]`
  // The regex matched the parent's text projection; verify it still lines up
  // with the actual document before mutating anything.
  if (state.doc.textBetween(start, start + 1, null, "\ufffc") !== "[") {
    return null;
  }
  if (state.doc.textBetween(destStart, destStart + 2, null, "\ufffc") !== "](") {
    return null;
  }
  const parsed = parseLinkDestination(match[0].slice(closeIndex + 2));
  if (!parsed || !parsed.href) return null;

  const link = linkType.create({ href: parsed.href, title: parsed.title });
  const tr = state.tr;
  // Drop the `](…` tail first so later steps keep their positions; this also
  // removes the `)` the user just typed, which input rules consume.
  tr.delete(destStart, end);
  // Keep the label fragment with its existing marks (e.g. `[**bold**](…)`);
  // only the link mark is applied instead of rebuilding plain text.
  tr.addMark(start + 1, destStart, link);
  tr.delete(start, start + 1);
  // Don't let the mark bleed into text typed right after the link.
  tr.removeStoredMark(linkType);
  return tr;
}

/**
 * Builds the live `[text](url)` input rule around a link mark type. Split out
 * of the Milkdown plugin so tests can exercise the real rule with their own
 * schema.
 */
export function createLinkInputRule(linkType: MarkType): InputRule {
  return new InputRule(linkPattern, (state, match, start, end) =>
    applyLinkInputRule(state, match, start, end, linkType),
  );
}

/**
 * Renders `[text](url)` as a live link while typing — milkdown's commonmark
 * preset ships no link input rule, so typed markdown links stayed raw text.
 * Fires when a balanced closing `)` completes the pattern; Ctrl+Z undoes it.
 */
export const linkInputRule = $inputRule((ctx) =>
  createLinkInputRule(linkSchema.type(ctx)),
);
