import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import sharp from 'sharp';

/**
 * Real downloaded PNG evidence for the AI生成 / 虚构 disclosure:
 * the exported file itself contains the dark band and the light label text
 * pixels (not just an HTML string match).
 */
export async function assertDisclosureInPng(file: string) {
  const bytes = await fs.readFile(file);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const meta = await sharp(bytes).metadata();
  expect(meta.width).toBeGreaterThan(0);
  const height = Math.min(250, meta.height!);
  const { data, info } = await sharp(bytes).extract({ left: 0, top: 0, width: meta.width!, height }).raw().toBuffer({ resolveWithObject: true });
  let bandPixels = 0;
  let lightPixels = 0;
  // The band is below device chrome. Count text contrast only in rows that
  // actually belong to the dark band, not white chat backgrounds elsewhere.
  for (let y = 0; y < info.height; y += 1) {
    let dark = 0;
    let light = 0;
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.abs(r - 31) < 12 && Math.abs(g - 36) < 12 && Math.abs(b - 48) < 12) dark += 1;
      if (r > 235 && g > 235 && b > 235) light += 1;
    }
    if (dark > info.width * 0.5) {
      bandPixels += dark;
      lightPixels += light;
    }
  }
  expect(bandPixels, 'disclosure band background is in the exported PNG').toBeGreaterThan(100);
  expect(lightPixels, 'disclosure label text contrast pixels are in the exported PNG').toBeGreaterThan(50);
}

/**
 * Inverse evidence for a user-chosen watermark-free scene: the exported PNG
 * contains no full-width disclosure band at all (checked with the exact same
 * band colour test as `assertDisclosureInPng`, so the two cannot drift apart).
 */
export async function assertNoDisclosureInPng(file: string) {
  const bytes = await fs.readFile(file);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const meta = await sharp(bytes).metadata();
  expect(meta.width).toBeGreaterThan(0);
  const height = Math.min(250, meta.height!);
  const { data, info } = await sharp(bytes).extract({ left: 0, top: 0, width: meta.width!, height }).raw().toBuffer({ resolveWithObject: true });
  let bandRows = 0;
  for (let y = 0; y < info.height; y += 1) {
    let dark = 0;
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.abs(r - 31) < 12 && Math.abs(g - 36) < 12 && Math.abs(b - 48) < 12) dark += 1;
    }
    if (dark > info.width * 0.5) bandRows += 1;
  }
  expect(bandRows, 'no disclosure band in the exported PNG').toBe(0);
}
