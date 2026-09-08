/**
 * Captures the acceptance viewports at menu / play / game-over from a built
 * bundle, so a change can be compared against the same scene and seed.
 *
 * Usage: node scripts/shots.mjs <dist-dir> <out-dir> <label>
 *
 * The seed is pinned and the run is advanced by a fixed number of simulation
 * steps, so the same command on two builds produces the same world state and
 * the images differ only by what the change actually did.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const [distArg, outArg, label = 'shot'] = process.argv.slice(2);
const ROOT = resolve(distArg ?? 'dist') + '/';
const OUT = resolve(outArg ?? 'docs/shots');
const PORT = 4327;

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
await mkdir(OUT, { recursive: true });

/** Named in the mobile acceptance criteria, plus landscape and desktop. */
const VIEWPORTS = [
  { id: '360x640', width: 360, height: 640, dpr: 2, touch: true },
  { id: '390x844', width: 390, height: 844, dpr: 2, touch: true },
  { id: '430x932', width: 430, height: 932, dpr: 2, touch: true },
  { id: '844x390', width: 844, height: 390, dpr: 2, touch: true },
  { id: '1280x800', width: 1280, height: 800, dpr: 1, touch: false },
];

/** Fixed seed and target distance so both builds render the same world. */
const SEED = 20260908;
const TARGET_M = 40;

const browser = await chromium.launch();
const report = [];

for (const v of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.dpr,
    hasTouch: v.touch,
    isMobile: v.touch,
    // Chromium reports the requested DPR; the game caps its own backing store
    // at 2, which is what the render-scale check below verifies.
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.neonLaneRunner?.frames > 2);

  await page.screenshot({ path: join(OUT, `${label}-${v.id}-1-menu.png`) });

  // Deterministic scene: pin the seed, then advance the simulation by hand.
  await page.evaluate((seed) => {
    const g = window.neonLaneRunner;
    g.primary();
    g.state.seed = seed;
    g.state.obstacles.length = 0;
    g.state.coins.length = 0;
    // Respect the warm-up grace distance: seeding the first row at z = 0 would
    // drop a hazard on top of the runner.
    g.state.nextSpawnZ = 30;
    g.state.distance = 0;
    g.state.elapsed = 0;
  }, SEED);
  // Test scaffolding, not gameplay: a pilot reads the public state and answers
  // each hazard through the public input path, driven by the page's own frame
  // loop. That keeps it runnable against the baseline build too, which has no
  // stepping hook, so before/after use the identical procedure.
  const played = await page.evaluate(
    (targetM) =>
      new Promise((done) => {
        const g = window.neonLaneRunner;
        const s = g.state;
        const tick = () => {
          if (s.phase !== 'running') return done({ alive: false, m: Math.round(s.distance) });
          if (s.distance >= targetM) return done({ alive: true, m: Math.round(s.distance) });

          const bodies = s.obstacles.filter((o) => o.z + o.depth > -0.6);
          // Lanes the runner is level with right now. Sliding sideways into one
          // is fatal whatever its kind, so these are never move targets.
          const alongside = new Set();
          for (const o of bodies) if (o.z < 0.6) alongside.add(o.lane);

          const upcoming = bodies.filter((o) => o.z > 0.6);
          const nearZ = upcoming.length ? Math.min(...upcoming.map((o) => o.z)) : Infinity;
          const row = upcoming.filter((o) => o.z < nearZ + 2.5 && o.z < 26);
          const blocked = new Set(alongside);
          // Only commit to the next row once clear of the current one; steering
          // early is what made the pilot swerve into a hurdle it was level with.
          if (nearZ < 9) {
            for (const o of row) if (o.kind === 'wall' || o.kind === 'tram') blocked.add(o.lane);
          }

          const here = s.player.targetLane;
          if (blocked.has(here)) {
            const free = [1, 0, 2].find((l) => !blocked.has(l));
            if (free !== undefined) g.input(free < here ? 'left' : 'right');
          } else {
            const near = row.filter((o) => o.lane === here && o.z < 3.6);
            if (near.some((o) => o.kind === 'hurdle') && s.player.grounded) g.input('jump');
            else if (near.some((o) => o.kind === 'beam') && !s.player.sliding) g.input('slide');
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    TARGET_M,
  );
  if (!played.alive) {
    console.log(`  ! pilot died at ${played.m} m on ${v.id}; play shot is not mid-run`);
  }
  await page.waitForTimeout(120);

  const metrics = await page.evaluate(() => {
    const g = window.neonLaneRunner;
    const c = document.getElementById('scene');
    const rect = c.getBoundingClientRect();
    const overflow =
      document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const small = [];
    const unreachable = [];
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    for (const b of document.querySelectorAll('button')) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (getComputedStyle(b).display === 'none') continue;
      const id = b.id || b.className;
      if (r.width < 44 || r.height < 44) {
        small.push(`${id}=${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      // A width check alone cannot see a control pushed past the edge or
      // covered by another layer, so probe the point a thumb would land on.
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) {
        unreachable.push(`${id}=offscreen(${Math.round(r.left)},${Math.round(r.top)})`);
        continue;
      }
      const hit = document.elementFromPoint(cx, cy);
      if (hit !== b && !b.contains(hit)) {
        unreachable.push(`${id}=covered-by-${hit?.id || hit?.tagName}`);
      }
    }
    return {
      phase: g.state.phase,
      distance: Math.round(g.state.distance),
      pilotAlive: g.state.phase === 'running',
      score: g.state.score,
      renderScale: +(c.width / rect.width).toFixed(2),
      horizontalOverflow: overflow,
      smallTargets: small,
      unreachableTargets: unreachable,
      liveParticles: g.renderer?.liveParticles?.() ?? null,
    };
  });
  await page.screenshot({ path: join(OUT, `${label}-${v.id}-2-play.png`) });

  // Game-over shot from a fresh run on the page's own clock. The card is built
  // by the frame loop when it observes the transition, so the run has to die
  // in real time rather than be stepped past from outside.
  await page.evaluate(() => window.neonLaneRunner.primary());
  await page.waitForFunction(
    () => window.neonLaneRunner.state.phase === 'over',
    null,
    { timeout: 90000 },
  );
  await page.waitForTimeout(250);
  const over = await page.evaluate(() => ({
    phase: window.neonLaneRunner.state.phase,
    title: document.getElementById('overlay-title')?.textContent,
    cause: window.neonLaneRunner.state.deathCause,
    near: window.neonLaneRunner.state.nearMisses,
  }));
  await page.screenshot({ path: join(OUT, `${label}-${v.id}-3-over.png`) });

  report.push({ viewport: v.id, ...metrics, over, errors });
  console.log(
    `${v.id}  dprCap=${metrics.renderScale}  overflow=${metrics.horizontalOverflow}px  ` +
      `small=${metrics.smallTargets.length ? metrics.smallTargets.join(',') : 'none'}  ` +
      `unreachable=${metrics.unreachableTargets.length ? metrics.unreachableTargets.join(',') : 'none'}  ` +
      `over="${over.title}" cause=${over.cause}  errors=${errors.length}`,
  );
  await context.close();
}

await writeFile(join(OUT, `${label}-report.json`), JSON.stringify(report, null, 2));
await browser.close();
server.close();
console.log(`\nwrote ${OUT}/${label}-*.png`);
