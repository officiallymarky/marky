import assert from "node:assert/strict";
import { test } from "node:test";
import { getDocumentTitle, splitFrontmatter } from "../src/frontmatter.ts";
import {
  buildFrontMatterBlock,
  readKnownFields,
  todayIsoDate,
  updateFrontMatterBlock,
} from "../src/frontmatter-wizard.ts";

/**
 * @param {{ title: string, date: string | null, tags: string[], aliases: string[], status: string }} fields
 * The generated block must survive the real split + title read.
 */
function roundTrip(fields) {
  const block = buildFrontMatterBlock(fields);
  const { front, body } = splitFrontmatter(block);
  return {
    block,
    front,
    title: getDocumentTitle(front, "fallback.md"),
    body,
  };
}

test("generated block round-trips through the real frontmatter reader", () => {
  const result = roundTrip({
    title: "Release notes",
    date: "2026-09-28",
    tags: ["work", "notes"],
    aliases: ["release", "changelog"],
    status: "draft",
  });
  assert.equal(
    result.block,
    '---\ntitle: Release notes\ndate: 2026-09-28\ntags: ["work", "notes"]\naliases: ["release", "changelog"]\nstatus: draft\n---\n\n',
  );
  assert.equal(result.title, "Release notes");
  assert.equal(result.body, "\n", "blank separator line stays in the body");
});

test("edge-case titles still round-trip through the reader", () => {
  for (const title of [
    "Quote: inside",
    "# heading-like",
    "42",
    "- dash start",
    'say "hi"',
    "true",
  ]) {
    const result = roundTrip({
      title,
      date: null,
      tags: [],
      aliases: [],
      status: "",
    });
    assert.equal(result.title, title, `round-trip failed for: ${title}`);
    assert.ok(result.front, `block still parses for: ${title}`);
  }
});

test("empty or omitted fields keep the block minimal", () => {
  assert.equal(
    buildFrontMatterBlock({ title: "", date: null, tags: [], aliases: [], status: "" }),
    "---\n---\n\n",
  );
  const tagsOnly = buildFrontMatterBlock({
    title: "",
    date: null,
    tags: [],
    aliases: ['say "hi"'],
    status: "",
  });
  assert.equal(tagsOnly, '---\naliases: ["say \\"hi\\""]\n---\n\n');
});

test("existing front matter is read into the dialog fields", () => {
  const { prefill, supported } = readKnownFields(
    '---\ntitle: "My: note"\ndate: 2026-01-02\ntags: [a, "b c"]\nstatus: review\npublish: true\ncustom: keep\n---\n',
  );
  assert.ok(supported);
  assert.deepEqual(prefill, {
    title: "My: note",
    date: "2026-01-02",
    tags: ["a", "b c"],
    aliases: [],
    status: "review",
  });
});

test("multi-line known values are reported unsupported", () => {
  const { supported } = readKnownFields(
    "---\ntags:\n  - nested\n  - list\n---\n",
  );
  assert.equal(supported, false);
});

test("scalar values the dialog cannot read block the rewrite", () => {
  for (const value of [
    "!!str Example", // explicit tag
    "&anchor text", // anchor
    "*alias", // alias reference
    "[a, b]", // flow sequence
    "{a: b}", // flow mapping
    "42", // number
    "true", // boolean
    "~", // null
    '""', // quoted empty string
  ]) {
    const front = `---\ntitle: ${value}\nstatus: draft\n---\n\n`;
    const read = readKnownFields(front);
    assert.equal(read.supported, false, `expected ${value} to be unsupported`);
    // The refused update leaves the block untouched.
    assert.equal(
      updateFrontMatterBlock(front, { ...read.prefill, status: "review" }),
      null,
    );
  }
});

test("plain and quoted scalar values stay editable", () => {
  const front = '---\ntitle: "My: note"\nstatus: review\n---\n\n';
  const read = readKnownFields(front);
  assert.equal(read.supported, true);
  assert.equal(read.prefill.title, "My: note");
  assert.equal(
    updateFrontMatterBlock(front, { ...read.prefill, status: "done" }),
    '---\ntitle: "My: note"\nstatus: done\n---\n\n',
  );
});

test("updating rewrites known keys and preserves unknown ones byte-exact", () => {
  const front =
    '---\ntitle: Old\ntags: [old]\ncustom: keep me\ndate: 2026-01-01\n---\n\n';
  const updated = updateFrontMatterBlock(front, {
    title: "New title",
    date: "2026-02-03",
    tags: ["fresh", "list"],
    aliases: ["aka"],
    status: "published",
  });
  assert.equal(
    updated,
    '---\ntitle: New title\ntags: ["fresh", "list"]\ncustom: keep me\ndate: 2026-02-03\naliases: ["aka"]\nstatus: published\n---\n\n',
  );
  const { front: parsedFront } = splitFrontmatter(updated);
  assert.equal(getDocumentTitle(parsedFront, "fallback.md"), "New title");
  assert.ok(updateFrontMatterBlock(updated, {
    title: "New title",
    date: "2026-02-03",
    tags: ["fresh", "list"],
    aliases: ["aka"],
    status: "published",
  }), "generated blocks are themselves editable");
});

test("clearing a field removes its key; missing keys are appended", () => {
  const front = "---\ntitle: Old\nstatus: draft\n---\n\n";
  const updated = updateFrontMatterBlock(front, {
    title: "",
    date: "2026-03-04",
    tags: [],
    aliases: [],
    status: "",
  });
  assert.equal(updated, "---\ndate: 2026-03-04\n---\n\n");
});

test("multi-line known values block an update instead of corrupting", () => {
  const front = "---\ntags:\n  - nested\n---\n\n";
  const updated = updateFrontMatterBlock(front, {
    title: "New",
    date: null,
    tags: ["flat"],
    aliases: [],
    status: "",
  });
  assert.equal(updated, null);
});

test("CRLF endings of untouched lines are preserved", () => {
  const front = '---\r\ntitle: Old\r\ncustom: keep\r\n---\r\n\n';
  const updated = updateFrontMatterBlock(front, {
    title: "New",
    date: null,
    tags: [],
    aliases: [],
    status: "",
  });
  assert.equal(updated, '---\r\ntitle: New\r\ncustom: keep\r\n---\r\n\n');
});

test("unsupported list syntax refuses title-only updates instead of changing YAML data", () => {
  for (const entry of [
    "tags:\n- work\n- personal",
    "tags:\n\n# categories\n- work",
    "aliases:\n- alternate",
    "tags: ['work', 'personal']",
    "aliases: ['work, personal', 'writer''s note']",
    "tags: [work, [personal]]",
    "tags: [work] # categories",
  ]) {
    const front = `---\ntitle: Old\n${entry}\ncustom: keep\n---\n`;
    const read = readKnownFields(front);
    assert.equal(read.supported, false, entry);
    assert.equal(
      updateFrontMatterBlock(front, { ...read.prefill, title: "New" }),
      null,
      `must refuse to rewrite: ${entry}`,
    );
  }
});

test("title-only updates preserve supported list values with spaces, commas and escapes", () => {
  const front = '---\ntitle: Old\ntags: [work, "personal, notes", "say \\"hi\\""]\naliases: ["", "writer\'s note", "back\\\\slash"]\n---\n';
  const read = readKnownFields(front);
  assert.equal(read.supported, true);
  assert.deepEqual(read.prefill.tags, ["work", "personal, notes", 'say "hi"']);
  assert.deepEqual(read.prefill.aliases, ["", "writer's note", "back\\slash"]);
  const updated = updateFrontMatterBlock(front, { ...read.prefill, title: "New" });
  assert.notEqual(updated, null);
  assert.deepEqual(readKnownFields(updated), {
    supported: true,
    prefill: { ...read.prefill, title: "New" },
  });
});

test("today is a plain ISO date", () => {
  assert.match(todayIsoDate(), /^\d{4}-\d{2}-\d{2}$/);
});
