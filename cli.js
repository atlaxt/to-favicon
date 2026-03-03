#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// ── helpers ───────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`\n  ✖  ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  console.log(`  ${msg}`);
}

// ── args ──────────────────────────────────────────────────────────────────────

const input = process.argv[2];

if (!input || input === '--help' || input === '-h') {
  console.log(`
  @atlaxt/favicon — PNG → favicon.ico converter

  Usage:
    npx @atlaxt/favicon <path-to-png>

  Example:
    npx @atlaxt/favicon logo.png
    npx @atlaxt/favicon ./assets/icon.png

  Output:
    Saves to public/ if it exists, otherwise current working directory.
`);
  process.exit(input ? 0 : 1);
}

// ── validate input ────────────────────────────────────────────────────────────

const inputPath = path.resolve(process.cwd(), input);

if (!fs.existsSync(inputPath)) {
  fail(`File not found: ${inputPath}`);
}

const ext = path.extname(inputPath).toLowerCase();
if (ext !== '.png') {
  fail(`Only PNG files are supported. Received: ${ext || '(no extension)'}`);
}

// ── ICO builder (PNG-embedded format) ─────────────────────────────────────────

function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const dirEntrySize = 16;
  let offset = 6 + count * dirEntrySize;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirs = pngBuffers.map(png => {
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    const dir = Buffer.alloc(dirEntrySize);
    dir.writeUInt8(w >= 256 ? 0 : w, 0);
    dir.writeUInt8(h >= 256 ? 0 : h, 1);
    dir.writeUInt8(0, 2);
    dir.writeUInt8(0, 3);
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += png.length;
    return dir;
  });

  return Buffer.concat([header, ...dirs, ...pngBuffers]);
}

// ── convert ───────────────────────────────────────────────────────────────────

const SIZES = [16, 32, 48];

const publicDir = path.join(process.cwd(), 'public');
const outputDir = fs.existsSync(publicDir) && fs.statSync(publicDir).isDirectory()
  ? publicDir
  : process.cwd();
const outputPath = path.join(outputDir, 'favicon.ico');

async function main() {
  console.log('');
  log(`Reading  →  ${path.basename(inputPath)}`);

  let metadata;
  try {
    metadata = await sharp(inputPath).metadata();
  } catch (err) {
    fail(`Could not read image: ${err.message}`);
  }

  log(`Size     →  ${metadata.width}×${metadata.height}px`);
  log(`Sizes    →  ${SIZES.map(s => `${s}×${s}`).join(', ')}`);

  let buffers;
  try {
    buffers = await Promise.all(
      SIZES.map(size =>
        sharp(inputPath)
          .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer()
      )
    );
  } catch (err) {
    fail(`Resize failed: ${err.message}`);
  }

  const ico = buildIco(buffers);

  fs.writeFileSync(outputPath, ico);

  log(`Output   →  ${outputPath}`);
  console.log(`\n  ✔  favicon.ico ready!\n`);
}

main().catch(err => fail(err.message));
