# Neon Lane Runner

A three-lane endless runner that plays in the browser on desktop and on a phone.
Sprint down a neon boulevard, swap lanes to dodge walls and trams, jump the
hurdles, slide under the overhead beams, and hoover up coins while the city
keeps getting faster.

TypeScript + Vite, rendered with a hand-rolled pseudo-3D projection on a single
Canvas 2D context. No game engine, no asset downloads, no backend.

![Desktop gameplay](docs/screenshot-desktop-play.png)

| Start screen | Game over | Mobile |
| --- | --- | --- |
| ![Menu](docs/screenshot-desktop-menu.png) | ![Game over](docs/screenshot-desktop-gameover.png) | ![Mobile](docs/screenshot-mobile-play.png) |

## Gameplay

- **Three lanes.** The runner is locked to lane 0, 1 or 2 and slides between
  them in 0.13 s.
- **Four hazards**, each with its own required answer:
  | Hazard | Look | Answer |
  | --- | --- | --- |
  | Wall | pink block | change lane |
  | Tram | long violet block (14 units deep) | change lane early |
  | Hurdle | short amber block with a `^` chevron | jump |
  | Beam | cyan overhead block with a `v` chevron | slide |
- **Coins** are worth 10 points each. Rows of them mark the safe lane, and the
  jump rows hang coins in an arc so clearing a hurdle pays off.
- **Score** = metres travelled + 10 per coin. Your best score is kept in
  `localStorage` and survives a reload.
- **The city accelerates.** Forward speed starts at 11 units/s and ramps by
  0.42 per second of survival up to a 34 unit/s cap — the `BOOST` readout in the
  HUD shows how far along that ramp you are.
- **Generated track.** Every row is drawn from seven hand-authored patterns via
  a seeded PRNG, and the generator never produces an unsolvable row (tested).

## Controls

| Action | Keyboard | Touch / pointer |
| --- | --- | --- |
| Change lane | `←` `→` or `A` `D` | swipe left/right, or the on-screen ◀ ▶ pads |
| Jump | `↑`, `W` or `Space` | swipe up, tap anywhere, or the ▲ pad |
| Slide | `↓` or `S` | swipe down, or the ▼ pad |
| Pause / resume | `P` or `Esc` | ⏸ button in the HUD |
| Start / restart | `Enter` or `R` | the overlay button |
| Mute | `M` | 🔊 button in the HUD |

The on-screen pads are hidden on devices that report a fine pointer, so a
desktop browser gets a clean playfield. Switching away from the tab
auto-pauses.

## Install, dev, build

Requires Node 18+. `package-lock.json` is committed, so use `npm ci` for a
reproducible install.

```bash
npm ci            # install exactly what the lockfile pins
npm run dev       # dev server on http://localhost:5173
npm run build     # tsc --noEmit && vite build  ->  dist/
npm run preview   # serve the production build on :4173
npm test          # 25 unit tests (vitest)
npm run smoke     # browser smoke test against dist/ (needs `npx playwright install chromium`)
```

## Architecture

```
src/
  main.ts            binds DOM elements and boots the Game
  style.css          HUD, overlays, touch pads, responsive layout
  game/
    config.ts        every tunable constant + the fixed 1/120 s timestep
    types.ts         GameState, Obstacle, Coin, Player, Phase, Action
    logic.ts         PURE simulation: input, physics, spawning, collision, score
    render.ts        pseudo-3D Canvas 2D renderer, particles, screen shake
    audio.ts         Web Audio synthesis (no audio files ship with the project)
    input.ts         keyboard + pointer/swipe wiring
    storage.ts       localStorage best score and mute preference
    game.ts          frame loop, phase/overlay orchestration, HUD updates
tests/logic.test.ts  unit tests over the pure simulation
scripts/smoke.mjs    Playwright smoke test + screenshot capture
```

Two deliberate choices shape the code:

**The simulation is pure and separate from the renderer.** `logic.ts` touches no
DOM and no clock. It advances a plain `GameState` object by a fixed
`1/120 s` step, so the same input sequence always produces the same run — that
is what makes collision, scoring and generation testable without a browser.
`advance()` splits a variable frame delta into fixed sub-steps and clamps a
single call to 0.25 s, so returning to a backgrounded tab cannot teleport the
runner through a wall.

**The 3D is a projection, not an engine.** The camera sits 6.2 units behind and
2.55 units above the runner. `project(lane, y, z)` divides by depth to get a
screen point, and everything — road, lane dividers, obstacle cuboids, coins,
rails — is painted from that one function, far to near. Portrait viewports get a
longer focal length so the three lanes stay readable on a phone.

Presentation and simulation communicate through a small one-shot `events` queue
(`jump`, `slide`, `lane`, `coin`, `crash`) that the frame loop drains into sound
effects, coin sparks and screen shake.

## Verification

Commands and their results on macOS 15 (Darwin 25.5.0), Node v24.13.0:

```
$ npm run build
✓ tsc --noEmit clean
✓ built in 91ms   dist/assets/index-*.js 21.47 kB (gzip 7.85 kB)

$ npm test
✓ tests/logic.test.ts (25 tests) 11ms
  Test Files  1 passed (1)
       Tests  25 passed (25)

$ npm run smoke
39/39 checks passed
```

The 25 unit tests cover: lane changes and edge clamping, no double-jump, jump
apex and landing, slide expiry, that a jump clears a hurdle while a slide does
not, that a slide clears a beam while standing does not, obstacle-vs-lane and
obstacle-vs-depth collision, distance + coin scoring, single-count coin pickup,
the speed ramp and its cap, best-score capture on death, the frame-delta clamp,
that pause and game over freeze the world, full run reset preserving the best
score, and 800 generated rows asserted solvable and internally consistent.

The smoke test boots the **production build** in Chromium at 1280×800 and at an
emulated iPhone 13, and for each viewport asserts: canvas fills the viewport,
start overlay shows and hides, frames render, distance advances, the track
populates, the HUD matches the score, each key moves the runner as expected,
jump leaves the ground and lands, slide engages, a coin in reach increments both
the counter and the HUD, pause freezes the simulation with zero drift, resume
works, mute persists to `localStorage`, a planted wall ends the run and writes
the best score, restart resets distance and coins while keeping the best, and no
console or page errors occur. Screenshots in `docs/` come from that run.

## Source reference

Inspired by the endless-runner genre popularised by **Subway Surfers**
(<https://apps.apple.com/us/app/subway-surfers/id512939461>), used purely as a
genre reference for the three-lane / jump / slide / coin loop.

No branding, artwork, audio, level data, characters or names from that game are
used or reproduced here. Neon Lane Runner's name, visual design, level
generation patterns, tuning and code are original to this project.

## Asset credits & licence

There are no third-party assets. Everything is generated at runtime:

- **Graphics** — drawn procedurally with Canvas 2D paths and gradients. The
  skyline silhouette comes from a fixed integer LCG so the backdrop is stable.
- **Audio** — synthesised on demand with the Web Audio API (oscillators plus a
  filtered noise buffer). No audio files ship with the project.
- **Fonts** — system font stack only.
- **Icons** — Unicode characters and an inline SVG favicon.

Code and assets are MIT licensed (see [LICENSE](LICENSE)).

## Known limitations

- Pseudo-3D only: there is no depth buffer, so overlap is resolved by painting
  back to front. Two obstacles at nearly identical depth in adjacent lanes can
  briefly z-fight at their shared edge.
- Audio needs a user gesture before it starts (a browser autoplay rule), so the
  first sound arrives with the first tap or key press.
- The best score is per-browser `localStorage`. There is no account, sync or
  leaderboard, and it silently does not persist in private-browsing modes that
  block storage.
- Difficulty ramps on time alone. Row patterns are drawn uniformly at random, so
  the mix of hazards does not get harder as speed rises — only the reaction time
  shrinks.
- No power-ups, no character selection and a single environment theme.
- The smoke test covers Chromium only. Firefox and Safari are untested beyond
  manual checks, though the code uses no Chromium-specific APIs.
- Landscape phones work but the HUD and pads are tuned for portrait.
