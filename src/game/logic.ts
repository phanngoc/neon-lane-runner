import { CONFIG, STEP } from './config';
import type { Action, Coin, GameState, Obstacle, Player } from './types';

/** Half-width of an obstacle box expressed in lane units. */
export const OBSTACLE_HALF_LANES = 0.38;
/** Half-width of the runner expressed in lane units. */
export const PLAYER_HALF_LANES = CONFIG.playerHalfWidth / CONFIG.laneWidth;

/** Deterministic PRNG (mulberry32) so runs are reproducible in tests. */
export function nextRandom(state: { seed: number }): number {
  state.seed = (state.seed + 0x6d2b79f5) | 0;
  let t = state.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randInt(state: { seed: number }, maxExclusive: number): number {
  return Math.floor(nextRandom(state) * maxExclusive) % maxExclusive;
}

function createPlayer(): Player {
  const mid = Math.floor(CONFIG.laneCount / 2);
  return {
    lane: mid,
    targetLane: mid,
    x: mid,
    y: 0,
    vy: 0,
    grounded: true,
    sliding: false,
    slideTimer: 0,
  };
}

export function createState(best = 0, seed = 1): GameState {
  return {
    phase: 'menu',
    player: createPlayer(),
    obstacles: [],
    coins: [],
    distance: 0,
    speed: CONFIG.startSpeed,
    elapsed: 0,
    coinsCollected: 0,
    score: 0,
    best,
    nextSpawnZ: CONFIG.warmupDistance,
    nextId: 1,
    seed,
    events: [],
  };
}

/** Returns the state to a fresh run while preserving the best score. */
export function resetRun(state: GameState, seed = state.seed): void {
  const best = state.best;
  const fresh = createState(best, seed);
  Object.assign(state, fresh);
  state.phase = 'running';
}

/** Current collision height of the runner. */
export function playerHeight(player: Player): number {
  return player.sliding ? CONFIG.playerSlideHeight : CONFIG.playerHeight;
}

export function currentScore(state: GameState): number {
  return (
    Math.floor(state.distance * CONFIG.distanceScore) +
    state.coinsCollected * CONFIG.coinValue
  );
}

export function overlaps(
  aMin: number,
  aMax: number,
  bMin: number,
  bMax: number,
): boolean {
  return aMin < bMax && aMax > bMin;
}

/** Axis-aligned test between the runner and a single obstacle box. */
export function hits(player: Player, obstacle: Obstacle): boolean {
  const dx = Math.abs(player.x - obstacle.lane);
  if (dx >= PLAYER_HALF_LANES + OBSTACLE_HALF_LANES) return false;

  const halfDepth = CONFIG.playerDepth / 2;
  if (!overlaps(-halfDepth, halfDepth, obstacle.z, obstacle.z + obstacle.depth)) {
    return false;
  }

  const h = playerHeight(player);
  return overlaps(player.y, player.y + h, obstacle.yMin, obstacle.yMax);
}

export function reaches(player: Player, coin: Coin): boolean {
  if (Math.abs(player.x - coin.lane) > 0.55) return false;
  if (Math.abs(coin.z) > CONFIG.playerDepth / 2 + 0.8) return false;
  const h = playerHeight(player);
  return coin.y > player.y - 0.7 && coin.y < player.y + h + 0.7;
}

export function queueAction(state: GameState, action: Action): void {
  if (state.phase !== 'running') return;
  const p = state.player;
  switch (action) {
    case 'left':
      if (p.targetLane > 0) {
        p.targetLane -= 1;
        state.events.push('lane');
      }
      break;
    case 'right':
      if (p.targetLane < CONFIG.laneCount - 1) {
        p.targetLane += 1;
        state.events.push('lane');
      }
      break;
    case 'jump':
      if (p.grounded) {
        p.vy = CONFIG.jumpVelocity;
        p.grounded = false;
        p.sliding = false;
        p.slideTimer = 0;
        state.events.push('jump');
      }
      break;
    case 'slide':
      if (!p.sliding) {
        p.sliding = true;
        p.slideTimer = CONFIG.slideDuration;
        // A slide from mid-air slams the runner back to the ground.
        if (!p.grounded) p.vy = Math.min(p.vy, -CONFIG.jumpVelocity * 0.8);
        state.events.push('slide');
      }
      break;
  }
}

function obstacle(
  state: GameState,
  kind: Obstacle['kind'],
  lane: number,
  z: number,
): Obstacle {
  const box = { yMin: 0, yMax: 2.6, depth: 1.1 };
  if (kind === 'hurdle') {
    box.yMax = 0.75;
    box.depth = 0.9;
  } else if (kind === 'beam') {
    box.yMin = 0.95;
    box.yMax = 2.9;
    box.depth = 0.9;
  } else if (kind === 'tram') {
    box.depth = 14;
  }
  return { id: state.nextId++, kind, lane, z, ...box };
}

function coin(state: GameState, lane: number, z: number, y: number): Coin {
  return { id: state.nextId++, lane, z, y, collected: false };
}

/** Adds one solvable row of obstacles/coins at the given depth. */
export function spawnRow(state: GameState, z: number): void {
  const lanes = [0, 1, 2];
  const pattern = randInt(state, 7);
  const pick = () => lanes[randInt(state, lanes.length)]!;

  if (pattern === 0) {
    const lane = pick();
    state.obstacles.push(obstacle(state, 'wall', lane, z));
    for (const l of lanes) if (l !== lane) state.coins.push(coin(state, l, z, 0.6));
  } else if (pattern === 1) {
    // Two walls, exactly one lane stays open.
    const open = pick();
    for (const l of lanes) {
      if (l !== open) state.obstacles.push(obstacle(state, 'wall', l, z));
    }
    state.coins.push(coin(state, open, z, 0.6));
  } else if (pattern === 2) {
    // Full-width hurdle: must jump. Coins arc overhead as the reward.
    for (const l of lanes) state.obstacles.push(obstacle(state, 'hurdle', l, z));
    const lane = pick();
    for (let i = -1; i <= 1; i++) {
      state.coins.push(coin(state, lane, z + i * 2.2, 1.7 - Math.abs(i) * 0.35));
    }
  } else if (pattern === 3) {
    // Full-width beam: must slide.
    for (const l of lanes) state.obstacles.push(obstacle(state, 'beam', l, z));
    const lane = pick();
    state.coins.push(coin(state, lane, z, 0.35));
  } else if (pattern === 4) {
    const lane = pick();
    state.obstacles.push(obstacle(state, 'tram', lane, z));
    const other = lanes.filter((l) => l !== lane);
    const coinLane = other[randInt(state, other.length)]!;
    for (let i = 0; i < 6; i++) {
      state.coins.push(coin(state, coinLane, z + i * 2.4, 0.6));
    }
  } else if (pattern === 5) {
    const wallLane = pick();
    const hurdleLane = lanes.filter((l) => l !== wallLane)[randInt(state, 2)]!;
    state.obstacles.push(obstacle(state, 'wall', wallLane, z));
    state.obstacles.push(obstacle(state, 'hurdle', hurdleLane, z));
    const free = lanes.find((l) => l !== wallLane && l !== hurdleLane)!;
    state.coins.push(coin(state, free, z, 0.6));
  } else {
    // Breather row: a line of coins that snakes across the lanes.
    const lane = pick();
    for (let i = 0; i < 5; i++) {
      state.coins.push(coin(state, lane, z + i * 2.2, 0.6));
    }
  }
}

function integrate(state: GameState, dt: number): void {
  const p = state.player;

  // Lane interpolation.
  if (p.x !== p.targetLane) {
    const rate = 1 / CONFIG.laneChangeTime;
    const delta = p.targetLane - p.x;
    const move = Math.sign(delta) * rate * dt;
    p.x = Math.abs(move) >= Math.abs(delta) ? p.targetLane : p.x + move;
  }
  p.lane = Math.round(p.x);

  // Vertical motion.
  if (!p.grounded || p.vy > 0) {
    p.vy += CONFIG.gravity * dt;
    p.y += p.vy * dt;
    if (p.y <= 0) {
      p.y = 0;
      p.vy = 0;
      p.grounded = true;
    } else {
      p.grounded = false;
    }
  }

  if (p.sliding) {
    p.slideTimer -= dt;
    if (p.slideTimer <= 0) {
      p.sliding = false;
      p.slideTimer = 0;
    }
  }

  // Forward motion: the world moves towards the camera.
  state.elapsed += dt;
  state.speed = Math.min(
    CONFIG.maxSpeed,
    CONFIG.startSpeed + CONFIG.speedRamp * state.elapsed,
  );
  const travel = state.speed * dt;
  state.distance += travel;

  for (const o of state.obstacles) o.z -= travel;
  for (const c of state.coins) c.z -= travel;
  state.nextSpawnZ -= travel;
}

function spawnAndCull(state: GameState): void {
  while (state.nextSpawnZ < CONFIG.spawnDistance) {
    spawnRow(state, state.nextSpawnZ);
    const gap =
      CONFIG.rowGapMin +
      nextRandom(state) * (CONFIG.rowGapMax - CONFIG.rowGapMin);
    state.nextSpawnZ += gap;
  }
  state.obstacles = state.obstacles.filter(
    (o) => o.z + o.depth > CONFIG.cullDistance,
  );
  state.coins = state.coins.filter(
    (c) => c.z > CONFIG.cullDistance && !c.collected,
  );
}

/** Collects coins in reach and reports whether the runner struck an obstacle. */
function resolveContacts(state: GameState): boolean {
  for (const c of state.coins) {
    if (!c.collected && reaches(state.player, c)) {
      c.collected = true;
      state.coinsCollected += 1;
      state.events.push('coin');
    }
  }
  for (const o of state.obstacles) {
    if (hits(state.player, o)) {
      state.events.push('crash');
      return true;
    }
  }
  return false;
}

/** Advances the simulation by one fixed step. Exported for tests. */
export function stepOnce(state: GameState, dt: number = STEP): void {
  if (state.phase !== 'running') return;
  integrate(state, dt);
  spawnAndCull(state);
  const crashed = resolveContacts(state);
  state.score = currentScore(state);
  if (crashed) {
    state.phase = 'over';
    if (state.score > state.best) state.best = state.score;
  }
}

/** Advances the simulation by `elapsed` seconds using fixed sub-steps. */
export function advance(state: GameState, elapsed: number): void {
  let remaining = Math.min(elapsed, 0.25);
  while (remaining > 0 && state.phase === 'running') {
    const dt = Math.min(STEP, remaining);
    stepOnce(state, dt);
    remaining -= dt;
  }
}
