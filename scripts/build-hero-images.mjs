#!/usr/bin/env node
// Regenerates the homepage photo variants from the original. Output is committed
// so that a deployment does not depend on running this script. The 141 MB source
// PNG is deliberately git-ignored; keep a copy of it to regenerate the variants.
// Usage: node scripts/build-hero-images.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "public", "images", "guangzhou-dusk-original.png");
const output = join(root, "public", "images", "hero");
const widths = [2560, 1280];
const formats = [
  ["avif", (image) => image.avif({ quality: 58, effort: 6 })],
  ["webp", (image) => image.webp({ quality: 80, effort: 6 })],
  ["jpg", (image) => image.jpeg({ quality: 82, mozjpeg: true })],
];

// Buffers keep sharp away from the non-ASCII project path on Windows.
const input = await readFile(source);
await mkdir(output, { recursive: true });
for (const width of widths)
  for (const [extension, encode] of formats) {
    const path = join(output, `guangzhou-dusk-${width}.${extension}`);
    // sharp strips metadata by default, so location data can never be copied.
    const bytes = await encode(
      sharp(input, { limitInputPixels: false }).resize({ width, withoutEnlargement: true }),
    ).toBuffer();
    await writeFile(path, bytes);
    console.log(`${width}.${extension}: ${Math.round(bytes.length / 1024)} KiB`);
  }
