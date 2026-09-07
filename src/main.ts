import './style.css';
import { Game } from './game/game';
import type { Ui } from './game/game';

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const ui: Ui = {
  root: need('stage'),
  canvas: need<HTMLCanvasElement>('scene'),
  score: need('score'),
  best: need('best'),
  coins: need('coins'),
  speed: need('speed'),
  overlay: need('overlay'),
  overlayTitle: need('overlay-title'),
  overlayBody: need('overlay-body'),
  overlayAction: need<HTMLButtonElement>('overlay-action'),
  pauseButton: need<HTMLButtonElement>('pause'),
  muteButton: need<HTMLButtonElement>('mute'),
  pads: need('pads'),
};

const game = new Game(ui);
game.start();

// Exposed for the automated browser smoke test in scripts/smoke.mjs.
declare global {
  interface Window {
    neonLaneRunner: Game;
  }
}
window.neonLaneRunner = game;
