#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const https = require('https');
const http = require('http');
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

async function resolveInput() {
  let input = process.argv[2];

  if (input === '--help' || input === '-h') {
    console.log(`
  @atlaxt/favicon — image → favicon files converter

  Usage:
    npx @atlaxt/favicon <path-to-image>
    npx @atlaxt/favicon <url>

  Example:
    npx @atlaxt/favicon logo.png
    npx @atlaxt/favicon logo.svg
    npx @atlaxt/favicon https://example.com

  Output:
    favicon.ico, favicon.png, apple-touch-icon.png
    Saves to public/ if it exists, otherwise current working directory.
`);
    process.exit(0);
  }

  if (input) {
    return input.trim().replace(/^['"]|['"]$/g, '');
  }

  console.log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  input = await new Promise(resolve => {
    rl.question('  Enter the path, URL, or drag the image here: ', answer => {
      rl.close();
      resolve(answer.trim().replace(/^['"]|['"]$/g, ''));
    });
  });
  if (!input) fail('No path provided.');

  return input;
}

// ── URL fetch ─────────────────────────────────────────────────────────────────

function fetchBuffer(url, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'to-favicon/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(new URL(res.headers.location, url).href, depth + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// If the buffer is an ICO file, extract the largest embedded image from it.
// Modern ICOs embed PNG data directly, which sharp can process.
function extractFromIco(buf) {
  if (buf.length < 6) return null;
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  let bestSize = 0, bestBuf = null;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    if (entry + 16 > buf.length) break;
    const w = buf.readUInt8(entry) || 256;
    const size = buf.readUInt32LE(entry + 8);
    const dataOffset = buf.readUInt32LE(entry + 12);
    if (dataOffset + size > buf.length) break;
    if (w >= bestSize) {
      bestSize = w;
      bestBuf = buf.slice(dataOffset, dataOffset + size);
    }
  }
  return bestBuf;
}

async function fetchFaviconFromPage(pageUrl) {
  log(`Fetching page  →  ${pageUrl}`);
  let html;
  try {
    const buf = await fetchBuffer(pageUrl);
    html = buf.toString('utf8');
  } catch (err) {
    fail(`Could not fetch page: ${err.message}`);
  }

  const base = new URL(pageUrl);

  // Collect all icon link hrefs
  const iconTagRe = /<link[^>]*\brel=["'][^"']*\bicon\b[^"']*["'][^>]*>/gi;
  const hrefValRe = /\bhref=["']([^"']+)["']/i;
  const hrefs = [];
  let m;
  while ((m = iconTagRe.exec(html)) !== null) {
    const hm = m[0].match(hrefValRe);
    if (hm) hrefs.push(hm[1]);
  }

  // prefer PNG/SVG/WebP over ICO
  const preferred = hrefs.find(h => /\.(png|svg|webp|jpg|jpeg)(\?|#|$)/i.test(h));
  const faviconPath = preferred || hrefs[0] || '/favicon.ico';
  const faviconUrl = new URL(faviconPath, base).href;

  log(`Found favicon  →  ${faviconUrl}`);
  let imgBuf;
  try {
    imgBuf = await fetchBuffer(faviconUrl);
  } catch (err) {
    fail(`Could not fetch favicon: ${err.message}`);
  }

  // If it's an ICO, extract the largest embedded image for sharp to process
  if (imgBuf.length >= 4 && imgBuf.readUInt16LE(0) === 0 && imgBuf.readUInt16LE(2) === 1) {
    const extracted = extractFromIco(imgBuf);
    if (extracted) return extracted;
  }

  return imgBuf;
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

const ICO_SIZES = [16, 32, 48];

async function main() {
  const input = await resolveInput();

  const isUrl = /^https?:\/\//i.test(input);

  let sharpInput;

  if (isUrl) {
    console.log('');
    sharpInput = await fetchFaviconFromPage(input);
  } else {
    const inputPath = path.resolve(process.cwd(), input);

    if (!fs.existsSync(inputPath)) {
      fail(`File not found: ${inputPath}`);
    }

    const ext = path.extname(inputPath).toLowerCase();
    const SUPPORTED = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.tiff', '.tif', '.gif', '.svg'];
    if (!SUPPORTED.includes(ext)) {
      fail(`Unsupported format: ${ext || '(no extension)'}. Supported: ${SUPPORTED.join(', ')}`);
    }

    sharpInput = inputPath;
    console.log('');
    log(`Reading  →  ${path.basename(inputPath)}`);
  }

  const publicDir = path.join(process.cwd(), 'public');
  const outputDir = fs.existsSync(publicDir) && fs.statSync(publicDir).isDirectory()
    ? publicDir
    : process.cwd();

  const bg = { r: 0, g: 0, b: 0, alpha: 0 };

  // favicon.ico (16, 32, 48)
  let icoBuffers;
  try {
    icoBuffers = await Promise.all(
      ICO_SIZES.map(size =>
        sharp(sharpInput)
          .resize(size, size, { fit: 'contain', background: bg })
          .png()
          .toBuffer()
      )
    );
  } catch (err) {
    fail(`Resize failed: ${err.message}`);
  }

  fs.writeFileSync(path.join(outputDir, 'favicon.ico'), buildIco(icoBuffers));
  log(`Output   →  ${path.join(outputDir, 'favicon.ico')}`);

  // favicon.png (32x32)
  try {
    await sharp(sharpInput)
      .resize(32, 32, { fit: 'contain', background: bg })
      .png()
      .toFile(path.join(outputDir, 'favicon.png'));
  } catch (err) {
    fail(`favicon.png failed: ${err.message}`);
  }
  log(`Output   →  ${path.join(outputDir, 'favicon.png')}`);

  // apple-touch-icon.png (180x180)
  try {
    await sharp(sharpInput)
      .resize(180, 180, { fit: 'contain', background: bg })
      .png()
      .toFile(path.join(outputDir, 'apple-touch-icon.png'));
  } catch (err) {
    fail(`apple-touch-icon.png failed: ${err.message}`);
  }
  log(`Output   →  ${path.join(outputDir, 'apple-touch-icon.png')}`);

  console.log(`\n  ✔  Done!\n`);
}

main().catch(err => fail(err.message));
