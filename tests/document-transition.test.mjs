import assert from "node:assert/strict";
import { test } from "node:test";

import { createDocumentTransitions } from "../src/document-transition.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a transition superseded before it starts never runs", async () => {
  const transitions = createDocumentTransitions();
  const rebuilt = [];
  const first = transitions.run(async () => {
    rebuilt.push("first");
  });
  const second = transitions.run(async () => {
    rebuilt.push("second");
  });
  await Promise.all([first, second]);
  assert.deepEqual(rebuilt, ["second"]);
});

test("transitions run one at a time, in request order", async () => {
  const transitions = createDocumentTransitions();
  const events = [];
  const running = transitions.run(async () => {
    events.push("start");
    await tick();
    events.push("end");
  });
  await tick();
  const queued = transitions.run(async () => {
    events.push("next");
  });
  await Promise.all([running, queued]);
  // The second rebuild waits for the first: two editors at once is the bug.
  assert.deepEqual(events, ["start", "end", "next"]);
});

test("a failed rebuild does not block the transitions behind it", async () => {
  const transitions = createDocumentTransitions();
  const rebuilt = [];
  const failure = transitions.run(async () => {
    await tick();
    throw new Error("rebuild failed");
  });
  await tick();
  const next = transitions.run(async () => {
    rebuilt.push("next");
  });
  await assert.rejects(failure, /rebuild failed/);
  await next;
  assert.deepEqual(rebuilt, ["next"]);
});
