/** Tunable gameplay constants. All distances are in world units (z = depth ahead). */
export const CONFIG = {
  laneCount: 3,
  /** Horizontal distance between lane centres. */
  laneWidth: 1.35,
  /** How long a lane change takes, in seconds. */
  laneChangeTime: 0.13,

  gravity: -26,
  jumpVelocity: 8.6,
  slideDuration: 0.55,

  /** Runner collision box while upright. */
  playerHalfWidth: 0.42,
  playerHeight: 1.5,
  /** Collision height while sliding. */
  playerSlideHeight: 0.62,
  playerDepth: 0.6,

  startSpeed: 11,
  maxSpeed: 34,
  /** Units/second added to forward speed for every second survived. */
  speedRamp: 0.42,

  /** Obstacles/coins are created this far ahead and culled behind the camera. */
  spawnDistance: 95,
  cullDistance: -8,
  /** Minimum gap between successive spawn rows, in world units. */
  rowGapMin: 11,
  rowGapMax: 19,

  coinValue: 10,
  /** Score per world unit travelled. */
  distanceScore: 1,

  /** Grace period at the start with no obstacles. */
  warmupDistance: 30,
} as const;

/** Fixed simulation step (seconds) so gameplay is deterministic and testable. */
export const STEP = 1 / 120;
