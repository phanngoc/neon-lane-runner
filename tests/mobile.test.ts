import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/game/config';
import { classifySwipe, GESTURE } from '../src/game/input';
import {
  createState,
  hits,
  isNearMiss,
  NEAR_MISS,
  spawnRow,
  stepOnce,
} from '../src/game/logic';
import { cameraFor, hazardVisibilityZ } from '../src/game/render';
import type { Obstacle, Player } from '../src/game/types';

/** Viewports named in the mobile acceptance criteria, plus regressions. */
const VIEWPORTS = [
  { name: 'portrait 360x640', w: 360, h: 640, portrait: true },
  { name: 'portrait 390x844', w: 390, h: 844, portrait: true },
  { name: 'portrait 430x932', w: 430, h: 932, portrait: true },
  { name: 'landscape 844x390', w: 844, h: 390, portrait: false },
  { name: 'desktop 1280x800', w: 1280, h: 800, portrait: false },
];

describe('portrait camera', () => {
  it('picks the portrait camera only on tall viewports', () => {
    for (const v of VIEWPORTS) {
      expect(cameraFor(v.w, v.h).portrait, v.name).toBe(v.portrait);
    }
  });

  it('clears the next hazard row on every named viewport', () => {
    // The runner must never hide the following row of hazards. Rows are at
    // least CONFIG.rowGapMin apart, so the visibility depth has to stay under
    // that gap for the next row to be readable while the current one is close.
    for (const v of VIEWPORTS) {
      const cam = cameraFor(v.w, v.h);
      const z = hazardVisibilityZ(cam.camBack, cam.camHeight);
      expect(z, `${v.name} visibility z=${z.toFixed(2)}`).toBeLessThan(
        CONFIG.rowGapMin,
      );
    }
  });

  it('at least halves the pre-fix portrait occlusion depth', () => {
    // Regression guard against drifting back towards the old camera. Before
    // this change portrait ran camBack 8.6 / camHeight 2.55, giving 12.29 --
    // above rowGapMin (11), which is exactly why the runner could cover the
    // next hazard row. The current camera measures 5.75.
    const before = hazardVisibilityZ(8.6, 2.55);
    expect(before).toBeGreaterThan(CONFIG.rowGapMin);
    const cam = cameraFor(390, 844);
    const z = hazardVisibilityZ(cam.camBack, cam.camHeight);
    expect(z).toBeLessThan(before / 2);
    expect(z).toBeLessThan(6);
  });

  it('agrees with a direct projection of runner head vs hazard foot', () => {
    // Independent check of the closed form: project both points by hand.
    const cam = cameraFor(390, 844);
    const focal = 844 * 0.95;
    const horizon = 844 * 0.3;
    const project = (yWorld: number, z: number) =>
      horizon + (cam.camHeight - yWorld) * (focal / (z + cam.camBack));
    const head = project(CONFIG.playerHeight, 0);
    const z = hazardVisibilityZ(cam.camBack, cam.camHeight);
    // Just beyond the boundary the hazard foot is above the head (smaller y).
    expect(project(0, z + 0.01)).toBeLessThan(head);
    // Just inside it, the runner still covers the foot.
    expect(project(0, z - 0.01)).toBeGreaterThan(head);
  });
});

describe('swipe classification', () => {
  it('needs deliberate travel before firing', () => {
    expect(classifySwipe(0, 0)).toBe('none');
    expect(classifySwipe(GESTURE.swipeMin - 1, 0)).toBe('none');
    expect(classifySwipe(0, GESTURE.swipeMin - 1)).toBe('none');
  });

  it('maps each direction once past the threshold', () => {
    expect(classifySwipe(40, 0)).toBe('right');
    expect(classifySwipe(-40, 0)).toBe('left');
    expect(classifySwipe(0, -40)).toBe('jump');
    expect(classifySwipe(0, 40)).toBe('slide');
  });

  it('refuses ambiguous diagonals instead of firing two actions', () => {
    // A 45-degree drag has no dominant axis: one gesture must not resolve to
    // both a lane change and a jump.
    expect(classifySwipe(40, -40)).toBe('none');
    expect(classifySwipe(-50, 50)).toBe('none');
  });

  it('resolves a leaning diagonal to the dominant axis only', () => {
    expect(classifySwipe(48, -20)).toBe('right');
    expect(classifySwipe(20, -48)).toBe('jump');
  });

  it('never returns a direction whose axis is below the threshold', () => {
    for (let dx = -60; dx <= 60; dx += 3) {
      for (let dy = -60; dy <= 60; dy += 3) {
        const r = classifySwipe(dx, dy);
        if (r === 'left' || r === 'right') {
          expect(Math.abs(dx)).toBeGreaterThanOrEqual(GESTURE.swipeMin);
        } else if (r === 'jump' || r === 'slide') {
          expect(Math.abs(dy)).toBeGreaterThanOrEqual(GESTURE.swipeMin);
        }
      }
    }
  });
});

function playerAt(x: number, y = 0, sliding = false): Player {
  return {
    lane: Math.round(x),
    targetLane: Math.round(x),
    x,
    y,
    vy: 0,
    grounded: y === 0,
    sliding,
    slideTimer: sliding ? CONFIG.slideDuration : 0,
  };
}

const wall: Obstacle = {
  id: 1,
  kind: 'wall',
  lane: 1,
  z: 0,
  depth: 1.1,
  yMin: 0,
  yMax: 2.6,
};

describe('near-miss feedback', () => {
  it('is mutually exclusive with a collision', () => {
    // Sweep the runner across the obstacle: no position may be both.
    for (let x = 0; x <= 2; x += 0.01) {
      const p = playerAt(x);
      expect(hits(p, wall) && isNearMiss(p, wall), `x=${x.toFixed(2)}`).toBe(
        false,
      );
    }
  });

  it('fires just outside the collision edge and not far away', () => {
    const edge = 0.42 / CONFIG.laneWidth + 0.38;
    expect(isNearMiss(playerAt(1 + edge + 0.05), wall)).toBe(true);
    expect(isNearMiss(playerAt(1 + edge + NEAR_MISS.lane + 0.05), wall)).toBe(
      false,
    );
  });

  it('ignores obstacles the runner has not reached in depth', () => {
    expect(isNearMiss(playerAt(1.6), { ...wall, z: 40 })).toBe(false);
  });

  it('never changes the score', () => {
    // Same seed, same inputs: near misses accumulate but score must not.
    const a = createState(0, 99);
    a.phase = 'running';
    for (let i = 0; i < 3600; i++) stepOnce(a);
    expect(a.score).toBe(
      Math.floor(a.distance * CONFIG.distanceScore) + a.coinsCollected * 10,
    );
  });

  it('keeps the near-miss ledger bounded as obstacles are culled', () => {
    const s = createState(0, 7);
    s.phase = 'running';
    for (let i = 0; i < 20000 && s.phase === 'running'; i++) stepOnce(s);
    expect(s.scoredNearMiss.size).toBeLessThanOrEqual(s.obstacles.length);
  });
});

describe('generation stays solvable', () => {
  it('leaves at least one lane answerable for every spawned row', () => {
    // A row is solvable when, for some lane, every obstacle in it can be
    // answered: a wall/tram must be absent, a hurdle jumped, a beam slid under.
    for (let seed = 1; seed <= 400; seed++) {
      const s = createState(0, seed);
      spawnRow(s, 20);
      const answerable = [0, 1, 2].some((lane) =>
        s.obstacles
          .filter((o) => o.lane === lane)
          .every((o) => o.kind === 'hurdle' || o.kind === 'beam'),
      );
      expect(answerable, `seed ${seed}`).toBe(true);
    }
  });

  it('never blocks a lane with both a hurdle and a beam at the same depth', () => {
    // Jumping and sliding are mutually exclusive, so an overlapping pair would
    // make a lane unanswerable even though each hazard alone is fine.
    for (let seed = 1; seed <= 400; seed++) {
      const s = createState(0, seed);
      spawnRow(s, 20);
      for (const lane of [0, 1, 2]) {
        const inLane = s.obstacles.filter((o) => o.lane === lane);
        for (const a of inLane) {
          for (const b of inLane) {
            if (a.id === b.id) continue;
            const depthOverlap = a.z < b.z + b.depth && a.z + a.depth > b.z;
            const conflict =
              (a.kind === 'hurdle' && b.kind === 'beam') ||
              (a.kind === 'beam' && b.kind === 'hurdle');
            expect(depthOverlap && conflict, `seed ${seed} lane ${lane}`).toBe(
              false,
            );
          }
        }
      }
    }
  });

  it('offers a coin route on the risk pattern that is reachable by jumping', () => {
    // Pattern 6 pays more for the guarded lane. The guard must be a hurdle
    // (jumpable) and the coins must sit above it, not inside it.
    let seen = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const s = createState(0, seed);
      spawnRow(s, 20);
      const hurdles = s.obstacles.filter((o) => o.kind === 'hurdle');
      const guarded = hurdles.find((h) =>
        s.coins.some((c) => c.lane === h.lane && c.y > h.yMax),
      );
      if (!guarded) continue;
      seen += 1;
      for (const c of s.coins.filter((c) => c.lane === guarded.lane)) {
        expect(c.y).toBeGreaterThan(guarded.yMax);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
