import { checkPose, type GovernorOutput, type PlatformGeometry, type SafetyLimits } from '@peeqo/core';

const GRID = 73;
const HEAVE_BUCKET_MM = 0.5;

/**
 * Pitch × roll map of the safe range at the current height: green where checkPose passes. Markers show the
 * requested target (ring, red when it is outside), the governor's goal (diamond) and the head now (dot).
 */
export class EnvelopePlot {
  readonly #canvas: HTMLCanvasElement;
  readonly #geometry: PlatformGeometry;
  readonly #limits: SafetyLimits;
  readonly #rangeDeg: number;
  readonly #masks = new Map<number, ImageData>();
  readonly #maskCanvas = new OffscreenCanvas(GRID, GRID);
  #shownBucket: number | null = null;

  constructor(canvas: HTMLCanvasElement, geometry: PlatformGeometry, limits: SafetyLimits, rangeDeg = 12) {
    this.#canvas = canvas;
    this.#geometry = geometry;
    this.#limits = limits;
    this.#rangeDeg = rangeDeg;
  }

  draw(output: GovernorOutput): void {
    const canvas = this.#canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = canvas.width;
    const bucket = Math.round(output.pose.heaveMm / HEAVE_BUCKET_MM) * HEAVE_BUCKET_MM;
    if (bucket !== this.#shownBucket) {
      let mask = this.#masks.get(bucket);
      if (!mask) {
        mask = this.#computeMask(bucket);
        this.#masks.set(bucket, mask);
      }
      this.#maskCanvas.getContext('2d')?.putImageData(mask, 0, 0);
      this.#shownBucket = bucket;
    }
    // Scale the mask up to the canvas with crisp cells.
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.#maskCanvas, 0, 0, size, size);

    const toPx = (deg: number) => ((deg + this.#rangeDeg) / (2 * this.#rangeDeg)) * size;
    const clampPx = (v: number) => Math.min(size - 4, Math.max(4, v));
    const point = (rollDeg: number, pitchDeg: number) => ({ x: clampPx(toPx(rollDeg)), y: clampPx(size - toPx(pitchDeg)) });
    const scale = size / 240;

    // Axes and 5° grid.
    ctx.lineWidth = 1;
    for (let d = -this.#rangeDeg; d <= this.#rangeDeg; d += 5) {
      const p = toPx(d);
      ctx.strokeStyle = d === 0 ? 'rgba(31,35,40,0.45)' : 'rgba(31,35,40,0.08)';
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, size - p);
      ctx.lineTo(size, size - p);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(31,35,40,0.6)';
    ctx.font = `${11 * scale}px system-ui, sans-serif`;
    ctx.fillText('pitch ↑', 6 * scale, 14 * scale);
    ctx.fillText('roll →', size - 44 * scale, size - 6 * scale);

    const clamped =
      Math.abs(output.requested.pitchDeg - output.goal.pitchDeg) > 1e-6 ||
      Math.abs(output.requested.rollDeg - output.goal.rollDeg) > 1e-6 ||
      Math.abs(output.requested.heaveMm - output.goal.heaveMm) > 1e-6;
    const req = point(output.requested.rollDeg, output.requested.pitchDeg);
    ctx.strokeStyle = clamped ? '#e5484d' : '#0969da';
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.arc(req.x, req.y, 6 * scale, 0, Math.PI * 2);
    ctx.stroke();

    const goal = point(output.goal.rollDeg, output.goal.pitchDeg);
    ctx.fillStyle = '#0969da';
    ctx.beginPath();
    ctx.moveTo(goal.x, goal.y - 5 * scale);
    ctx.lineTo(goal.x + 5 * scale, goal.y);
    ctx.lineTo(goal.x, goal.y + 5 * scale);
    ctx.lineTo(goal.x - 5 * scale, goal.y);
    ctx.closePath();
    ctx.fill();

    const now = point(output.pose.rollDeg, output.pose.pitchDeg);
    ctx.fillStyle = '#1f2328';
    ctx.beginPath();
    ctx.arc(now.x, now.y, 3.5 * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  #computeMask(heaveMm: number): ImageData {
    const data = new ImageData(GRID, GRID);
    for (let row = 0; row < GRID; row++) {
      const pitchDeg = this.#rangeDeg - (row / (GRID - 1)) * 2 * this.#rangeDeg;
      for (let col = 0; col < GRID; col++) {
        const rollDeg = -this.#rangeDeg + (col / (GRID - 1)) * 2 * this.#rangeDeg;
        const ok = checkPose({ pitchDeg, rollDeg, heaveMm }, this.#geometry, this.#limits).ok;
        const i = (row * GRID + col) * 4;
        data.data.set(ok ? [196, 232, 204, 255] : [238, 240, 243, 255], i);
      }
    }
    return data;
  }
}
