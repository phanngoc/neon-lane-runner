import { describe, expect, it } from 'vitest';
import { CONFIG, STEP } from '../src/game/config';
import {
  advance,
  createState,
  currentScore,
  hits,
  playerHeight,
  queueAction,
  reaches,
  resetRun,
  spawnRow,
  stepOnce,
} from '../src/game/logic';
import type { Coin, GameState, Obstacle, ObstacleKind } from '../src/game/types';

function running(seed = 42): GameState {
  const s = createState(0, seed);
  s.phase = 'running';
  return s;
}

function box(kind: ObstacleKind, lane: number, z = 0): Obstacle {
  const base = { id: 1, kind, lane, z, depth: 1.1, yMin: 0, yMax: 2.6 };
  if (kind === 'hurdle') return { ...base, yMax: 0.75, depth: 0.9 };
  if (kind === 'beam') return { ...base, yMin: 0.95, yMax: 2.9, depth: 0.9 };
  if (kind === 'tram') return { ...base, depth: 14 };
  return base;
}

/** Runs the sim until the player leaves the ground or the budget expires. */
function until(s: GameState, predicate: () => boolean, seconds = 2): boolean {
  for (let t = 0; t < seconds; t += STEP) {
    if (predicate()) return true;
    stepOnce(s, STEP);
  }
  return predicate();
}

describe('collision', () => {
  it('a wall in the current lane is fatal', () => {
    const s = running();
    expect(hits(s.player, box('wall', 1))).toBe(true);
  });

  it('a wall in another lane is harmless', () => {
    const s = running();
    expect(hits(s.player, box('wall', 0))).toBe(false);
    expect(hits(s.player, box('wall', 2))).toBe(false);
  });

  it('an obstacle further down the track is not touching yet', () => {
    const s = running();
    expect(hits(s.player, box('wall', 1, 12))).toBe(false);
  });

  it('jumping clears a hurdle but sliding does not', () => {
    const s = running();
    queueAction(s, 'jump');
    until(s, () => s.player.y > 0.9);
    expect(hits(s.player, box('hurdle', 1))).toBe(false);

    const t = running();
    queueAction(t, 'slide');
    stepOnce(t, STEP);
    expect(t.player.sliding).toBe(true);
    expect(hits(t.player, box('hurdle', 1))).toBe(true);
  });

  it('sliding clears an overhead beam but standing does not', () => {
    const s = running();
    expect(hits(s.player, box('beam', 1))).toBe(true);
    queueAction(s, 'slide');
    stepOnce(s, STEP);
    expect(hits(s.player, box('beam', 1))).toBe(false);
  });

  it('a slide expires after the configured duration', () => {
    const s = running();
    queueAction(s, 'slide');
    until(s, () => !s.player.sliding, CONFIG.slideDuration + 0.5);
    expect(s.player.sliding).toBe(false);
    expect(playerHeight(s.player)).toBe(CONFIG.playerHeight);
  });

  it('ends the run when the runner reaches a wall', () => {
    const s = running();
    s.obstacles = [box('wall', 1, 6)];
    s.nextSpawnZ = 1e6;
    // advance() clamps a single call to 0.25 s, so drive it frame by frame.
    for (let i = 0; i < 120 && s.phase === 'running'; i++) advance(s, 1 / 60);
    expect(s.phase).toBe('over');
    expect(s.events).toContain('crash');
  });
});

describe('lane movement', () => {
  it('changes lane and clamps at the edges', () => {
    const s = running();
    queueAction(s, 'left');
    expect(s.player.targetLane).toBe(0);
    queueAction(s, 'left');
    expect(s.player.targetLane).toBe(0);
    until(s, () => s.player.x === 0);
    expect(s.player.x).toBe(0);

    queueAction(s, 'right');
    queueAction(s, 'right');
    expect(s.player.targetLane).toBe(2);
    queueAction(s, 'right');
    expect(s.player.targetLane).toBe(2);
  });

  it('ignores input unless the run is active', () => {
    const s = createState(0, 1);
    queueAction(s, 'left');
    expect(s.player.targetLane).toBe(1);
  });

  it('cannot double jump', () => {
    const s = running();
    queueAction(s, 'jump');
    stepOnce(s, STEP);
    const vy = s.player.vy;
    queueAction(s, 'jump');
    expect(s.player.vy).toBeLessThanOrEqual(vy);
  });

  it('a jump returns to the ground', () => {
    const s = running();
    queueAction(s, 'jump');
    stepOnce(s, STEP);
    expect(s.player.grounded).toBe(false);
    until(s, () => s.player.grounded, 3);
    expect(s.player.grounded).toBe(true);
    expect(s.player.y).toBe(0);
  });
});

describe('scoring', () => {
  it('awards distance and coins', () => {
    const s = running();
    s.distance = 120.9;
    s.coinsCollected = 3;
    expect(currentScore(s)).toBe(120 + 3 * CONFIG.coinValue);
  });

  it('collects a coin in reach and only counts it once', () => {
    const s = running();
    s.nextSpawnZ = 1e6;
    const coin: Coin = { id: 9, lane: 1, z: 0, y: 0.6, collected: false };
    s.coins = [coin];
    expect(reaches(s.player, coin)).toBe(true);
    stepOnce(s, STEP);
    expect(s.coinsCollected).toBe(1);
    stepOnce(s, STEP);
    expect(s.coinsCollected).toBe(1);
  });

  it('does not collect a coin in a different lane', () => {
    const s = running();
    expect(reaches(s.player, { id: 1, lane: 0, z: 0, y: 0.6, collected: false })).toBe(
      false,
    );
  });

  it('speed ramps up over time and is capped', () => {
    const s = running();
    s.nextSpawnZ = 1e6;
    advance(s, 0.25);
    const early = s.speed;
    expect(early).toBeGreaterThan(CONFIG.startSpeed);
    s.elapsed = 10_000;
    stepOnce(s, STEP);
    expect(s.speed).toBe(CONFIG.maxSpeed);
  });

  it('records a new best score on game over', () => {
    const s = running();
    s.best = 5;
    s.distance = 300;
    s.obstacles = [box('wall', 1, 0)];
    stepOnce(s, STEP);
    expect(s.phase).toBe('over');
    expect(s.best).toBeGreaterThanOrEqual(300);
  });
});

describe('state reset', () => {
  it('resetRun clears the world but keeps the best score', () => {
    const s = running();
    s.best = 777;
    advance(s, 4);
    queueAction(s, 'left');
    expect(s.obstacles.length + s.coins.length).toBeGreaterThan(0);

    resetRun(s, 7);
    expect(s.phase).toBe('running');
    expect(s.best).toBe(777);
    expect(s.distance).toBe(0);
    expect(s.score).toBe(0);
    expect(s.coinsCollected).toBe(0);
    expect(s.speed).toBe(CONFIG.startSpeed);
    expect(s.obstacles).toHaveLength(0);
    expect(s.coins).toHaveLength(0);
    expect(s.player.x).toBe(1);
    expect(s.player.targetLane).toBe(1);
    expect(s.player.y).toBe(0);
    expect(s.player.sliding).toBe(false);
    expect(s.events).toHaveLength(0);
  });

  it('advance() clamps a huge frame delta so a background tab cannot teleport', () => {
    const s = running();
    s.nextSpawnZ = 1e6;
    advance(s, 60);
    expect(s.elapsed).toBeCloseTo(0.25, 6);
  });

  it('a finished run stops simulating', () => {
    const s = running();
    s.phase = 'over';
    const d = s.distance;
    advance(s, 5);
    expect(s.distance).toBe(d);
  });

  it('pausing freezes the world', () => {
    const s = running();
    advance(s, 1);
    const snapshot = s.distance;
    s.phase = 'paused';
    advance(s, 3);
    expect(s.distance).toBe(snapshot);
  });
});

describe('track generation', () => {
  it('never blocks every lane at ground level in the same row', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const s = createState(0, seed);
      spawnRow(s, 40);
      const ground = s.obstacles.filter((o) => o.yMin < 0.2);
      const blockedLanes = new Set(
        ground.filter((o) => o.kind === 'wall' || o.kind === 'tram').map((o) => o.lane),
      );
      expect(blockedLanes.size).toBeLessThan(CONFIG.laneCount);
      // A full-width row must be uniform so a single jump or slide solves it.
      if (ground.length === CONFIG.laneCount) {
        expect(new Set(ground.map((o) => o.kind)).size).toBe(1);
      }
    }
  });

  it('never puts a hurdle and a beam in the same lane at the same depth', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const s = createState(0, seed);
      spawnRow(s, 40);
      for (const a of s.obstacles) {
        for (const b of s.obstacles) {
          if (a === b || a.lane !== b.lane) continue;
          const together = a.z < b.z + b.depth && a.z + a.depth > b.z;
          if (together) expect(a.kind).toBe(b.kind);
        }
      }
    }
  });

  it('keeps generating track ahead of the runner and culls what is behind', () => {
    const s = running(3);
    advance(s, 8);
    expect(s.obstacles.length).toBeGreaterThan(0);
    for (const o of s.obstacles) {
      expect(o.z + o.depth).toBeGreaterThan(CONFIG.cullDistance);
      expect(o.z).toBeLessThan(CONFIG.spawnDistance + CONFIG.rowGapMax);
    }
  });

  it('gives the player a warm-up before the first obstacle', () => {
    const s = running(11);
    stepOnce(s, STEP);
    const nearest = Math.min(...s.obstacles.map((o) => o.z));
    expect(nearest).toBeGreaterThan(20);
  });

  it('is deterministic for a given seed', () => {
    const a = running(123);
    const b = running(123);
    advance(a, 6);
    advance(b, 6);
    expect(a.distance).toBeCloseTo(b.distance, 9);
    expect(a.obstacles.map((o) => `${o.kind}:${o.lane}`)).toEqual(
      b.obstacles.map((o) => `${o.kind}:${o.lane}`),
    );
  });
});
