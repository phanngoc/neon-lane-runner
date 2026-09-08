import { afterEach, describe, expect, it } from 'vitest';
import { onRemoteBest, submitRun, syncBest, track } from '../src/game/arcade';

type Calls = { scores: [string, number][]; saves: unknown[]; events: string[] };

function installBridge(): Calls {
  const calls: Calls = { scores: [], saves: [], events: [] };
  (globalThis as Record<string, unknown>).ArcadeGame = {
    ready: true,
    playerId: 'p1',
    onScore: (board: string, score: number) => calls.scores.push([board, score]),
    syncSave: (data: unknown) => calls.saves.push(data),
    top: async () => [],
    track: (name: string) => calls.events.push(name),
  };
  return calls;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).ArcadeGame;
  delete (globalThis as Record<string, unknown>).__arcadeApplyRemote;
});

describe('arcade bridge wrapper', () => {
  it('is a no-op when the platform SDK never loaded', () => {
    // Đây là cổng quan trọng nhất: platform chết thì game vẫn phải chạy.
    expect(() => submitRun(120)).not.toThrow();
    expect(() => syncBest(120)).not.toThrow();
    expect(() => track('run_over')).not.toThrow();
  });

  it('submits a finished run to both declared boards', () => {
    const calls = installBridge();
    submitRun(1234.7);
    expect(calls.scores).toEqual([
      ['daily', 1234],
      ['alltime', 1234],
    ]);
  });

  it('never submits a zero or negative score', () => {
    const calls = installBridge();
    submitRun(0);
    submitRun(-5);
    submitRun(Number.NaN);
    expect(calls.scores).toEqual([]);
  });

  it('syncs the personal best as a save document', () => {
    const calls = installBridge();
    syncBest(900.9);
    expect(calls.saves).toEqual([{ best: 900 }]);
  });

  it('applies a remote best only when it is higher', () => {
    installBridge();
    const seen: number[] = [];
    onRemoteBest((b) => seen.push(b));
    const apply = (globalThis as Record<string, unknown>).__arcadeApplyRemote as (d: unknown) => void;
    apply({ best: 500 });
    apply({ best: 'nonsense' });
    apply(null);
    apply({});
    expect(seen).toEqual([500]);
  });

  it('takes a remote save that arrived before the game registered', () => {
    // Cuộc đua thật: save.get() là mạng, game đăng ký callback trong module defer.
    // Bridge giữ doc ở .remote; onRemoteBest phải đọc luôn thay vì chờ mãi.
    installBridge();
    ((globalThis as Record<string, unknown>).ArcadeGame as Record<string, unknown>).remote = {
      best: 777,
    };
    const seen: number[] = [];
    onRemoteBest((b) => seen.push(b));
    expect(seen).toEqual([777]);
  });

  it('survives a bridge that only half-exists', () => {
    (globalThis as Record<string, unknown>).ArcadeGame = { ready: false } as unknown;
    expect(() => submitRun(10)).not.toThrow();
    expect(() => syncBest(10)).not.toThrow();
  });
});
