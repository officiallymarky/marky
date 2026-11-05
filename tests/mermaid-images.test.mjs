import assert from "node:assert/strict";
import { test } from "node:test";
import mermaid from "mermaid";
import { hasRemoteMermaidImages } from "../src/mermaid-images.ts";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
const APP = "tauri://localhost/index.html";

test("image metadata is inspected after YAML quoting and escapes are parsed", async () => {
  for (const key of ["img", '"img"', '"i\\u006dg"']) {
    assert.equal(
      await hasRemoteMermaidImages(`flowchart TD\nA@{ ${key}: "https://example.invalid/beacon.png" }`, APP),
      true,
    );
  }
});

test("legacy graph and ELK flowcharts use the same image policy", async () => {
  for (const header of ["graph LR", "flowchart-elk TD"]) {
    assert.equal(
      await hasRemoteMermaidImages(`${header}\nA@{ img: "https://example.invalid/beacon.png" }`, APP),
      true,
    );
  }
});

test("remote image detection uses browser URL normalization", async () => {
  for (const url of ["HTTPS://example.invalid/a.png", "h\tt\ntps://example.invalid/a.png", "//example.invalid/a.png"]) {
    assert.equal(
      await hasRemoteMermaidImages(`flowchart TD\nA@{ img: ${JSON.stringify(url)} }`, "http://localhost:1420/"),
      true,
    );
  }
});

test("inline images, packaged resources and ordinary diagrams are not remote", async () => {
  for (const url of ["data:image/png;base64,AA==", "blob:tauri://localhost/example", "/assets/picture.png"]) {
    assert.equal(await hasRemoteMermaidImages(`flowchart TD\nA@{ img: ${JSON.stringify(url)} }`, APP), false);
  }
  assert.equal(await hasRemoteMermaidImages("flowchart TD\nA --> B", APP), false);
  assert.equal(
    await hasRemoteMermaidImages('flowchart TD\nA@{ img: "http://localhost:1420/assets/a.png" }', "http://localhost:1420/"),
    false,
  );
});

test("a malformed image value cannot hide a URL behind JavaScript coercion", async () => {
  await assert.rejects(
    hasRemoteMermaidImages('flowchart TD\nA@{ img: ["https://example.invalid/a.png"] }', APP),
    Error,
  );
});
