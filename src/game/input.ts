import type { Action } from './types';

export interface InputHandlers {
  action: (action: Action) => void;
  togglePause: () => void;
  primary: () => void;
  toggleMute: () => void;
}

const KEY_ACTIONS: Record<string, Action> = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowUp: 'jump',
  KeyW: 'jump',
  Space: 'jump',
  ArrowDown: 'slide',
  KeyS: 'slide',
};

/**
 * Swipe recognition thresholds. These are deliberate rather than hair-trigger:
 * a gesture only counts once it has travelled `SWIPE_MIN` CSS px along one axis
 * *and* that axis dominates the other by `DOMINANCE`. Diagonal drags therefore
 * resolve to a single unambiguous direction instead of firing two actions.
 */
export const GESTURE = {
  /** Travel along the deciding axis before a swipe fires, in CSS px. */
  swipeMin: 24,
  /** Deciding axis must exceed the other axis by this factor. */
  dominance: 1.6,
  /** Movement below this counts as a stationary tap, in CSS px. */
  tapSlop: 12,
  /** A tap must lift within this many ms to count as a jump. */
  tapMaxMs: 350,
} as const;

export type GestureResult = Action | 'none';

/** Pure gesture classifier: exported so the thresholds are unit-testable. */
export function classifySwipe(dx: number, dy: number): GestureResult {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= GESTURE.swipeMin && ax >= ay * GESTURE.dominance) {
    return dx > 0 ? 'right' : 'left';
  }
  if (ay >= GESTURE.swipeMin && ay >= ax * GESTURE.dominance) {
    return dy > 0 ? 'slide' : 'jump';
  }
  return 'none';
}

/** Elements that own their own touch handling; gestures must not start there. */
const UI_SELECTOR = '#overlay, #hud, #pads, button';

/** Wires keyboard, pointer and touch input. Returns a teardown function. */
export function attachInput(
  target: HTMLElement,
  handlers: InputHandlers,
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const action = KEY_ACTIONS[e.code];
    if (action) {
      e.preventDefault();
      handlers.action(action);
      return;
    }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      e.preventDefault();
      handlers.togglePause();
    } else if (e.code === 'Enter' || e.code === 'KeyR') {
      e.preventDefault();
      handlers.primary();
    } else if (e.code === 'KeyM') {
      e.preventDefault();
      handlers.toggleMute();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // Exactly one pointer drives the game at a time. A second finger landing
  // mid-gesture used to overwrite the origin and produce a phantom swipe, so
  // additional pointers are ignored until the tracked one is released.
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startT = 0;
  /** True once this gesture has produced an action; blocks duplicates. */
  let fired = false;

  const release = (): void => {
    pointerId = null;
    fired = false;
  };

  const onDown = (e: PointerEvent) => {
    if (pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.target as Element | null;
    if (el && el.closest && el.closest(UI_SELECTOR)) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startT = e.timeStamp;
    fired = false;
    // Capture so the lift is delivered even if the finger leaves the canvas;
    // without it a swipe that ends over the HUD was silently dropped.
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort: unsupported targets still work via pointerup */
    }
  };

  // Recognising mid-gesture (rather than on lift) is what makes the controls
  // feel immediate: the lane change starts the moment the thumb commits.
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId || fired) return;
    const action = classifySwipe(e.clientX - startX, e.clientY - startY);
    if (action !== 'none') {
      fired = true;
      handlers.action(action);
    }
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const wasFired = fired;
    release();
    if (wasFired) return;
    // A short, stationary tap is a jump so the game is playable one-handed
    // without ever leaving the thumb's reach.
    const still =
      Math.abs(dx) < GESTURE.tapSlop && Math.abs(dy) < GESTURE.tapSlop;
    if (still && e.timeStamp - startT < GESTURE.tapMaxMs) {
      handlers.action('jump');
      return;
    }
    // Slow or ambiguous drags deliberately do nothing rather than guess.
    const late = classifySwipe(dx, dy);
    if (late !== 'none') handlers.action(late);
  };

  const onCancel = (e: PointerEvent) => {
    if (e.pointerId === pointerId) release();
  };

  // A backgrounded tab, an incoming call or the app switcher all steal the
  // pointer stream. Dropping the gesture here stops a held input from leaking
  // into the next frame the player sees.
  const onBlur = (): void => release();
  const onVisibility = (): void => {
    if (document.hidden) release();
  };

  target.addEventListener('pointerdown', onDown);
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onCancel);
  target.addEventListener('lostpointercapture', onCancel);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onCancel);
    target.removeEventListener('lostpointercapture', onCancel);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export { KEY_ACTIONS };
