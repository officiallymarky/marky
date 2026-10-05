import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run with: node scripts/generate-icons.mjs. Uses the project's existing Tauri CLI.
const root = fileURLToPath(new URL("../", import.meta.url));
const icons = join(root, "src-tauri/icons");
const temp = mkdtempSync(join(tmpdir(), "marky-icons-"));
const full = join(temp, "full");
const small = join(temp, "small");
const tiny = join(temp, "tiny");

function render(source, output, sizes = []) {
  execFileSync("pnpm", [
    "exec", "tauri", "icon", source, "--output", output,
    ...sizes.flatMap((size) => ["--png", String(size)]),
  ], { cwd: root, stdio: "inherit" });
}

function png(size, simplified = false) {
  const directory = size === 16 ? tiny : simplified ? small : full;
  const name = size === 256 ? "128x128@2x.png" : `${size}x${size}.png`;
  return readFileSync(join(directory, name));
}

function icnsFrame(type, payload) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(payload.length + 8, 4);
  return Buffer.concat([header, payload]);
}

try {
  render(join(icons, "marky.png"), full);
  render(join(icons, "marky-small.svg"), small, [24, 30, 32, 44, 48, 64]);
  // At 16px the heading is noise; keep only the page and the bold m.
  const tinySource = join(temp, "tiny.svg");
  writeFileSync(tinySource, readFileSync(join(icons, "marky-small.svg"), "utf8")
    .replace(/  <g id="heading"[^>]*>[\s\S]*?<\/g>\n/, ""));
  render(tinySource, tiny, [16]);

  for (const name of readdirSync(full)) {
    if (name.endsWith(".png")) copyFileSync(join(full, name), join(icons, name));
  }
  for (const size of [16, 32, 48]) {
    writeFileSync(join(icons, `${size}x${size}.png`), png(size, true));
  }
  for (const size of [30, 44]) {
    writeFileSync(join(icons, `Square${size}x${size}Logo.png`), png(size, true));
  }

  // ICO supports individual PNG frames, so small sizes need not be downscaled
  // from the detailed artwork. Windows uses the nearest available resolution.
  const frames = [16, 24, 32, 48, 64, 256].map((size) => ({
    size,
    data: png(size, size <= 48),
  }));
  const icoHeader = Buffer.alloc(6 + frames.length * 16);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(frames.length, 4);
  let offset = icoHeader.length;
  for (const [index, frame] of frames.entries()) {
    const entry = 6 + index * 16;
    icoHeader[entry] = frame.size === 256 ? 0 : frame.size;
    icoHeader[entry + 1] = icoHeader[entry];
    icoHeader.writeUInt16LE(1, entry + 4);
    icoHeader.writeUInt16LE(32, entry + 6);
    icoHeader.writeUInt32LE(frame.data.length, entry + 8);
    icoHeader.writeUInt32LE(offset, entry + 12);
    offset += frame.data.length;
  }
  writeFileSync(join(icons, "icon.ico"), Buffer.concat([icoHeader, ...frames.map((frame) => frame.data)]));

  // Replace legacy 16/32px frames and Retina equivalents with the small artwork,
  // preserving Tauri's detailed 128–1024px macOS frames.
  const original = readFileSync(join(full, "icon.icns"));
  const replacements = new Set(["is32", "s8mk", "il32", "l8mk", "ic11", "ic12"]);
  const icnsFrames = [];
  for (let position = 8; position < original.length;) {
    const type = original.toString("ascii", position, position + 4);
    const length = original.readUInt32BE(position + 4);
    if (!replacements.has(type)) icnsFrames.push(original.subarray(position, position + length));
    position += length;
  }
  icnsFrames.push(
    icnsFrame("icp4", png(16, true)),
    icnsFrame("icp5", png(32, true)),
    icnsFrame("icp6", png(64)),
    icnsFrame("ic11", png(32, true)),
    icnsFrame("ic12", png(64, true)),
  );
  // Tauri's frame order can vary; stabilize the generated binary.
  icnsFrames.sort((a, b) => Buffer.compare(a.subarray(0, 4), b.subarray(0, 4)));
  const icnsHeader = Buffer.alloc(8);
  icnsHeader.write("icns");
  icnsHeader.writeUInt32BE(8 + icnsFrames.reduce((sum, frame) => sum + frame.length, 0), 4);
  writeFileSync(join(icons, "icon.icns"), Buffer.concat([icnsHeader, ...icnsFrames]));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
