import type { LedPixel } from '@peeqo/core';

/**
 * The LED ring's pixels as the APA102 (DotStar) chips take them, in the 2019 dotstar.js layout: per LED, 0xE0 plus
 * the 5-bit brightness, then blue, green, red. The hardware helper adds the start and end frames.
 */
export function apa102Frame(pixels: readonly LedPixel[]): Uint8Array {
  const bytes = new Uint8Array(pixels.length * 4);
  pixels.forEach((p, i) => {
    const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    bytes[i * 4] = 0xe0 | Math.max(0, Math.min(31, Math.floor(p.brightness)));
    bytes[i * 4 + 1] = byte(p.b);
    bytes[i * 4 + 2] = byte(p.g);
    bytes[i * 4 + 3] = byte(p.r);
  });
  return bytes;
}
