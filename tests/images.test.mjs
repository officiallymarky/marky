import assert from "node:assert/strict";
import { test } from "node:test";
import { imageSource } from "../src/images.ts";

const NOTES = "/home/me/notes/today.md";
const file = (path) => ({ kind: "file", path });

test("a relative image resolves against the document's folder", () => {
  assert.deepEqual(imageSource("pic.png", NOTES), file("/home/me/notes/pic.png"));
  assert.deepEqual(imageSource("./img/pic.png", NOTES), file("/home/me/notes/img/pic.png"));
  assert.deepEqual(imageSource("../shared/pic.png", NOTES), file("/home/me/shared/pic.png"));
});

test("percent-encoding in the source is decoded, but not in the document path", () => {
  assert.deepEqual(imageSource("my%20pic.png", NOTES), file("/home/me/notes/my pic.png"));
  assert.deepEqual(
    imageSource("pic.png", "/home/me/100% #1?/today.md"),
    file("/home/me/100% #1?/pic.png"),
  );
});

test("absolute paths and file URLs name local files directly", () => {
  assert.deepEqual(imageSource("/srv/pic.png", NOTES), file("/srv/pic.png"));
  assert.deepEqual(imageSource("/srv/pic.png", null), file("/srv/pic.png"));
  assert.deepEqual(imageSource("file:///srv/my%20pic.png", null), file("/srv/my pic.png"));
});

test("Windows paths keep their drive", () => {
  assert.deepEqual(imageSource("img\\pic.png", "C:\\Users\\me\\today.md"), file("C:/Users/me/img/pic.png"));
  assert.deepEqual(imageSource("D:\\pics\\pic.png", NOTES), file("D:/pics/pic.png"));
  assert.deepEqual(imageSource("../../pic.png", "C:\\today.md"), file("C:/pic.png"));
});

test("web, data and blob images are told apart from files", () => {
  assert.deepEqual(imageSource("https://example.com/a.png", NOTES), {
    kind: "remote",
    url: "https://example.com/a.png",
  });
  assert.deepEqual(imageSource("//example.com/a.png", NOTES), {
    kind: "remote",
    url: "//example.com/a.png",
  });
  assert.deepEqual(imageSource("data:image/png;base64,AA==", NOTES), {
    kind: "inline",
    url: "data:image/png;base64,AA==",
  });
});

test("an image with nothing to resolve shows nothing", () => {
  assert.deepEqual(imageSource("", NOTES), { kind: "none" });
  assert.deepEqual(imageSource("pic.png", null), { kind: "none" });
  assert.deepEqual(imageSource("javascript:alert(1)", NOTES), { kind: "none" });
  assert.deepEqual(imageSource("file://server/share/pic.png", NOTES), { kind: "none" });
});
