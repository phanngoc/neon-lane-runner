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

  // Swipe / tap. A tap counts as a jump so one-handed play works.
  const SWIPE = 26;
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let tracking = false;

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tracking = true;
    startX = e.clientX;
    startY = e.clientY;
    startT = performance.now();
  };
  const onUp = (e: PointerEvent) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) < SWIPE && Math.abs(dy) < SWIPE) {
      if (performance.now() - startT < 400) handlers.action('jump');
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      handlers.action(dx > 0 ? 'right' : 'left');
    } else {
      handlers.action(dy > 0 ? 'slide' : 'jump');
    }
  };
  const onCancel = () => {
    tracking = false;
  };

  target.addEventListener('pointerdown', onDown);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onCancel);

  // Stop the page from scrolling or double-tap-zooming during play.
  const blockTouch = (e: TouchEvent) => e.preventDefault();
  target.addEventListener('touchstart', blockTouch, { passive: false });
  target.addEventListener('touchmove', blockTouch, { passive: false });

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onCancel);
    target.removeEventListener('touchstart', blockTouch);
    target.removeEventListener('touchmove', blockTouch);
  };
}

export { KEY_ACTIONS };
