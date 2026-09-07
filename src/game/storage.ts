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
