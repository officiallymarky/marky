#!/usr/bin/env node
/**
 * Runs the scripted UI checks (`just e2e`): starts Vite on the project's E2E
 * port, drives the harness page in headless Chrome over the devtools protocol,
 * and reports the scenarios' checks.
 *
 * No test-runner dependency: Chrome and Node's built-in WebSocket are enough.
 * The dev server uses port 1421 so it never collides with `just dev` (1420).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 1421;
const PAGE = `http://127.0.0.1:${PORT}/tests/e2e/harness.html`;
const CHROME = process.env.CHROME ?? "google-chrome-stable";
const READY_TIMEOUT_MS = 60_000;
const RESULT_TIMEOUT_MS = 180_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, check, timeout = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** A minimal devtools-protocol client over one page target. */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const logs = [];
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (event) => reject(new Error(String(event.message ?? event))));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry?.reject(new Error(JSON.stringify(message.error)));
      else entry?.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      logs.push(
        `console.${message.params.type}: ${message.params.args
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" ")}`,
      );
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      logs.push(`exception: ${details.exception?.description ?? details.text}`);
    }
    if (message.method === "Log.entryAdded") {
      logs.push(`log.${message.params.entry.level}: ${message.params.entry.text}`);
    }
  });
  return {
    logs,
    ready,
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text);
      }
      return result.result.value;
    },
    close() {
      socket.close();
    },
  };
}

async function startVite() {
  const server = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));
  await waitFor("the dev server", async () => {
    if (server.exitCode !== null) {
      throw new Error(`vite exited with ${server.exitCode}:\n${output}`);
    }
    const response = await fetch(PAGE);
    return response.ok;
  });
  return server;
}

async function startChrome() {
  const profile = await mkdtemp(join(tmpdir(), "marky-e2e-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const portFile = join(profile, "DevToolsActivePort");
  const port = await waitFor("chrome's debug port", async () =>
    (await readFile(portFile, "utf8")).split("\n")[0] || null,
  );
  return { chrome, profile, port };
}

async function openTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(PAGE)}`, {
    method: "PUT",
  });
  if (!response.ok) throw new Error(`could not open a page target: ${response.status}`);
  const target = await response.json();
  return target.webSocketDebuggerUrl;
}

const report = (outcome) => {
  for (const scenario of outcome.scenarios) {
    console.log(`${scenario.ok ? "✔" : "✖"} ${scenario.name}`);
    if (scenario.error) console.log(`    threw: ${scenario.error}`);
    for (const check of scenario.checks) {
      if (check.ok) continue;
      console.log(`    ✖ ${check.label}${check.detail ? ` — got: ${check.detail}` : ""}`);
    }
  }
  const failed = outcome.scenarios.filter((scenario) => !scenario.ok).length;
  console.log(
    `\n${outcome.scenarios.length - failed}/${outcome.scenarios.length} scenarios passed`,
  );
  for (const problem of outcome.problems ?? []) console.log(`    page problem: ${problem}`);
  return failed === 0 && (outcome.problems ?? []).length === 0;
};

let server;
let chrome;
let profile;
let client;
let port;
try {
  server = await startVite();
  ({ chrome, profile, port } = await startChrome());
  client = connect(await openTarget(port));
  await client.ready;
  await client.send("Runtime.enable");

  await waitFor(
    "the scenarios to finish",
    async () => (await client.evaluate("window.markyHarness?.finished === true")) === true,
    RESULT_TIMEOUT_MS,
  );
  const outcome = await client.evaluate("JSON.stringify(window.markyHarness.outcome)");
  const ok = report(JSON.parse(outcome));
  if (!ok) {
    for (const log of client.logs.slice(-40)) console.log(`    ${log}`);
  }
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(`e2e failed: ${error.message}`);
  // The page records its own failure and the errors it saw, so a timeout is
  // never the only clue.
  const failure = await client?.evaluate("window.markyHarness?.failure ?? null").catch(() => null);
  if (failure) console.error(`page failure:\n${failure}`);
  const problems = await client
    ?.evaluate("JSON.stringify(window.markyHarness?.state?.problems ?? [])")
    .catch(() => null);
  if (problems && problems !== "[]") console.error(`page problems: ${problems}`);
  for (const log of client?.logs?.slice(-40) ?? []) console.error(`    ${log}`);
  process.exitCode = 1;
} finally {
  client?.close();
  chrome?.kill("SIGTERM");
  server?.kill("SIGTERM");
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
