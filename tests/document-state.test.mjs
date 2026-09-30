import assert from "node:assert/strict";
import { test } from "node:test";
import { DocumentState } from "../src/document-state.ts";

test("raw-mode edits remain dirty after returning to rich mode", () => {
  const document = new DocumentState();
  document.load("saved content\n");

  document.update("raw edit\n");
  document.update("normalized rich edit\n");

  assert.equal(document.content, "normalized rich edit\n");
  assert.equal(document.dirty, true);
});

test("saving a snapshot does not mark later edits clean", () => {
  const document = new DocumentState();
  document.load("saved content\n");
  document.update("submitted snapshot\n");
  const submittedSnapshot = document.content;

  document.update("edit during save\n");
  document.markSaved(submittedSnapshot);

  assert.equal(document.content, "edit during save\n");
  assert.equal(document.dirty, true);
});

test("loading a document resets its dirty baseline", () => {
  const document = new DocumentState();
  document.load("first document\n");
  document.update("first edit\n");

  document.load("second document\n");

  assert.equal(document.content, "second document\n");
  assert.equal(document.dirty, false);
});
