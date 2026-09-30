/** GitHub-style alert kinds: `> [!NOTE]` blockquotes. */
export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

export const ALERT_KINDS: AlertKind[] = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
];

/** Body text inserted under the `[!KIND]` marker (GitHub's own descriptions). */
export const ALERT_TEXT: Record<AlertKind, string> = {
  note: "Useful information that users should know, even when skimming content.",
  tip: "Helpful advice for doing things better or more easily.",
  important: "Key information users need to know to achieve their goal.",
  warning: "Urgent info that needs immediate user attention to avoid problems.",
  caution: "Advises about risks or negative outcomes of undesired outcomes.",
};

/**
 * Recognizes the `[!KIND]` marker at the start of a blockquote's first line.
 * Returns the lowercase kind, or null when the text is not an alert marker.
 */
export function parseAlertMarker(text: string | null | undefined): AlertKind | null {
  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(text ?? "");
  if (!match) return null;
  return match[1]!.toLowerCase() as AlertKind;
}

/**
 * The markdown serializer escapes `[` even for genuine alert markers, which
 * would stop GitHub and Obsidian from recognizing the alert. Undo that for
 * the marker pattern only; the escaped form parses back to the same text, so
 * this stays round-trip stable.
 */
export function restoreAlertMarkers(markdown: string): string {
  return markdown.replace(
    /\\\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\\?\]/g,
    "[!$1]",
  );
}
