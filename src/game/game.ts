import { Audio } from './audio';
import { CONFIG } from './config';
import { attachInput } from './input';
import { advance, createState, queueAction, resetRun } from './logic';
import { Renderer } from './render';
import { loadBest, loadMuted, saveBest, saveMuted } from './storage';
import type { Action, GameState } from './types';

interface Ui {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  score: HTMLElement;
  best: HTMLElement;
  coins: HTMLElement;
  speed: HTMLElement;
  overlay: HTMLElement;
  overlayTitle: HTMLElement;
  overlayBody: HTMLElement;
  overlayAction: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  muteButton: HTMLButtonElement;
  pads: HTMLElement;
}

export class Game {
  readonly state: GameState;
  private readonly renderer: Renderer;
  private readonly audio = new Audio();
  private detachInput: (() => void) | null = null;
  private raf = 0;
  private lastFrame = 0;
  /** Set by the render loop; used by the smoke test to confirm frames advance. */
  frames = 0;

  constructor(private readonly ui: Ui) {
    const ctx = ui.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.renderer = new Renderer(ui.canvas, ctx);
    this.state = createState(loadBest());
    this.audio.setMuted(loadMuted());
  }

  start(): void {
    this.resize();
    window.addEventListener('resize', this.resize);
    window.addEventListener('orientationchange', this.resize);
    document.addEventListener('visibilitychange', this.onVisibility);

    this.detachInput = attachInput(this.ui.root, {
      action: (a) => this.input(a),
      togglePause: () => this.togglePause(),
      primary: () => this.primary(),
      toggleMute: () => this.toggleMute(),
    });

    this.ui.overlayAction.addEventListener('click', (e) => {
      e.stopPropagation();
      this.primary();
    });
    this.ui.pauseButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePause();
    });
    this.ui.muteButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMute();
    });
    for (const pad of Array.from(this.ui.pads.querySelectorAll('[data-action]'))) {
      pad.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.input((pad as HTMLElement).dataset.action as Action);
      });
    }

    this.showMenu();
    this.syncMuteButton();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('orientationchange', this.resize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.detachInput?.();
  }

  private readonly resize = (): void => {
    const rect = this.ui.root.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.resize(rect.width, rect.height, dpr);
  };

  private readonly onVisibility = (): void => {
    if (document.hidden && this.state.phase === 'running') this.togglePause();
  };

  /** Public so the smoke test can drive the game without synthetic events. */
  input(action: Action): void {
    if (this.state.phase === 'menu' || this.state.phase === 'over') return;
    if (this.state.phase === 'paused') {
      this.togglePause();
      return;
    }
    this.audio.unlock();
    // queueAction records feedback events which the frame loop turns into sound.
    queueAction(this.state, action);
  }

  /** Start, resume or restart depending on the current phase. */
  primary(): void {
    this.audio.unlock();
    if (this.state.phase === 'menu' || this.state.phase === 'over') {
      resetRun(this.state, (this.state.seed ^ Math.floor(performance.now())) | 1);
      this.hideOverlay();
      this.ui.pauseButton.disabled = false;
    } else if (this.state.phase === 'paused') {
      this.state.phase = 'running';
      this.hideOverlay();
    }
  }

  togglePause(): void {
    if (this.state.phase === 'running') {
      this.state.phase = 'paused';
      this.showOverlay(
        'Paused',
        'Take a breath. Your run is waiting.',
        'Resume',
        'paused',
      );
    } else if (this.state.phase === 'paused') {
      this.state.phase = 'running';
      this.hideOverlay();
    }
  }

  toggleMute(): void {
    this.audio.unlock();
    const muted = this.audio.toggleMute();
    saveMuted(muted);
    this.syncMuteButton();
  }

  private syncMuteButton(): void {
    const muted = this.audio.isMuted;
    this.ui.muteButton.textContent = muted ? '🔇' : '🔊';
    this.ui.muteButton.setAttribute('aria-pressed', String(muted));
    this.ui.muteButton.setAttribute(
      'aria-label',
      muted ? 'Unmute sound' : 'Mute sound',
    );
  }

  private showMenu(): void {
    this.ui.pauseButton.disabled = true;
    this.showOverlay(
      'Neon Lane Runner',
      `<p>Sprint down three neon lanes. Dodge walls, <strong>jump</strong> hurdles,
       <strong>slide</strong> under beams and sweep up coins. The city speeds up the
       longer you survive.</p>
       <ul class="keys">
         <li><span>&larr; &rarr;</span> or <span>A / D</span> — change lane</li>
         <li><span>&uarr;</span>, <span>W</span> or <span>Space</span> — jump</li>
         <li><span>&darr;</span> or <span>S</span> — slide</li>
         <li><span>P</span> / <span>Esc</span> — pause &nbsp;·&nbsp; <span>M</span> — mute</li>
         <li>Touch: swipe left/right/up/down, tap to jump</li>
       </ul>`,
      'Start run',
      'menu',
    );
  }

  private showGameOver(): void {
    const s = this.state;
    const isBest = s.score >= s.best && s.score > 0;
    this.ui.pauseButton.disabled = true;
    this.showOverlay(
      isBest ? 'New best run!' : 'Wiped out',
      `<p class="result">Score <strong>${s.score}</strong></p>
       <p class="sub">${s.coinsCollected} coins · ${Math.floor(s.distance)} m ·
       best ${s.best}</p>`,
      'Run again',
      'over',
    );
  }

  private showOverlay(
    title: string,
    bodyHtml: string,
    actionLabel: string,
    variant: string,
  ): void {
    this.ui.overlayTitle.textContent = title;
    this.ui.overlayBody.innerHTML = bodyHtml;
    this.ui.overlayAction.textContent = actionLabel;
    this.ui.overlay.dataset.variant = variant;
    this.ui.overlay.hidden = false;
    this.ui.root.dataset.phase = variant;
  }

  private hideOverlay(): void {
    this.ui.overlay.hidden = true;
    this.ui.root.dataset.phase = 'running';
  }

  private consumeEvents(): void {
    const s = this.state;
    if (s.events.length === 0) return;
    for (const e of s.events) {
      this.audio.play(e);
      if (e === 'coin') {
        const pos = this.renderer.screenOf(s.player.x, s.player.y + 0.8, 0.5);
        this.renderer.burst(6, pos.x, pos.y, '#ffd447', 140);
      } else if (e === 'crash') {
        const pos = this.renderer.screenOf(s.player.x, s.player.y + 0.8, 0);
        this.renderer.burst(46, pos.x, pos.y, '#ff2e88', 320);
        this.renderer.shake = 1;
      }
    }
    s.events.length = 0;
  }

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.frames += 1;

    const wasRunning = this.state.phase === 'running';
    if (wasRunning) advance(this.state, dt);
    this.consumeEvents();

    if (wasRunning && this.state.phase === 'over') {
      saveBest(this.state.best);
      this.showGameOver();
    }

    this.renderer.updateEffects(dt);
    this.renderer.draw(this.state);
    this.updateHud();
  };

  private updateHud(): void {
    const s = this.state;
    this.ui.score.textContent = String(s.score);
    this.ui.best.textContent = String(s.best);
    this.ui.coins.textContent = String(s.coinsCollected);
    const pct = Math.round(
      ((s.speed - CONFIG.startSpeed) / (CONFIG.maxSpeed - CONFIG.startSpeed)) * 100,
    );
    this.ui.speed.textContent = `${Math.max(0, pct)}%`;
  }
}

export type { Ui };
