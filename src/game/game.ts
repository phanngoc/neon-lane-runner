import { onRemoteBest, submitRun, syncBest, track } from './arcade';
import { Audio } from './audio';
import { CONFIG } from './config';
import { attachInput } from './input';
import {
  advance,
  completedMissions,
  createState,
  MISSIONS,
  queueAction,
  resetRun,
} from './logic';
import { EFFECTS, Renderer } from './render';
import type { EffectLevel } from './render';
import { loadBest, loadMuted, saveBest, saveMuted } from './storage';
import { loadEffects, loadMissions, saveEffects, saveMissions } from './storage';
import type { Action, GameState, ObstacleKind } from './types';

/**
 * What killed the runner, and the one thing to do differently. The previous
 * build replaced this with "New best run!" whenever the score was a record,
 * which on a first run is *every* death -- so the failure feedback was hidden
 * behind the achievement feedback.
 */
const CAUSE: Record<ObstacleKind, { title: string; advice: string }> = {
  wall: {
    title: 'Ran into a wall',
    advice: 'Walls fill a whole lane. Swipe left or right to go around one.',
  },
  tram: {
    title: 'Clipped a tram',
    advice: 'Trams are long. Change lane as soon as you see one, not at the last moment.',
  },
  hurdle: {
    title: 'Tripped on a hurdle',
    advice: 'Hurdles are low and carry a rail on top. Swipe up to jump them.',
  },
  beam: {
    title: 'Hit an overhead beam',
    advice: 'Beams hang from above on two cables. Swipe down to slide under.',
  },
};

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
  effectsButton: HTMLButtonElement;
  /** Speed chip; only shown while the run is still accelerating. */
  boost: HTMLElement;
  /** One-line coach shown over the live game during the first run. */
  coach: HTMLElement;
  pads: HTMLElement;
}

/**
 * Playable onboarding. Each step is a single instruction shown over the live
 * game and dismissed by doing the thing, so the controls are learned by using
 * them rather than by reading a wall of rules. It runs once per device.
 */
const COACH_STEPS: Array<{ text: string; done: (s: GameState) => boolean }> = [
  {
    text: 'Swipe left or right to change lane',
    done: (s) => s.player.targetLane !== 1,
  },
  { text: 'Swipe up to jump', done: (s) => !s.player.grounded },
  { text: 'Swipe down to slide under beams', done: (s) => s.player.sliding },
  { text: 'Now sweep up coins and stay alive', done: (s) => s.coinsCollected > 0 },
];

export class Game {
  readonly state: GameState;
  private readonly renderer: Renderer;
  private readonly audio = new Audio();
  /** Missions already completed across sessions; used to show fresh goals. */
  private done = new Set<string>();
  private reducedMotion = false;
  private coachStep = 0;
  private coachActive = false;
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
    this.done = loadMissions();
    this.applyEffectLevel(loadEffects());
  }

  /**
   * Effects have three levels. `reduced` halves particle bursts and drops the
   * shake; `minimal` removes both. At every level a hazard keeps its own hue,
   * its own silhouette and its outline, so nothing that can kill the player is
   * ever expressed by an effect alone.
   */
  private applyEffectLevel(level: EffectLevel | null): void {
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    this.reducedMotion = media ? media.matches : false;
    // An explicit choice wins; otherwise the OS preference selects `reduced`.
    const resolved: EffectLevel = level ?? (this.reducedMotion ? 'reduced' : 'full');
    this.renderer.effects = resolved;
    document.documentElement.dataset.effects = resolved;
  }

  /** Cycles full -> reduced -> minimal and persists the choice. */
  cycleEffects(): EffectLevel {
    const order: EffectLevel[] = ['full', 'reduced', 'minimal'];
    const next = order[(order.indexOf(this.renderer.effects) + 1) % order.length]!;
    this.renderer.effects = next;
    document.documentElement.dataset.effects = next;
    saveEffects(next);
    return next;
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
    this.ui.effectsButton.addEventListener('click', (e) => {
      e.stopPropagation();
      const level = this.cycleEffects();
      this.ui.effectsButton.setAttribute('aria-label', `Visual effects: ${level}`);
    });
    for (const pad of Array.from(this.ui.pads.querySelectorAll('[data-action]'))) {
      pad.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.input((pad as HTMLElement).dataset.action as Action);
      });
    }

    // Save từ máy khác về: chỉ nhận kỷ lục CAO HƠN, không bao giờ để tụt.
    onRemoteBest((best) => {
      if (best <= this.state.best) return;
      this.state.best = best;
      saveBest(best);
      this.updateHud();
    });

    // First-ever session on this device gets the playable coach.
    this.coachActive = this.done.size === 0 && loadBest() === 0;
    this.showMenu();
    this.syncMuteButton();
    this.ui.effectsButton.setAttribute(
      'aria-label',
      `Visual effects: ${this.renderer.effects}`,
    );
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
      this.coachStep = 0;
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
    // Keyboard hints are pointless on a phone, so the menu only lists the
    // scheme the device actually has. The rest is taught by the coach.
    const keyboard =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const controls = keyboard
      ? `<ul class="keys">
           <li><span>&larr; &rarr;</span> change lane</li>
           <li><span>&uarr;</span> / <span>Space</span> jump over hurdles</li>
           <li><span>&darr;</span> slide under beams</li>
           <li><span>P</span> pause &nbsp;·&nbsp; <span>M</span> mute</li>
         </ul>`
      : `<ul class="keys">
           <li><span>&#8592;&#8594;</span> swipe sideways to change lane</li>
           <li><span>&#8593;</span> swipe up, or tap, to jump</li>
           <li><span>&#8595;</span> swipe down to slide</li>
         </ul>`;
    const goals = MISSIONS.map(
      (m) => `<li class="${this.done.has(m.id) ? 'hit' : ''}">
        <span class="goal">${m.label}</span>
        <span class="prog">${this.done.has(m.id) ? 'done ✓' : `0/${m.target}`}</span></li>`,
    ).join('');
    this.showOverlay(
      'Neon Lane Runner',
      `<p>Three lanes. Go around walls and trams, jump hurdles, slide under
       beams. The city speeds up the longer you last.</p>
       ${controls}
       <ul class="missions">${goals}</ul>`,
      'Start run',
      'menu',
    );
  }

  private showGameOver(): void {
    const s = this.state;
    const isBest = s.score >= s.best && s.score > 0;
    const cause = s.deathCause ? CAUSE[s.deathCause] : null;
    this.ui.pauseButton.disabled = true;

    const cleared = completedMissions(s);
    for (const m of cleared) this.done.add(m.id);
    if (cleared.length > 0) saveMissions(this.done);

    const badge = isBest ? '<p class="badge">New best</p>' : '';
    const missionRows = MISSIONS.map((m) => {
      const at = Math.min(m.progress(s), m.target);
      const hit = at >= m.target;
      return `<li class="${hit ? 'hit' : ''}"><span class="goal">${m.label}</span>
        <span class="prog">${at}/${m.target}${hit ? ' ✓' : ''}</span></li>`;
    }).join('');

    this.showOverlay(
      cause ? cause.title : 'Run over',
      `${badge}
       <p class="advice">${cause ? cause.advice : ''}</p>
       <p class="result">Score <strong>${s.score}</strong></p>
       <p class="sub">${s.coinsCollected} coins · ${Math.floor(s.distance)} m ·
       ${s.nearMisses} near miss${s.nearMisses === 1 ? '' : 'es'} · best ${s.best}</p>
       <ul class="missions">${missionRows}</ul>`,
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

  /** Advances the coach when the player performs the current instruction. */
  private updateCoach(): void {
    if (!this.coachActive || this.state.phase !== 'running') {
      this.ui.coach.hidden = true;
      return;
    }
    const step = COACH_STEPS[this.coachStep];
    if (!step) {
      this.coachActive = false;
      this.ui.coach.hidden = true;
      return;
    }
    if (step.done(this.state)) {
      this.coachStep += 1;
      return;
    }
    this.ui.coach.hidden = false;
    if (this.ui.coach.textContent !== step.text) {
      this.ui.coach.textContent = step.text;
    }
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
        this.renderer.burst(EFFECTS.maxPerBurst, pos.x, pos.y, '#FF4D3D', 320);
        this.renderer.kick();
      } else if (e === 'nearmiss') {
        // Deliberately small: a short spark beside the runner, no shake and no
        // score change, so a lucky squeeze reads as skill without nagging.
        const pos = this.renderer.screenOf(s.player.x, s.player.y + 0.7, 0.4);
        this.renderer.burst(4, pos.x, pos.y, '#38BDF8', 120);
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
      // Platform: điểm lượt vừa xong lên bảng, kỷ lục lên cloud save. Cả hai
      // nuốt lỗi trong arcade.ts nên platform chết cũng không chặn game over.
      submitRun(this.state.score);
      syncBest(this.state.best);
      track('run_over', { score: this.state.score, coins: this.state.coinsCollected });
      this.showGameOver();
    }

    this.renderer.updateEffects(dt);
    this.renderer.draw(this.state);
    this.updateHud();
    this.updateCoach();
  };

  private updateHud(): void {
    const s = this.state;
    this.ui.score.textContent = String(s.score);
    this.ui.best.textContent = String(s.best);
    this.ui.coins.textContent = String(s.coinsCollected);
    const pct = Math.max(
      0,
      Math.round(
        ((s.speed - CONFIG.startSpeed) / (CONFIG.maxSpeed - CONFIG.startSpeed)) * 100,
      ),
    );
    // The chip appears only while the speed is actually climbing, per Apple's
    // guidance to show and hide controls to reflect gameplay.
    const climbing = s.phase === 'running' && s.speed < CONFIG.maxSpeed && pct > 0;
    this.ui.boost.hidden = !climbing;
    if (climbing) this.ui.speed.textContent = `${pct}%`;
  }
}

export type { Ui };
