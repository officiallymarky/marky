import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALERT_KINDS,
  ALERT_TEXT,
  parseAlertMarker,
  restoreAlertMarkers,
} from "../src/alerts.ts";

test("parseAlertMarker recognizes every kind, case-insensitively", () => {
  assert.deepEqual(ALERT_KINDS, ["note", "tip", "important", "warning", "caution"]);
  assert.equal(parseAlertMarker("[!NOTE]"), "note");
  assert.equal(parseAlertMarker("[!Tip] some advice"), "tip");
  assert.equal(parseAlertMarker("[!IMPORTANT]"), "important");
  assert.equal(parseAlertMarker("[!warning]"), "warning");
  assert.equal(parseAlertMarker("[!CAUTION]"), "caution");
});

test("parseAlertMarker rejects non-alerts", () => {
  assert.equal(parseAlertMarker(""), null);
  assert.equal(parseAlertMarker(null), null);
  assert.equal(parseAlertMarker("plain text"), null);
  assert.equal(parseAlertMarker("note: not a marker"), null);
  assert.equal(parseAlertMarker("[!UNKNOWN]"), null);
  // Marker must start the line; leading text is not an alert.
  assert.equal(parseAlertMarker("see [!NOTE]"), null);
});

test("every alert kind has insertion text", () => {
  for (const kind of ALERT_KINDS) {
    assert.equal(typeof ALERT_TEXT[kind], "string");
    assert.ok(ALERT_TEXT[kind].length > 0);
  }
});

test("restoreAlertMarkers un-escapes the serializer's bracket escapes", () => {
  const md =
    "> \\[!NOTE]\\\n> Useful information that users should know, even when skimming content.\n";
  assert.equal(
    restoreAlertMarkers(md),
    "> [!NOTE]\\\n> Useful information that users should know, even when skimming content.\n",
  );
  // Both escape styles of the closing bracket are handled.
  assert.equal(restoreAlertMarkers("\\[!TIP\\] x"), "[!TIP] x");
  assert.equal(restoreAlertMarkers("\\[!WARNING]"), "[!WARNING]");
  // Non-alert bracket escapes stay escaped.
  assert.equal(restoreAlertMarkers("\\[!UNKNOWN] \\[1]"), "\\[!UNKNOWN] \\[1]");
  // Round trip: restored markers parse back to the same plain text.
  assert.equal(parseAlertMarker("[!NOTE]"), "note");
});
