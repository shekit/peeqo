import { SecondOrder, seededRandom } from '@peeqo/core';
import { ClassicFace, FACE_HEIGHT, FACE_WIDTH } from './classicFace.ts';

/**
 * Peeqo's expressive eyes. They keep the 2019 look (black eyes on white, in the same place, so the glasses
 * overlays still fit) and add expression: each eye is shaped by its size, openness, a slanted top lid, a smiling
 * lower lid and, for love, a heart. Shapes change through springs, so they pop and settle rather than snap.
 *
 * It is alive on its own: it blinks at natural, varied intervals (sometimes twice, sometimes as it glances), and
 * its gaze wanders in quick saccades with tiny micro-saccades in between, unless told where to look.
 * Time is passed in (milliseconds), so any clock can drive it.
 */
export const EMOTIONS = [
  'neutral',
  'happy',
  'excited',
  'love',
  'sad',
  'angry',
  'surprised',
  'scared',
  'sleepy',
  'curious',
  'confused',
  'thinking',
  'listening',
  'shy',
  'wink',
  'skeptical',
  'asleep',
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export function isEmotion(name: string): name is Emotion {
  return (EMOTIONS as readonly string[]).includes(name);
}

/** One eye's shape. Lengths are in eye radii (the 2019 eye radius, 87.5 px). */
interface EyeShape {
  /** 1 = fully open, 0 = shut. */
  readonly open: number;
  /** Overall size. */
  readonly scale: number;
  /** Width relative to height: above 1 is wider. */
  readonly wide: number;
  /** How far the top lid comes down, as a share of the eye's height. */
  readonly lid: number;
  /** Top lid slant in radians: + lowers the inner corner (cross), − the outer corner (sad). */
  readonly slant: number;
  /** How far a smiling lower lid curves up into the eye, as a share of its height (the ^ ^ of a happy eye). */
  readonly smile: number;
  /** Vertical offset (+ down). */
  readonly dy: number;
  /** 0 = round eye, 1 = heart. */
  readonly heart: number;
  /** Size of the catch-lights: above 1 looks glossier (teary or sparkling). */
  readonly shine: number;
}

interface Look {
  readonly left: EyeShape; // the eye on the left of the screen (Peeqo's right eye)
  readonly right: EyeShape;
  /** Where the eyes tend to look, [x, y] in −1…1 (+x to the screen's right, +y down). */
  readonly gaze: readonly [number, number];
  /** How wide the wandering gaze ranges (0 = fixed on its bias). */
  readonly wander: number;
  /** Blink rate relative to normal. */
  readonly blinks: number;
}

const EYE: EyeShape = { open: 1, scale: 1, wide: 1, lid: 0, slant: 0, smile: 0, dy: 0, heart: 0, shine: 1 };
const both = (shape: Partial<EyeShape>): Pick<Look, 'left' | 'right'> => ({ left: { ...EYE, ...shape }, right: { ...EYE, ...shape } });

const LOOKS: Record<Emotion, Look> = {
  neutral: { ...both({}), gaze: [0, 0], wander: 1, blinks: 1 },
  happy: { ...both({ smile: 0.45, scale: 1.03 }), gaze: [0, -0.1], wander: 0.8, blinks: 1 },
  excited: { ...both({ scale: 1.14, smile: 0.3, wide: 1.04, shine: 1.35 }), gaze: [0, -0.15], wander: 1.2, blinks: 0.7 },
  love: { ...both({ heart: 1, scale: 1.08 }), gaze: [0, -0.05], wander: 0.4, blinks: 0.5 },
  sad: { ...both({ lid: 0.24, slant: -0.32, dy: 0.12, scale: 0.95, shine: 1.45 }), gaze: [0, 0.45], wander: 0.4, blinks: 0.8 },
  angry: { ...both({ lid: 0.38, slant: 0.42, scale: 0.97 }), gaze: [0, 0.05], wander: 0.3, blinks: 0.7 },
  surprised: { ...both({ scale: 1.24, wide: 0.96, shine: 1.15 }), gaze: [0, -0.05], wander: 0.2, blinks: 0.3 },
  scared: { ...both({ scale: 0.78, lid: 0.06, slant: -0.2, wide: 0.92, shine: 0.8 }), gaze: [0, 0], wander: 2.2, blinks: 1.6 },
  sleepy: { ...both({ lid: 0.52, dy: 0.05 }), gaze: [0, 0.3], wander: 0.25, blinks: 0.6 },
  curious: {
    left: { ...EYE, scale: 1.12 },
    right: { ...EYE, scale: 0.94, lid: 0.2, slant: 0.1 },
    gaze: [0.25, -0.2],
    wander: 0.7,
    blinks: 0.9,
  },
  confused: {
    left: { ...EYE, scale: 0.92, lid: 0.32, slant: 0.28 },
    right: { ...EYE, scale: 1.1, lid: 0.04, slant: -0.12 },
    gaze: [0, -0.1],
    wander: 1.4,
    blinks: 1.2,
  },
  thinking: { ...both({ lid: 0.18, slant: 0.06, scale: 0.98 }), gaze: [-0.6, -0.6], wander: 0.35, blinks: 0.8 },
  listening: { ...both({ scale: 1.06 }), gaze: [0, -0.05], wander: 0.35, blinks: 0.9 },
  shy: { ...both({ smile: 0.32, scale: 0.94, dy: 0.06 }), gaze: [0.5, 0.5], wander: 0.4, blinks: 1.3 },
  wink: {
    left: { ...EYE, smile: 0.34 },
    right: { ...EYE, open: 0, smile: 0.5 },
    gaze: [0, -0.05],
    wander: 0.5,
    blinks: 0,
  },
  skeptical: {
    left: { ...EYE, lid: 0.42, slant: 0.08 },
    right: { ...EYE, scale: 1.04 },
    gaze: [0.3, 0],
    wander: 0.3,
    blinks: 0.7,
  },
  asleep: { ...both({ open: 0, dy: 0.08 }), gaze: [0, 0.2], wander: 0, blinks: 0 },
};

/** Where gaze offsets reach, in pixels: inside the glasses' lenses. */
const GAZE_PX = { x: 38, y: 26 };
const SHAPE_KEYS = ['open', 'scale', 'wide', 'lid', 'slant', 'smile', 'dy', 'heart', 'shine'] as const;
const BLINK = { closeMs: 70, shutMs: 35, openMs: 140 };

/** A picture or video to show on the screen (a GIF reaction), with its natural size. */
export interface ScreenMedia {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
}

const MEDIA_FADE_IN_MS = 220;
const MEDIA_FADE_OUT_MS = 280;

export interface ExpressiveFaceOptions {
  /** Seed for blinks and glances, so a run can be replayed exactly. */
  readonly seed?: number;
}

export interface FaceState {
  readonly emotion: Emotion;
  readonly intensity: number;
  /** Current gaze, −1…1. */
  readonly gaze: readonly [number, number];
  /** 1 = eyes open, 0 = mid-blink shut. */
  readonly blink: number;
  /** Current eye radii in pixels (height already includes blinks and openness). */
  readonly eyes: readonly { readonly rx: number; readonly ry: number }[];
}

export class ExpressiveFace {
  static readonly EYE_X = [ClassicFace.LEFT_EYE_X, ClassicFace.RIGHT_EYE_X] as const;
  static readonly EYE_Y = ClassicFace.EYE_Y;
  static readonly EYE_RADIUS = ClassicFace.EYE_SIZE;

  readonly #random: () => number;
  readonly #shapes: SecondOrder;
  readonly #gaze: SecondOrder;
  #emotion: Emotion = 'neutral';
  #intensity = 1;
  #lookTarget: readonly [number, number] | null = null;
  #glanceTarget: [number, number] = [0, 0];
  #nextGlanceMs = 0;
  #nextMicroMs = 0;
  #micro: [number, number] = [0, 0];
  #blinkStartMs: number | null = null;
  #nextBlinkMs = 0;
  #doubleBlink = false;
  #blinking = true;
  #lastMs: number | null = null;
  #glasses: CanvasImageSource | null = null;
  #media: { readonly media: ScreenMedia; readonly startMs: number; readonly endMs: number } | null = null;

  constructor(options: ExpressiveFaceOptions = {}) {
    this.#random = seededRandom(options.seed ?? 1);
    this.#shapes = new SecondOrder(4.5, 0.55, 0.3, this.#shapeVector());
    this.#gaze = new SecondOrder(11, 0.85, 0, [0, 0]);
  }

  get emotion(): Emotion {
    return this.#emotion;
  }

  /** Changes the expression; intensity 0…1 blends from neutral. */
  setEmotion(emotion: Emotion, intensity = 1): void {
    if (!isEmotion(emotion)) throw new Error(`Unknown emotion "${String(emotion)}"`);
    this.#emotion = emotion;
    this.#intensity = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 1;
    this.#nextGlanceMs = 0; // glance toward the new expression's gaze right away
  }

  /** Looks at a point (−1…1, +x to the screen's right, +y down), or null to let the gaze wander. */
  lookAt(target: readonly [number, number] | null): void {
    this.#lookTarget = target === null ? null : [clamp(target[0], -1, 1), clamp(target[1], -1, 1)];
  }

  setGlasses(image: CanvasImageSource | null): void {
    this.#glasses = image;
  }

  /** Shows a picture or video in place of the eyes for a while, fading in and out. */
  showMedia(media: ScreenMedia, nowMs: number, durationMs: number): void {
    if (!(media.width > 0 && media.height > 0) || !(durationMs > 0)) throw new Error('Media needs a size and a duration');
    this.#media = { media, startMs: nowMs, endMs: nowMs + durationMs };
  }

  /** Ends any media now (it fades out). */
  hideMedia(nowMs: number): void {
    if (this.#media && this.#media.endMs > nowMs) this.#media = { ...this.#media, endMs: nowMs };
  }

  /** Whether media is on the screen (including its fades) at the last update. */
  get showingMedia(): boolean {
    return this.#mediaAlpha(this.#lastMs ?? 0) > 0;
  }

  /** Turns the automatic blinking on or off (a blink in progress finishes). */
  setBlinking(on: boolean): void {
    this.#blinking = on;
  }

  blink(nowMs: number): void {
    if (this.#blinkStartMs === null) this.#blinkStartMs = nowMs;
  }

  state(): FaceState {
    const shapes = this.#shapes.value;
    const blink = this.#blinkOpen(this.#lastMs ?? 0);
    const eyes = ([0, 1] as const).map((e) => {
      const s = shapeAt(shapes, e);
      const r = ExpressiveFace.EYE_RADIUS * s.scale;
      return { rx: r * Math.sqrt(s.wide), ry: (r / Math.sqrt(s.wide)) * clamp(s.open, 0, 1.2) * blink };
    });
    const g = this.#gaze.value;
    return { emotion: this.#emotion, intensity: this.#intensity, gaze: [g[0]!, g[1]!], blink, eyes };
  }

  /** Advances to nowMs. Returns true if the face should be redrawn (always: the eyes never quite hold still). */
  update(nowMs: number): boolean {
    const dt = this.#lastMs === null ? 0 : Math.min(0.1, Math.max(0, (nowMs - this.#lastMs) / 1000));
    this.#lastMs = nowMs;
    const look = LOOKS[this.#emotion];

    // Blinks: varied intervals, now and then a double blink.
    if (this.#blinking && look.blinks > 0 && this.#blinkStartMs === null && nowMs >= this.#nextBlinkMs) {
      this.#blinkStartMs = nowMs;
    }
    if (this.#blinkStartMs !== null && nowMs - this.#blinkStartMs > BLINK.closeMs + BLINK.shutMs + BLINK.openMs) {
      this.#blinkStartMs = null;
      if (this.#doubleBlink) {
        this.#doubleBlink = false;
        this.#nextBlinkMs = nowMs + 90;
      } else {
        this.#doubleBlink = this.#random() < 0.18;
        this.#nextBlinkMs = nowMs + (1800 + this.#random() * 4200) / Math.max(0.1, look.blinks);
      }
    }

    // Gaze: hold a point, then jump (a saccade) to another near where this expression looks.
    if (nowMs >= this.#nextGlanceMs) {
      const [bx, by] = look.gaze;
      const k = this.#intensity;
      const spread = 0.45 * look.wander;
      const angle = this.#random() * 2 * Math.PI;
      const dist = spread * Math.sqrt(this.#random()) * (this.#random() < 0.35 ? 0.3 : 1); // often near the bias
      const target: [number, number] = [clamp(bx * k + dist * Math.cos(angle), -1, 1), clamp(by * k + dist * Math.sin(angle) * 0.7, -1, 1)];
      // Big glances often come with a blink.
      if (Math.hypot(target[0] - this.#glanceTarget[0], target[1] - this.#glanceTarget[1]) > 0.55 && this.#random() < 0.4) this.blink(nowMs);
      this.#glanceTarget = target;
      this.#nextGlanceMs = nowMs + (700 + this.#random() * 2300) / Math.max(0.2, look.wander);
    }
    if (nowMs >= this.#nextMicroMs) {
      this.#micro = [(this.#random() * 2 - 1) * 0.025, (this.#random() * 2 - 1) * 0.02];
      this.#nextMicroMs = nowMs + 180 + this.#random() * 420;
    }
    const aim = this.#lookTarget ?? this.#glanceTarget;
    this.#gaze.update(dt, [aim[0] + this.#micro[0], aim[1] + this.#micro[1]]);
    this.#shapes.update(dt, this.#shapeVector());

    return true;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);
    const shapes = this.#shapes.value;
    const g = this.#gaze.value;
    const blink = this.#blinkOpen(this.#lastMs ?? 0);
    for (const e of [0, 1] as const) {
      const s = shapeAt(shapes, e);
      const r = ExpressiveFace.EYE_RADIUS * Math.max(0.05, s.scale);
      const rx = r * Math.sqrt(Math.max(0.3, s.wide));
      const fullRy = r / Math.sqrt(Math.max(0.3, s.wide));
      const open = clamp(s.open, 0, 1.2) * blink;
      // Squash and stretch: the eye widens a touch as it closes.
      const ex = ExpressiveFace.EYE_X[e] + g[0]! * GAZE_PX.x;
      const ey = ExpressiveFace.EYE_Y + g[1]! * GAZE_PX.y + s.dy * r;
      const squash = 1 + 0.08 * (1 - open);
      // Hearts beat (two quick pulses about once a second).
      const phase = ((this.#lastMs ?? 0) / 1000) % 0.9;
      const beat = 1 + clamp(s.heart, 0, 1) * 0.07 * (Math.exp(-(((phase - 0.1) / 0.05) ** 2)) + 0.6 * Math.exp(-(((phase - 0.3) / 0.05) ** 2)));
      drawEye(ctx, ex, ey, rx * squash * beat, fullRy * beat, open, s, e === 0 ? 1 : -1);
    }
    if (this.#glasses) ctx.drawImage(this.#glasses, 0, 0, FACE_WIDTH, FACE_HEIGHT);
    const alpha = this.#mediaAlpha(this.#lastMs ?? 0);
    if (alpha > 0 && this.#media) {
      const { source, width, height } = this.#media.media;
      const scale = Math.min(FACE_WIDTH / width, FACE_HEIGHT / height);
      const w = width * scale;
      const h = height * scale;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, FACE_WIDTH, FACE_HEIGHT);
      ctx.drawImage(source, (FACE_WIDTH - w) / 2, (FACE_HEIGHT - h) / 2, w, h);
      ctx.restore();
    }
  }

  /** Media opacity: fades in, holds, fades out; 0 when nothing is showing. */
  #mediaAlpha(nowMs: number): number {
    const m = this.#media;
    if (!m) return 0;
    if (nowMs < m.startMs) return 0;
    if (nowMs >= m.endMs + MEDIA_FADE_OUT_MS) return 0;
    const fadeIn = Math.min(1, (nowMs - m.startMs) / MEDIA_FADE_IN_MS);
    const fadeOut = nowMs <= m.endMs ? 1 : 1 - (nowMs - m.endMs) / MEDIA_FADE_OUT_MS;
    return Math.max(0, Math.min(fadeIn, fadeOut));
  }

  /** Eye openness from the blink: quick close, a brief shut, a slower open. */
  #blinkOpen(nowMs: number): number {
    if (this.#blinkStartMs === null) return 1;
    const t = nowMs - this.#blinkStartMs;
    if (t < BLINK.closeMs) return 1 - easeIn(t / BLINK.closeMs);
    if (t < BLINK.closeMs + BLINK.shutMs) return 0;
    return Math.min(1, easeOut((t - BLINK.closeMs - BLINK.shutMs) / BLINK.openMs));
  }

  #shapeVector(): number[] {
    const look = LOOKS[this.#emotion];
    const k = this.#intensity;
    const out: number[] = [];
    for (const eye of [look.left, look.right]) for (const key of SHAPE_KEYS) out.push(EYE[key] + (eye[key] - EYE[key]) * k);
    return out;
  }
}

function shapeAt(values: readonly number[], eye: 0 | 1): EyeShape {
  const o = eye * SHAPE_KEYS.length;
  return Object.fromEntries(SHAPE_KEYS.map((key, i) => [key, values[o + i]!])) as unknown as EyeShape;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeIn = (u: number) => u * u;
const easeOut = (u: number) => 1 - (1 - u) * (1 - u);

/**
 * Draws one eye: a black ellipse (or heart) with catch-lights, then carves the lids out of it in white (the face
 * is white, so a lid is simply white drawn over the eye). `inward` is +1 if the inner corner is toward +x.
 */
function drawEye(
  ctx: CanvasRenderingContext2D,
  ex: number,
  ey: number,
  rx: number,
  fullRy: number,
  open: number,
  s: EyeShape,
  inward: 1 | -1,
): void {
  const ry = fullRy * open;
  if (ry < 0.6) {
    // Shut: a soft line (or, for a smiling shut eye, an upturned arc: the ^ of a wink).
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(8, rx * 0.16);
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (s.smile > 0.2) ctx.arc(ex, ey + rx * 0.55, rx * 0.75, Math.PI * 1.2, Math.PI * 1.8);
    else {
      ctx.moveTo(ex - rx * 0.8, ey);
      ctx.lineTo(ex + rx * 0.8, ey);
    }
    ctx.stroke();
    return;
  }
  ctx.fillStyle = '#000000';
  const heart = clamp(s.heart, 0, 1);
  if (heart < 1) {
    ctx.beginPath();
    ctx.ellipse(ex, ey, rx * (1 - heart), ry * (1 - heart), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (heart > 0) drawHeart(ctx, ex, ey, rx * 1.15 * heart, ry * 1.15 * heart);
  // Lids: the top lid covers everything above its edge (lowered by `lid`, slanted, sagging a little in the middle
  // the way a real lid wraps over the eyeball); a smiling lower lid is a wide arc pushing up from below.
  const lid = clamp(s.lid, 0, 1);
  const y0 = ey - ry + lid * 2 * ry;
  const slope = Math.tan(clamp(s.slant, -1, 1)) * inward;
  const w = rx * 1.15;
  const sag = ry * 0.32 * Math.min(1, lid * 4);
  /** The top lid's edge at x (a quadratic from ex − w to ex + w). */
  const lidEdge = (x: number) => {
    const u = (x - (ex - w)) / (2 * w);
    const a = y0 - slope * w - sag * 0.35;
    const b = y0 + sag;
    const c = y0 + slope * w - sag * 0.35;
    return (1 - u) ** 2 * a + 2 * u * (1 - u) * b + u ** 2 * c;
  };
  const smile = clamp(s.smile, 0, 0.95);
  const reach = rx * 1.3;
  const smileTop = ey + ry - smile * 2 * ry;
  /** The smiling lower lid's edge at x. */
  const smileEdge = (x: number) => smileTop + reach - Math.sqrt(Math.max(0, reach * reach - (x - ex) ** 2));

  // Catch-lights, what makes an eye look wet and alive, kept inside the part of the eye the lids leave visible.
  if (heart < 0.5) {
    ctx.fillStyle = '#ffffff';
    const k = (1 - heart * 2) * clamp(s.shine, 0.3, 2);
    const lights = [
      { dx: -0.34, dy: -0.38, r: 0.17 },
      { dx: 0.22, dy: 0.3, r: 0.07 },
    ];
    ctx.beginPath();
    for (const light of lights) {
      const x = ex + rx * light.dx;
      const r = Math.min(rx, ry) * light.r * k;
      let y = ey + ry * light.dy;
      if (lid > 0.005) y = Math.max(y, lidEdge(x) + r * 1.6);
      if (smile > 0) y = Math.min(y, smileEdge(x) - r * 1.6);
      const inside = ((x - ex) / rx) ** 2 + ((y - ey) / ry) ** 2 < 0.8;
      if (r > 0.5 && inside && (lid <= 0.005 || y - r > lidEdge(x)) && (smile <= 0 || y + r < smileEdge(x))) {
        ctx.moveTo(x + r, y);
        ctx.ellipse(x, y, r, r, 0, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
  ctx.fillStyle = '#ffffff';
  if (lid > 0.005) {
    ctx.beginPath();
    ctx.moveTo(ex - w, lidEdge(ex - w));
    ctx.quadraticCurveTo(ex, y0 + sag, ex + w, lidEdge(ex + w));
    ctx.lineTo(ex + w, ey - fullRyFor(ry, open) * 3);
    ctx.lineTo(ex - w, ey - fullRyFor(ry, open) * 3);
    ctx.closePath();
    ctx.fill();
  }
  if (smile > 0) {
    ctx.beginPath();
    ctx.ellipse(ex, smileTop + reach, reach, reach, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The eye's full height, from its height after blinking (keeps the lid cover tall enough mid-blink). */
const fullRyFor = (ry: number, open: number) => (open > 0.05 ? ry / open : ry * 20);

function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y + h * 0.95);
  ctx.bezierCurveTo(x - w * 1.25, y + h * 0.15, x - w * 0.95, y - h * 1.05, x, y - h * 0.4);
  ctx.bezierCurveTo(x + w * 0.95, y - h * 1.05, x + w * 1.25, y + h * 0.15, x, y + h * 0.95);
  ctx.closePath();
  ctx.fill();
}
