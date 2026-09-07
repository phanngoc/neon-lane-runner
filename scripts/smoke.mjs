/**
 * Browser smoke test: boots the production build in Chromium at a desktop and a
 * mobile viewport, drives real gameplay, and asserts the visible state changes.
 * Screenshots land in docs/.
 */
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const PORT = 4319;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

await mkdir(new URL('../docs/', import.meta.url).pathname, { recursive: true });
const browser = await chromium.launch();

async function run(label, contextOptions, shots) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.neonLaneRunner);

  const canvasBox = await page.locator('#scene').boundingBox();
  check(`${label}: canvas fills the viewport`,
    Math.abs(canvasBox.width - contextOptions.viewport.width) < 2 &&
    Math.abs(canvasBox.height - contextOptions.viewport.height) < 2,
    `${Math.round(canvasBox.width)}x${Math.round(canvasBox.height)}`);

  check(`${label}: start overlay visible`, await page.locator('#overlay').isVisible());
  await page.screenshot({ path: `docs/${shots.menu}` });

  await page.locator('#overlay-action').click();
  check(`${label}: overlay hidden after start`, await page.locator('#overlay').isHidden());

  // Phase 1: let the generator build real track and confirm the run progresses.
  await page.waitForTimeout(1500);
  let snap = await page.evaluate(() => {
    const g = window.neonLaneRunner;
    return {
      phase: g.state.phase,
      distance: g.state.distance,
      score: g.state.score,
      obstacles: g.state.obstacles.length,
      coins: g.state.coins.length,
      frames: g.frames,
      hud: document.getElementById('score').textContent,
    };
  });
  // Assert the loop is advancing rather than hitting an arbitrary frame count:
  // headless rAF pacing varies with how many contexts are alive.
  const framePair = await page.evaluate(async () => {
    const first = window.neonLaneRunner.frames;
    await new Promise((r) => setTimeout(r, 300));
    return { first, second: window.neonLaneRunner.frames };
  });
  check(`${label}: frames render`,
    snap.frames > 10 && framePair.second > framePair.first,
    `${snap.frames} frames, +${framePair.second - framePair.first} in 300ms`);
  check(`${label}: distance advances`, snap.distance > 10, `${snap.distance.toFixed(1)} m`);
  check(`${label}: track populated`, snap.obstacles > 0 && snap.coins > 0,
    `${snap.obstacles} obstacles / ${snap.coins} coins`);
  check(`${label}: HUD reflects score`, snap.hud === String(snap.score), `hud=${snap.hud}`);
  await page.screenshot({ path: `docs/${shots.play}` });

  // Phase 2: clear the track so control checks are not cut short by a real crash.
  const clear = () => page.evaluate(() => {
    window.neonLaneRunner.state.obstacles = [];
    window.neonLaneRunner.state.nextSpawnZ = 1e6;
  });
  await clear();

  await page.keyboard.press('ArrowLeft');
  check(`${label}: left key changes lane`,
    (await page.evaluate(() => window.neonLaneRunner.state.player.targetLane)) === 0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  check(`${label}: right key changes lane`,
    (await page.evaluate(() => window.neonLaneRunner.state.player.targetLane)) === 2);

  await page.keyboard.press('Space');
  // Poll rather than sleep a fixed slice: frame pacing differs between viewports.
  const airborne = await page
    .waitForFunction(() => {
      const p = window.neonLaneRunner.state.player;
      return p.y > 0.2 && !p.grounded;
    }, null, { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  check(`${label}: jump leaves the ground`, airborne);
  await page.waitForFunction(() => window.neonLaneRunner.state.player.grounded,
    null, { timeout: 3000 });
  check(`${label}: jump lands again`,
    (await page.evaluate(() => window.neonLaneRunner.state.player.y)) === 0);

  await page.keyboard.press('ArrowDown');
  check(`${label}: slide lowers the runner`, await page.evaluate(() => {
    const p = window.neonLaneRunner.state.player;
    return p.sliding === true;
  }));
  await page.waitForTimeout(700);

  // Coins are collected on contact.
  const coinsBefore = await page.evaluate(() => {
    const s = window.neonLaneRunner.state;
    s.player.x = s.player.targetLane;
    s.player.lane = s.player.targetLane;
    s.coins = [{ id: 4242, lane: s.player.targetLane, z: 0, y: 0.6, collected: false }];
    return s.coinsCollected;
  });
  const gotCoin = await page
    .waitForFunction((before) => {
      const s = window.neonLaneRunner.state;
      return s.coinsCollected === before + 1 &&
        document.getElementById('coins').textContent === String(s.coinsCollected);
    }, coinsBefore, { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  check(`${label}: coin pickup increments the counter and the HUD`, gotCoin);

  // Pause / resume.
  await page.keyboard.press('KeyP');
  const paused = await page.evaluate(() => window.neonLaneRunner.state.phase);
  const frozen = await page.evaluate(async () => {
    const before = window.neonLaneRunner.state.distance;
    await new Promise((r) => setTimeout(r, 500));
    return window.neonLaneRunner.state.distance - before;
  });
  check(`${label}: pause freezes the run`, paused === 'paused' && frozen === 0,
    `phase=${paused} drift=${frozen}`);
  if (shots.pause) await page.screenshot({ path: `docs/${shots.pause}` });
  await page.keyboard.press('KeyP');
  check(`${label}: resume works`,
    (await page.evaluate(() => window.neonLaneRunner.state.phase)) === 'running');

  if (contextOptions.hasTouch) {
    // Swipes are delivered as pointer events; verify the gesture handler is wired.
    const swiped = await page.evaluate(async () => {
      const stage = document.getElementById('stage');
      const before = window.neonLaneRunner.state.player.targetLane;
      const opts = { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true };
      stage.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: 200, clientY: 400 }));
      stage.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: 90, clientY: 404 }));
      await new Promise((r) => setTimeout(r, 60));
      return { before, after: window.neonLaneRunner.state.player.targetLane };
    });
    check(`${label}: swipe left changes lane`, swiped.after === swiped.before - 1,
      JSON.stringify(swiped));
  }

  // Mute toggle persists to localStorage.
  await page.keyboard.press('KeyM');
  check(`${label}: mute persists`,
    (await page.evaluate(() => localStorage.getItem('neon-lane-runner:muted'))) === '1');
  await page.keyboard.press('KeyM');

  // Force a crash to exercise game over + best score + restart.
  await page.evaluate(() => {
    const s = window.neonLaneRunner.state;
    s.distance = 500;
    // Settle any in-flight lane change first: player.lane is a rounded position,
    // so mid-interpolation it can name the lane the runner is leaving.
    s.player.x = s.player.targetLane;
    s.player.lane = s.player.targetLane;
    // Clear the generated track so only the planted wall can end the run.
    s.obstacles = [{ id: 99999, kind: 'wall', lane: s.player.targetLane, z: 3,
      depth: 1.1, yMin: 0, yMax: 2.6 }];
    s.nextSpawnZ = 1e6;
  });
  await page.waitForFunction(() => window.neonLaneRunner.state.phase === 'over',
    null, { timeout: 5000 });
  const over = await page.evaluate(() => ({
    best: window.neonLaneRunner.state.best,
    stored: localStorage.getItem('neon-lane-runner:best'),
    title: document.getElementById('overlay-title').textContent,
  }));
  check(`${label}: game over shows and stores best`,
    over.best >= 500 && over.stored === String(over.best), JSON.stringify(over));
  if (shots.over) await page.screenshot({ path: `docs/${shots.over}` });

  await page.locator('#overlay-action').click();
  await page.waitForTimeout(400);
  snap = await page.evaluate(() => ({
    phase: window.neonLaneRunner.state.phase,
    distance: window.neonLaneRunner.state.distance,
    coins: window.neonLaneRunner.state.coinsCollected,
    best: window.neonLaneRunner.state.best,
  }));
  check(`${label}: restart resets the run and keeps best`,
    snap.phase === 'running' && snap.distance < 40 && snap.coins === 0 && snap.best >= 500,
    JSON.stringify(snap));

  check(`${label}: no console/page errors`, errors.length === 0, errors.join(' | '));
  await context.close();
}

await run('desktop', { viewport: { width: 1280, height: 800 } },
  { menu: 'screenshot-desktop-menu.png', play: 'screenshot-desktop-play.png',
    over: 'screenshot-desktop-gameover.png' });
await run('mobile', { ...devices['iPhone 13'], isMobile: true, hasTouch: true },
  { menu: 'screenshot-mobile-menu.png', play: 'screenshot-mobile-play.png' });

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
