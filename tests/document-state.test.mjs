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

test("restoring recovered content stays dirty even when empty", () => {
  const document = new DocumentState();
  document.load("saved content\n");
  const revisionBefore = document.revision;

  document.restore("");

  assert.equal(document.content, "");
  assert.equal(document.dirty, true);
  assert.equal(document.revision, revisionBefore + 1);
});

test("loading clears the recovered dirty flag", () => {
  const document = new DocumentState();
  document.restore("recovered\n");
  assert.equal(document.dirty, true);

  document.load("recovered\n");

  assert.equal(document.dirty, false);
  document.update("edited\n");
  assert.equal(document.dirty, true);
});

test("saving a restored buffer clears the recovered flag without hiding later edits", () => {
  const document = new DocumentState();
  document.restore("recovered\n");

  document.update("edit during save\n");
  document.markSaved("recovered\n");

  assert.equal(document.content, "edit during save\n");
  assert.equal(document.dirty, true);

  document.markSaved("edit during save\n");
  assert.equal(document.dirty, false);
});
