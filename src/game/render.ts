import { CONFIG } from './config';
import { playerHeight } from './logic';
import type { Coin, GameState, Obstacle } from './types';

const CENTER_LANE = (CONFIG.laneCount - 1) / 2;
/** Camera sits this far behind the runner. */
const CAM_BACK = 6.2;
const CAM_HEIGHT = 2.55;
const ROAD_HALF = CONFIG.laneCount * CONFIG.laneWidth * 0.5 + 0.35;
const FAR_Z = CONFIG.spawnDistance + 12;
/** Near clip plane: just in front of the camera, so the road fills the bottom edge. */
const NEAR_Z = -CAM_BACK + 1.1;
const ROAD_HALF_LANES = ROAD_HALF / CONFIG.laneWidth;

const PALETTE = {
  skyTop: '#05010f',
  skyBottom: '#2a0b4a',
  sun: '#ff2e88',
  road: '#0b0718',
  roadEdge: '#25e5ff',
  lane: '#4a2f7a',
  stripe: '#ff2e88',
  wall: '#ff2e88',
  hurdle: '#ffd447',
  beam: '#25e5ff',
  tram: '#8b5cf6',
  coin: '#ffd447',
  player: '#7dfcd0',
};

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
  private focal = 0;
  private horizon = 0;
  private cx = 0;
  private readonly skyline: number[] = [];
  particles: Particle[] = [];
  shake = 0;

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
    // Narrow (portrait) viewports need a longer focal length to keep lanes readable.
    const aspect = cssWidth / cssHeight;
    this.focal = cssHeight * (aspect < 0.8 ? 1.35 : 1.0);
    this.horizon = cssHeight * 0.4;
  }

  private project(laneX: number, y: number, z: number): Point | null {
    const d = z + CAM_BACK;
    if (d <= 0.35) return null;
    const scale = this.focal / d;
    return {
      x: this.cx + (laneX - CENTER_LANE) * CONFIG.laneWidth * scale,
      y: this.horizon + (CAM_HEIGHT - y) * scale,
    };
  }

  private scaleAt(z: number): number {
    return this.focal / Math.max(0.35, z + CAM_BACK);
  }

  burst(count: number, x: number, y: number, color: string, power = 220): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = power * (0.25 + Math.random() * 0.75);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 60,
        life: 0.35 + Math.random() * 0.45,
        color,
      });
    }
  }

  updateEffects(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 2.2);
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 620 * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
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
      const m = this.shake * 14;
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
    drawables.sort((a, b) => b.z - a.z);
    for (const d of drawables) d.paint();

    if (state.phase !== 'over') this.drawPlayer(state);
    this.drawParticles();
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
    sg.addColorStop(0, 'rgba(255,46,136,0.85)');
    sg.addColorStop(1, 'rgba(255,46,136,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(this.cx - sunR, this.horizon - sunR, sunR * 2, sunR * 2);

    // Parallax skyline.
    const offset = (state.distance * 3.5) % 40;
    ctx.fillStyle = 'rgba(10,4,28,0.92)';
    const bw = this.w / 22;
    for (let i = -1; i < 24; i++) {
      const seed = this.skyline[(i + 40) % this.skyline.length]!;
      const bh = this.h * (0.05 + seed * 0.14);
      const x = i * bw - offset;
      ctx.fillRect(x, this.horizon - bh, bw * 0.86, bh);
    }
    ctx.fillStyle = 'rgba(37,229,255,0.55)';
    ctx.fillRect(0, this.horizon - 1.5, this.w, 1.5);
  }

  private drawRoad(state: GameState): void {
    const ctx = this.ctx;
    const nearL = this.project(CENTER_LANE - ROAD_HALF_LANES, 0, NEAR_Z);
    const nearR = this.project(CENTER_LANE + ROAD_HALF_LANES, 0, NEAR_Z);
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
      if (z < NEAR_Z) continue;
      const a = this.project(0, 0, z);
      const b = this.project(0, 0, z + 0.9);
      if (!a || !b) continue;
      const wA = ROAD_HALF * this.scaleAt(z);
      const wB = ROAD_HALF * this.scaleAt(z + 0.9);
      ctx.fillStyle = `rgba(255,46,136,${Math.max(0, 0.22 - i * 0.012)})`;
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
      const a = this.project(laneX, 0, NEAR_Z);
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
      const a = this.project(CENTER_LANE + side * ROAD_HALF_LANES, 0, NEAR_Z);
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
      if (z < NEAR_Z) continue;
      for (const side of [-1, 1]) {
        const laneX = CENTER_LANE + (side * (ROAD_HALF + 0.5)) / CONFIG.laneWidth;
        const base = this.project(laneX, 0, z);
        const top = this.project(laneX, 3.2, z);
        if (!base || !top) continue;
        const alpha = Math.max(0, 0.7 - i * 0.05);
        ctx.strokeStyle = `rgba(139,92,246,${alpha})`;
        ctx.lineWidth = Math.max(1, 5 * this.scaleAt(z) * 0.02);
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(top.x, top.y);
        ctx.stroke();
        ctx.fillStyle = `rgba(37,229,255,${alpha})`;
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
    const hw = 0.4;
    const zf = o.z + o.depth;
    if (zf <= NEAR_Z) return;
    const zn = Math.max(o.z, NEAR_Z);

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

    // Hazard chevrons on the near face give a quick read of the required action.
    const a = p(-hw * 0.7, o.yMin + (o.yMax - o.yMin) * 0.5, zn);
    const b = p(hw * 0.7, o.yMin + (o.yMax - o.yMin) * 0.5, zn);
    if (a && b && Math.abs(b.x - a.x) > 10) {
      const ctx = this.ctx;
      ctx.strokeStyle = edge;
      ctx.lineWidth = Math.max(1, (b.x - a.x) * 0.08);
      ctx.beginPath();
      if (o.kind === 'hurdle') {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo((a.x + b.x) / 2, a.y - (b.x - a.x) * 0.35);
        ctx.lineTo(b.x, a.y);
      } else if (o.kind === 'beam') {
        ctx.moveTo(a.x, a.y - (b.x - a.x) * 0.2);
        ctx.lineTo((a.x + b.x) / 2, a.y + (b.x - a.x) * 0.18);
        ctx.lineTo(b.x, a.y - (b.x - a.x) * 0.2);
      } else {
        ctx.moveTo(a.x, a.y - (b.x - a.x) * 0.2);
        ctx.lineTo(b.x, a.y + (b.x - a.x) * 0.2);
        ctx.moveTo(b.x, a.y - (b.x - a.x) * 0.2);
        ctx.lineTo(a.x, a.y + (b.x - a.x) * 0.2);
      }
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
    ctx.strokeStyle = 'rgba(125,252,208,0.28)';
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
    ctx.fillStyle = '#05010f';
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
