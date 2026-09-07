export type Phase = 'menu' | 'running' | 'paused' | 'over';

export type ObstacleKind =
  /** Full-height wall: change lane. */
  | 'wall'
  /** Low hurdle: jump. */
  | 'hurdle'
  /** Overhead beam: slide. */
  | 'beam'
  /** Long blocker spanning several units of depth: change lane early. */
  | 'tram';

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  lane: number;
  /** Depth of the near face. */
  z: number;
  /** Depth extent along z. */
  depth: number;
  /** Bottom of the box (world y, ground = 0). */
  yMin: number;
  /** Top of the box. */
  yMax: number;
}

export interface Coin {
  id: number;
  lane: number;
  z: number;
  y: number;
  collected: boolean;
}

export interface Player {
  lane: number;
  /** Lane index the runner is animating towards. */
  targetLane: number;
  /** Interpolated horizontal position in lane units. */
  x: number;
  y: number;
  vy: number;
  grounded: boolean;
  sliding: boolean;
  slideTimer: number;
}

export interface GameState {
  phase: Phase;
  player: Player;
  obstacles: Obstacle[];
  coins: Coin[];
  /** Total distance travelled in world units. */
  distance: number;
  speed: number;
  elapsed: number;
  coinsCollected: number;
  score: number;
  best: number;
  /** Depth at which the next spawn row will be created. */
  nextSpawnZ: number;
  nextId: number;
  /** Deterministic PRNG state. */
  seed: number;
  /** One-shot events for the presentation layer to consume. */
  events: GameEvent[];
}

export type GameEvent = 'jump' | 'slide' | 'lane' | 'coin' | 'crash';

export type Action = 'left' | 'right' | 'jump' | 'slide';
