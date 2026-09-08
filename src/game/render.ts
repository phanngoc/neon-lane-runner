import { CONFIG } from './config';
import { playerHeight } from './logic';
import type { Coin, GameState, Obstacle } from './types';

const CENTER_LANE = (CONFIG.laneCount - 1) / 2;
/** Camera distance behind the runner. Portrait pulls back so the tall, narrow
 *  viewport does not fill up with the runner itself. */
const CAM_BACK_WIDE = 6.2;
const CAM_BACK_TALL = 9.2;
/** Eye height. Portrait sits higher so the runner stops covering low hazards
 *  in its own lane — see `hazardVisibilityZ` for the exact relationship. */
const CAM_HEIGHT_WIDE = 2.55;
const CAM_HEIGHT_TALL = 3.9;
const ROAD_HALF = CONFIG.laneCount * CONFIG.laneWidth * 0.5 + 0.35;
const FAR_Z = CONFIG.spawnDistance + 12;
/** Gap kept between the camera and the near clip plane. */
const NEAR_GAP = 1.1;
const ROAD_HALF_LANES = ROAD_HALF / CONFIG.laneWidth;
/** Aspect ratio at or below which the portrait camera is used. */
export const PORTRAIT_ASPECT = 0.8;

/**
 * Nearest depth at which a ground-standing hazard in the runner's own lane is
 * fully clear of the runner's silhouette.
 *
 * The runner is drawn at z = 0, so its head lands at screen
 * `horizon + (camHeight - playerHeight) * focal / camBack`, while the foot of a
 * hazard at depth z lands at `horizon + camHeight * focal / (z + camBack)`.
 * Requiring the hazard's foot to sit *above* the runner's head cancels both
 * `focal` and `horizon`, leaving a pure camera relationship:
 *
 *     z > playerHeight * camBack / (camHeight - playerHeight)
 *
 * Keeping this below `CONFIG.rowGapMin` is what guarantees the *next* hazard
 * row is never hidden behind the runner, whatever the viewport size.
 */
export function hazardVisibilityZ(camBack: number, camHeight: number): number {
  return (CONFIG.playerHeight * camBack) / (camHeight - CONFIG.playerHeight);
}

/** The camera the renderer will pick for a viewport, without needing a canvas. */
export function cameraFor(cssWidth: number, cssHeight: number): {
  portrait: boolean;
  camBack: number;
  camHeight: number;
} {
  const portrait = cssWidth / cssHeight < PORTRAIT_ASPECT;
  return {
    portrait,
    camBack: portrait ? CAM_BACK_TALL : CAM_BACK_WIDE,
    camHeight: portrait ? CAM_HEIGHT_TALL : CAM_HEIGHT_WIDE,
  };
}

/**
 * "Electric Rain" palette from the batch visual direction. The important rule
 * is that the killing red is reserved: before this, `wall`, the road stripes
 * and the decorative sun were all literally `#ff2e88`, so one hue meant both
 * "this ends your run" and "this is scenery". Decor is now cool, hazards warm.
 */
const PALETTE = {
  skyTop: '#060A1A',
  skyBottom: '#101A33',
  /** Decorative sun: cool, so it cannot be confused with a hazard. */
  sun: '#4B3D8F',
  road: '#1D2A4A',
  roadEdge: '#38BDF8',
  lane: '#2C3D66',
  /** Road stripes: cool blue, released the red hue for hazards. */
  stripe: '#38BDF8',
  wall: '#FF4D3D',
  hurdle: '#FFC94D',
  beam: '#38BDF8',
  tram: '#8A5CF6',
  coin: '#FFC94D',
  player: '#EAF4FF',
  /** Rail / skyline furniture: cool violet, clearly not a hazard. */
  decor: '#4B3D8F',
  /** Outline shared by every hazard so shape reads even at low contrast. */
  hazardEdge: '#FFFFFF',
};

/** Effect budget. Hard ceilings, not guidance: the pool never grows. */
export const EFFECTS = {
  /** Maximum simultaneous live particles. */
  maxParticles: 64,
  /** Maximum particles emitted by one burst. */
  maxPerBurst: 12,
  /** Longest particle lifetime, seconds. */
  maxLife: 0.45,
  /** Peak screen shake, CSS px. */
  maxShakePx: 3,
  /** Shake duration, seconds. */
  shakeSeconds: 0.18,
} as const;

export type EffectLevel = 'full' | 'reduced' | 'minimal';

interface Point {
  x: number;
  y: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export class Renderer {
  private w = 0;
  private h = 0;
  private dpr = 1;
  private camBack = CAM_BACK_WIDE;
  private camHeight = CAM_HEIGHT_WIDE;
  /** Near clip plane, just in front of the camera. */
  private nearZ = -CAM_BACK_WIDE + NEAR_GAP;
  private focal = 0;
  private horizon = 0;
  private cx = 0;
  private readonly skyline: number[] = [];
  /** Fixed-size pool. Dead particles are recycled, so a frame allocates none. */
  readonly particles: Particle[] = [];
  private nextParticle = 0;
  shake = 0;
  effects: EffectLevel = 'full';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
  ) {
    // Deterministic skyline silhouette so the backdrop is stable across frames.
    let s = 7;
    for (let i = 0; i < 96; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      this.skyline.push((s % 1000) / 1000);
    }
    for (let i = 0; i < EFFECTS.maxParticles; i++) {
      this.particles.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, color: '' });
    }
  }

  /** Live particles. Only used by tests and the perf probe. */
  liveParticles(): number {
    let n = 0;
    for (const p of this.particles) if (p.life > 0) n += 1;
    return n;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dpr = dpr;
    this.w = cssWidth;
    this.h = cssHeight;
    this.cx = cssWidth / 2;
    // Portrait viewports pull the camera back and shorten the focal length, so
    // the three lanes stay readable without the runner swallowing the screen.
    const cam = cameraFor(cssWidth, cssHeight);
    this.camBack = cam.camBack;
    this.camHeight = cam.camHeight;
    this.nearZ = -this.camBack + NEAR_GAP;
    this.focal = cssHeight * (cam.portrait ? 0.95 : 1.0);
    this.horizon = cssHeight * (cam.portrait ? 0.3 : 0.4);
  }

  private project(laneX: number, y: number, z: number): Point | null {
    const d = z + this.camBack;
    if (d <= 0.35) return null;
    const scale = this.focal / d;
    return {
      x: this.cx + (laneX - CENTER_LANE) * CONFIG.laneWidth * scale,
      y: this.horizon + (this.camHeight - y) * scale,
    };
  }

  private scaleAt(z: number): number {
    return this.focal / Math.max(0.35, z + this.camBack);
  }

  burst(count: number, x: number, y: number, color: string, power = 220): void {
    if (this.effects === 'minimal') return;
    const budget = this.effects === 'reduced' ? EFFECTS.maxPerBurst / 2 : EFFECTS.maxPerBurst;
    const n = Math.min(count, Math.floor(budget));
    for (let i = 0; i < n; i++) {
      // Round-robin over the pool: the oldest particle is overwritten rather
      // than a new object allocated, so bursts cannot grow the heap.
      const p = this.particles[this.nextParticle]!;
      this.nextParticle = (this.nextParticle + 1) % this.particles.length;
      const a = Math.random() * Math.PI * 2;
      const s = power * (0.25 + Math.random() * 0.75);
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s - 60;
      p.life = EFFECTS.maxLife * (0.6 + Math.random() * 0.4);
      p.color = color;
    }
  }

  /** Trigger the death shake. Bounded in both amplitude and duration. */
  kick(): void {
    this.shake = this.effects === 'full' ? 1 : 0;
  }

  updateEffects(dt: number): void {
    this.shake = Math.max(0, this.shake - dt / EFFECTS.shakeSeconds);
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 620 * dt;
    }
  }

  /** World position of a lane/height pair, in screen pixels (for particles). */
  screenOf(laneX: number, y: number, z: number): Point {
    return this.project(laneX, y, z) ?? { x: this.cx, y: this.h * 0.7 };
  }

  draw(state: GameState): void {
    const ctx = this.ctx;
    // Every frame starts from a clean surface: the scene is fully repainted and
    // several passes use translucent fills, which would otherwise accumulate.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = PALETTE.skyTop;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.save();
    if (this.shake > 0) {
      const m = this.shake * EFFECTS.maxShakePx;
      ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    }
    this.drawSky(state);
    this.drawRoad(state);
    this.drawRails(state);

    const drawables: Array<{ z: number; paint: () => void }> = [];
    for (const o of state.obstacles) {
      drawables.push({ z: o.z + o.depth, paint: () => this.drawObstacle(o) });
    }
    for (const c of state.coins) {
      if (!c.collected) drawables.push({ z: c.z, paint: () => this.drawCoin(c, state) });
    }
    // Particles are painted before the hazards on purpose: an explosion may
    // decorate the scene but must never hide the thing that can kill you.
    this.drawParticles();
    drawables.sort((a, b) => b.z - a.z);
    for (const d of drawables) d.paint();

    if (state.phase !== 'over') this.drawPlayer(state);
    ctx.restore();
  }

  private drawSky(state: GameState): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, this.horizon + 8);
    g.addColorStop(0, PALETTE.skyTop);
    g.addColorStop(1, PALETTE.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(-40, -40, this.w + 80, this.horizon + 48);

    // Neon sun.
    const sunR = this.h * 0.14;
    const sg = ctx.createRadialGradient(
      this.cx,
      this.horizon,
      0,
      this.cx,
      this.horizon,
      sunR,
    );
    sg.addColorStop(0, hexToRgba(PALETTE.sun, 0.85));
    sg.addColorStop(1, hexToRgba(PALETTE.sun, 0));
    ctx.fillStyle = sg;
    ctx.fillRect(this.cx - sunR, this.horizon - sunR, sunR * 2, sunR * 2);

    // Parallax skyline.
    const offset = (state.distance * 3.5) % 40;
    ctx.fillStyle = hexToRgba(PALETTE.skyBottom, 0.94);
    const bw = this.w / 22;
    for (let i = -1; i < 24; i++) {
      const seed = this.skyline[(i + 40) % this.skyline.length]!;
      const bh = this.h * (0.05 + seed * 0.14);
      const x = i * bw - offset;
      ctx.fillRect(x, this.horizon - bh, bw * 0.86, bh);
    }
    ctx.fillStyle = hexToRgba(PALETTE.roadEdge, 0.55);
    ctx.fillRect(0, this.horizon - 1.5, this.w, 1.5);
  }

  private drawRoad(state: GameState): void {
    const ctx = this.ctx;
    const nearL = this.project(CENTER_LANE - ROAD_HALF_LANES, 0, this.nearZ);
    const nearR = this.project(CENTER_LANE + ROAD_HALF_LANES, 0, this.nearZ);
    const farL = this.project(CENTER_LANE - ROAD_HALF_LANES, 0, FAR_Z);
    const farR = this.project(CENTER_LANE + ROAD_HALF_LANES, 0, FAR_Z);
    if (!nearL || !nearR || !farL || !farR) return;

    ctx.fillStyle = PALETTE.road;
    ctx.beginPath();
    ctx.moveTo(nearL.x, Math.max(nearL.y, this.h));
    ctx.lineTo(nearR.x, Math.max(nearR.y, this.h));
    ctx.lineTo(farR.x, farR.y);
    ctx.lineTo(farL.x, farL.y);
    ctx.closePath();
    ctx.fill();

    // Transverse stripes scrolling towards the camera.
    const spacing = 6;
    const phase = state.distance % spacing;
    for (let i = 0; i < 18; i++) {
      const z = i * spacing - phase;
      if (z < this.nearZ) continue;
      const a = this.project(0, 0, z);
      const b = this.project(0, 0, z + 0.9);
      if (!a || !b) continue;
      const wA = ROAD_HALF * this.scaleAt(z);
      const wB = ROAD_HALF * this.scaleAt(z + 0.9);
      ctx.fillStyle = hexToRgba(PALETTE.stripe, Math.max(0, 0.16 - i * 0.009));
      ctx.beginPath();
      ctx.moveTo(this.cx - wA, a.y);
      ctx.lineTo(this.cx + wA, a.y);
      ctx.lineTo(this.cx + wB, b.y);
      ctx.lineTo(this.cx - wB, b.y);
      ctx.closePath();
      ctx.fill();
    }

    // Lane dividers.
    ctx.strokeStyle = PALETTE.lane;
    ctx.lineWidth = 2;
    for (let l = 0; l < CONFIG.laneCount - 1; l++) {
      const laneX = l + 0.5;
      const a = this.project(laneX, 0, this.nearZ);
      const b = this.project(laneX, 0, FAR_Z);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Glowing road edges.
    ctx.strokeStyle = PALETTE.roadEdge;
    ctx.lineWidth = 3;
    ctx.shadowColor = PALETTE.roadEdge;
    ctx.shadowBlur = 16;
    for (const side of [-1, 1]) {
      const a = this.project(CENTER_LANE + side * ROAD_HALF_LANES, 0, this.nearZ);
      const b = this.project(CENTER_LANE + side * ROAD_HALF_LANES, 0, FAR_Z);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  private drawRails(state: GameState): void {
    const ctx = this.ctx;
    const spacing = 8;
    const phase = state.distance % spacing;
    for (let i = 12; i >= 0; i--) {
      const z = i * spacing - phase;
      if (z < this.nearZ) continue;
      for (const side of [-1, 1]) {
        const laneX = CENTER_LANE + (side * (ROAD_HALF + 0.5)) / CONFIG.laneWidth;
        const base = this.project(laneX, 0, z);
        const top = this.project(laneX, 3.2, z);
        if (!base || !top) continue;
        const alpha = Math.max(0, 0.7 - i * 0.05);
        ctx.strokeStyle = hexToRgba(PALETTE.decor, alpha);
        ctx.lineWidth = Math.max(1, 5 * this.scaleAt(z) * 0.02);
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(top.x, top.y);
        ctx.stroke();
        ctx.fillStyle = hexToRgba(PALETTE.roadEdge, alpha * 0.8);
        const r = Math.max(1, 6 * this.scaleAt(z) * 0.02);
        ctx.beginPath();
        ctx.arc(top.x, top.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private quad(pts: Array<Point | null>, fill: string, stroke?: string): void {
    if (pts.some((p) => p === null)) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private drawObstacle(o: Obstacle): void {
    const color =
      o.kind === 'wall'
        ? PALETTE.wall
        : o.kind === 'hurdle'
          ? PALETTE.hurdle
          : o.kind === 'beam'
            ? PALETTE.beam
            : PALETTE.tram;
    // Silhouette differs by kind, not just colour: a wall is a narrow full
    // slab, a tram is narrower still but very long, a hurdle is low and wide,
    // a beam is wide and hangs from above.
    const hw =
      o.kind === 'tram' ? 0.34 : o.kind === 'hurdle' ? 0.43 : o.kind === 'beam' ? 0.45 : 0.4;
    const zf = o.z + o.depth;
    if (zf <= this.nearZ) return;
    const zn = Math.max(o.z, this.nearZ);

    const p = (dx: number, y: number, z: number) =>
      this.project(o.lane + dx, y, z);

    const fade = Math.max(0.15, Math.min(1, 1 - zn / (FAR_Z * 0.9)));
    const body = hexToRgba(color, 0.2 + 0.18 * fade);
    const top = hexToRgba(color, 0.4 + 0.25 * fade);
    const face = hexToRgba(color, 0.55 + 0.3 * fade);
    const edge = hexToRgba(color, 0.95 * fade);

    // Far face, then sides, then top, then near face (painter's order).
    this.quad([p(-hw, o.yMin, zf), p(hw, o.yMin, zf), p(hw, o.yMax, zf), p(-hw, o.yMax, zf)], body);
    this.quad([p(-hw, o.yMin, zn), p(-hw, o.yMin, zf), p(-hw, o.yMax, zf), p(-hw, o.yMax, zn)], body);
    this.quad([p(hw, o.yMin, zn), p(hw, o.yMin, zf), p(hw, o.yMax, zf), p(hw, o.yMax, zn)], body);
    this.quad([p(-hw, o.yMax, zn), p(hw, o.yMax, zn), p(hw, o.yMax, zf), p(-hw, o.yMax, zf)], top);
    this.quad(
      [p(-hw, o.yMin, zn), p(hw, o.yMin, zn), p(hw, o.yMax, zn), p(-hw, o.yMax, zn)],
      face,
      edge,
    );

    // A white outline on the near face carries the shape even when the fill
    // fades with distance, so silhouette never depends on colour alone.
    const nf = [p(-hw, o.yMin, zn), p(hw, o.yMin, zn), p(hw, o.yMax, zn), p(-hw, o.yMax, zn)];
    if (!nf.some((q) => q === null)) {
      const ctx = this.ctx;
      const wpx = Math.abs(nf[1]!.x - nf[0]!.x);
      if (wpx > 8) {
        ctx.strokeStyle = `rgba(255,255,255,${0.75 * fade})`;
        ctx.lineWidth = Math.max(1, Math.min(3, wpx * 0.035));
        ctx.beginPath();
        ctx.moveTo(nf[0]!.x, nf[0]!.y);
        for (let i = 1; i < 4; i++) ctx.lineTo(nf[i]!.x, nf[i]!.y);
        ctx.closePath();
        ctx.stroke();
        this.drawMarkings(o, p, hw, zn, zf, edge, wpx, fade);
      }
    }
  }

  /**
   * Kind-specific markings on the near face. Each one states the required
   * answer: slashes = go around, rail = jump, hangers = duck, window band and
   * 45-degree stripes = a long blocker you must leave early.
   */
  private drawMarkings(
    o: Obstacle,
    p: (dx: number, y: number, z: number) => Point | null,
    hw: number,
    zn: number,
    zf: number,
    edge: string,
    wpx: number,
    fade: number,
  ): void {
    const ctx = this.ctx;
    const mid = o.yMin + (o.yMax - o.yMin) * 0.5;
    ctx.strokeStyle = edge;
    ctx.lineWidth = Math.max(1, wpx * 0.06);

    if (o.kind === 'wall') {
      // Three diagonal slashes across the slab.
      for (let i = 0; i < 3; i++) {
        const t = 0.25 + i * 0.25;
        const a = p(-hw * 0.8, o.yMin + (o.yMax - o.yMin) * (t - 0.16), zn);
        const b = p(hw * 0.8, o.yMin + (o.yMax - o.yMin) * (t + 0.16), zn);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      return;
    }

    if (o.kind === 'hurdle') {
      // A rail floating just above the box, on two posts: jump it.
      const railY = o.yMax + 0.22;
      const l = p(-hw, railY, zn);
      const r = p(hw, railY, zn);
      const lb = p(-hw * 0.85, o.yMax, zn);
      const rb = p(hw * 0.85, o.yMax, zn);
      if (l && r && lb && rb) {
        ctx.beginPath();
        ctx.moveTo(l.x, l.y);
        ctx.lineTo(r.x, r.y);
        ctx.moveTo(lb.x, lb.y);
        ctx.lineTo(l.x + wpx * 0.08, l.y);
        ctx.moveTo(rb.x, rb.y);
        ctx.lineTo(r.x - wpx * 0.08, r.y);
        ctx.stroke();
      }
      // Up chevron.
      const a = p(-hw * 0.6, mid, zn);
      const b = p(hw * 0.6, mid, zn);
      if (a && b) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo((a.x + b.x) / 2, a.y - wpx * 0.3);
        ctx.lineTo(b.x, a.y);
        ctx.stroke();
      }
      return;
    }

    if (o.kind === 'beam') {
      // Two hangers reaching up out of frame: it is suspended, so duck.
      for (const sx of [-0.62, 0.62]) {
        const base = p(hw * sx, o.yMax, zn);
        const top = p(hw * sx, o.yMax + 1.4, zn);
        if (!base || !top) continue;
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(top.x, top.y);
        ctx.stroke();
      }
      // Down chevron on the underside.
      const a = p(-hw * 0.6, o.yMin + 0.28, zn);
      const b = p(hw * 0.6, o.yMin + 0.28, zn);
      if (a && b) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo((a.x + b.x) / 2, a.y + wpx * 0.3);
        ctx.lineTo(b.x, a.y);
        ctx.stroke();
      }
      return;
    }

    // Tram: a lit window band plus 45-degree warning stripes below it. The
    // band also runs down the visible side so the length reads at a glance.
    const bandLo = o.yMin + (o.yMax - o.yMin) * 0.55;
    const bandHi = o.yMin + (o.yMax - o.yMin) * 0.78;
    this.quad(
      [p(-hw * 0.82, bandLo, zn), p(hw * 0.82, bandLo, zn), p(hw * 0.82, bandHi, zn), p(-hw * 0.82, bandHi, zn)],
      `rgba(226,232,255,${0.5 + 0.35 * fade})`,
    );
    const sideZ = Math.min(zf, zn + 9);
    this.quad(
      [p(hw, bandLo, zn), p(hw, bandLo, sideZ), p(hw, bandHi, sideZ), p(hw, bandHi, zn)],
      `rgba(226,232,255,${0.18 + 0.16 * fade})`,
    );
    ctx.lineWidth = Math.max(1, wpx * 0.09);
    for (let i = 0; i < 3; i++) {
      const t = 0.1 + i * 0.14;
      const a = p(-hw * 0.8 + i * hw * 0.5, o.yMin + (o.yMax - o.yMin) * t, zn);
      const b = p(-hw * 0.3 + i * hw * 0.5, o.yMin + (o.yMax - o.yMin) * (t + 0.14), zn);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  private drawCoin(c: Coin, state: GameState): void {
    const pos = this.project(c.lane, c.y, c.z);
    if (!pos) return;
    const s = this.scaleAt(c.z);
    const r = Math.max(1, 0.28 * s);
    const spin = Math.abs(Math.cos(state.elapsed * 6 + c.id));
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = PALETTE.coin;
    ctx.shadowBlur = Math.min(24, r * 1.6);
    ctx.fillStyle = PALETTE.coin;
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y, Math.max(0.6, r * (0.25 + spin * 0.75)), r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawPlayer(state: GameState): void {
    const p = state.player;
    const ctx = this.ctx;
    const h = playerHeight(p);
    const bob = p.grounded && !p.sliding ? Math.sin(state.distance * 3.2) * 0.06 : 0;
    const base = this.project(p.x, p.y, 0);
    const head = this.project(p.x, p.y + h + bob, 0);
    if (!base || !head) return;
    const s = this.scaleAt(0);
    const bodyW = CONFIG.playerHalfWidth * 2 * s * (p.sliding ? 1.35 : 1);

    // Ground shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    const groundY = this.project(p.x, 0, 0)!.y;
    ctx.beginPath();
    ctx.ellipse(base.x, groundY, bodyW * 0.55, bodyW * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    // Speed trail.
    ctx.strokeStyle = hexToRgba(PALETTE.player, 0.22);
    ctx.lineWidth = bodyW * 0.5;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(base.x, head.y + (base.y - head.y) * 0.25);
    ctx.stroke();

    ctx.save();
    ctx.shadowColor = PALETTE.player;
    ctx.shadowBlur = 22;
    ctx.fillStyle = PALETTE.player;
    const topY = head.y;
    const bottomY = base.y;
    const torsoTop = topY + (bottomY - topY) * 0.28;
    roundRect(ctx, base.x - bodyW / 2, torsoTop, bodyW, bottomY - torsoTop, bodyW * 0.28);
    ctx.fill();
    // Head.
    ctx.beginPath();
    ctx.arc(base.x, topY + (bottomY - topY) * 0.14, bodyW * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Visor stripe for a bit of character.
    ctx.fillStyle = PALETTE.skyTop;
    ctx.fillRect(
      base.x - bodyW * 0.22,
      topY + (bottomY - topY) * 0.11,
      bodyW * 0.44,
      Math.max(1, bodyW * 0.08),
    );
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export { PALETTE };
