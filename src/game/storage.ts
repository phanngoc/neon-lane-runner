const BEST_KEY = 'neon-lane-runner:best';
const MUTE_KEY = 'neon-lane-runner:muted';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private browsing / storage disabled: best score simply does not persist */
  }
}

export function loadBest(): number {
  const raw = safeGet(BEST_KEY);
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function saveBest(value: number): void {
  safeSet(BEST_KEY, String(Math.floor(value)));
}

export function loadMuted(): boolean {
  return safeGet(MUTE_KEY) === '1';
}

export function saveMuted(value: boolean): void {
  safeSet(MUTE_KEY, value ? '1' : '0');
}

const EFFECT_KEY = 'neon-lane-runner.effects';
const MISSION_KEY = 'neon-lane-runner.missions';

/** Persisted effect level, or null when the player has not chosen one. */
export function loadEffects(): 'full' | 'reduced' | 'minimal' | null {
  try {
    const v = localStorage.getItem(EFFECT_KEY);
    return v === 'full' || v === 'reduced' || v === 'minimal' ? v : null;
  } catch {
    return null;
  }
}

export function saveEffects(level: 'full' | 'reduced' | 'minimal'): void {
  try {
    localStorage.setItem(EFFECT_KEY, level);
  } catch {
    /* private mode: the choice simply does not survive the session */
  }
}

export function loadMissions(): Set<string> {
  try {
    const raw = localStorage.getItem(MISSION_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveMissions(done: Set<string>): void {
  try {
    localStorage.setItem(MISSION_KEY, JSON.stringify(Array.from(done)));
  } catch {
    /* ignored: missions are optional and never gate play */
  }
}
