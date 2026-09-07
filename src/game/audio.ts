import type { GameEvent } from './types';

/**
 * All sound is synthesised with the Web Audio API at runtime, so the project
 * ships no third-party audio files.
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;

  private ensure(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    if (!this.ctx) {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Must be called from a user gesture on iOS/Safari before any sound plays. */
  unlock(): void {
    this.ensure();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(value: boolean): void {
    this.muted = value;
    if (this.master) this.master.gain.value = value ? 0 : 0.22;
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  private blip(
    freq: number,
    duration: number,
    type: OscillatorType,
    sweepTo?: number,
    gain = 1,
  ): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(freq, t);
    if (sweepTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + duration);
    }
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  private noise(duration: number, gain = 0.8): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const frames = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const env = ctx.createGain();
    env.gain.value = gain;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    src.connect(filter).connect(env).connect(this.master);
    src.start();
  }

  play(event: GameEvent): void {
    switch (event) {
      case 'jump':
        this.blip(330, 0.16, 'square', 720, 0.5);
        break;
      case 'slide':
        this.noise(0.22, 0.5);
        break;
      case 'lane':
        this.blip(520, 0.07, 'triangle', 660, 0.32);
        break;
      case 'coin':
        this.blip(880, 0.09, 'sine', 1320, 0.55);
        break;
      case 'crash':
        this.blip(180, 0.5, 'sawtooth', 45, 0.75);
        this.noise(0.45, 0.9);
        break;
    }
  }
}
