/**
 * Scripted UI checks. The page reuses `index.html`'s markup so the harness
 * cannot drift from the real document, then drives the app through the events
 * the native shell sends (menu actions, focus changes) and asserts what is
 * actually rendered.
 *
 * Rendered state, not element flags: a `hidden` attribute can be overridden by
 * a class rule, which is how a previous find-bar regression shipped.
 *
 * Any failure here is recorded on `window.markyHarness` and `finished` is still
 * set, so `run.mjs` reports the reason instead of timing out.
 */
const harness = window.markyHarness;

const fail = (error) => {
  harness.failure = String(error?.stack ?? error);
  harness.finished = true;
};

try {
  const results = document.createElement("pre");
  results.id = "results";
  results.hidden = true;

  const markup = await (await fetch("/index.html")).text();
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  // The real page's script tag would load main.ts twice: once here, once below.
  for (const script of parsed.body.querySelectorAll("script")) script.remove();
  document.body.insertAdjacentHTML("afterbegin", parsed.body.innerHTML);
  document.body.append(results);

  // Seeded before the app starts, as `marky notes.md` would be.
  harness.startup({
    path: "/tmp/notes.md",
    name: "notes.md",
    content: "# Title\n\nHello world\n",
  });

  // A crash left unsaved writing behind: the startup prompt must fetch the
  // text on demand (`read_recovery`) and open it as an unsaved source copy.
  // Restoring is what the page starts from, so the `marky notes.md` path is
  // exercised by the open scenarios instead.
  harness.state.recovery = [
    {
      id: "2f1c4b6e-0f1a-4d2b-9c3e-5a6b7c8d9e0f",
      path: "/tmp/notes.md",
      name: "notes.md",
      content: "# Recovered\n\nUnsaved words\n",
      updatedAt: Date.now(),
    },
  ];
  harness.answer("Restore");

  const { runScenarios } = await import("./scenarios.js");
  await import("/src/main.ts");
  const outcome = await runScenarios(harness);

  results.textContent = JSON.stringify(outcome, null, 2);
  harness.outcome = outcome;
} catch (error) {
  fail(error);
}
harness.finished = true;
