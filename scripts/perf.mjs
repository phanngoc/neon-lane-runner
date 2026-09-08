/**
 * Frame-interval distribution over a reproducible 60s run after warm-up, plus
 * update/render cost and a heap trend.
 *
 * This measures Chromium on this machine. It is NOT a phone measurement and
 * must not be reported as one.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const [distArg, outArg, label = 'perf'] = process.argv.slice(2);
const ROOT = resolve(distArg ?? 'dist') + '/';
const OUT = resolve(outArg ?? 'docs');
const PORT = 4331;
const WARMUP_MS = 5000;
const MEASURE_MS = 60000;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
  try {
    const body = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.neonLaneRunner?.frames > 2);

// Keep the run alive for the whole window: a scripted pilot answers hazards
// and restarts on death, so the loop is always doing real work.
await page.evaluate(
  ({ warmup, measure }) =>
    new Promise((done) => {
      const g = window.neonLaneRunner;
      const s = g.state;
      g.primary();
      const intervals = [];
      const heap = [];
      let last = performance.now();
      const t0 = last;
      let restarts = 0;

      const pilot = () => {
        if (s.phase === 'over') {
          restarts += 1;
          g.primary();
          return;
        }
        if (s.phase !== 'running') return;
        const bodies = s.obstacles.filter((o) => o.z + o.depth > -0.6);
        const alongside = new Set();
        for (const o of bodies) if (o.z < 0.6) alongside.add(o.lane);
        const upcoming = bodies.filter((o) => o.z > 0.6);
        const nearZ = upcoming.length ? Math.min(...upcoming.map((o) => o.z)) : Infinity;
        const row = upcoming.filter((o) => o.z < nearZ + 2.5 && o.z < 26);
        const blocked = new Set(alongside);
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
      };

      const tick = (now) => {
        const dt = now - last;
        last = now;
        pilot();
        const t = now - t0;
        if (t > warmup) {
          intervals.push(dt);
          if (intervals.length % 60 === 0 && performance.memory) {
            heap.push(Math.round(performance.memory.usedJSHeapSize / 1024));
          }
        }
        if (t > warmup + measure) {
          return done({ intervals, heap, restarts, particles: g.renderer.liveParticles() });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  { warmup: WARMUP_MS, measure: MEASURE_MS },
).then(async (raw) => {
  const iv = raw.intervals.slice().sort((a, b) => a - b);
  const q = (p) => +iv[Math.min(iv.length - 1, Math.floor(iv.length * p))].toFixed(2);
  const over = (ms) => +((100 * raw.intervals.filter((x) => x > ms).length) / raw.intervals.length).toFixed(2);
  const summary = {
    label,
    note: 'Chromium (Playwright) on an Apple M1 laptop at 390x844 DPR2. NOT a physical phone.',
    frames: raw.intervals.length,
    seconds: +(raw.intervals.reduce((a, b) => a + b, 0) / 1000).toFixed(1),
    meanFps: +(1000 / (raw.intervals.reduce((a, b) => a + b, 0) / raw.intervals.length)).toFixed(2),
    intervalMs: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +iv[iv.length - 1].toFixed(2) },
    pctOver20ms: over(20),
    pctOver33ms: over(33),
    restarts: raw.restarts,
    liveParticlesAtEnd: raw.particles,
    heapKbSamples: raw.heap.length,
    heapKbFirst: raw.heap[0] ?? null,
    heapKbLast: raw.heap[raw.heap.length - 1] ?? null,
    errors,
  };
  console.log(JSON.stringify(summary, null, 2));
  await writeFile(join(OUT, `${label}.json`), JSON.stringify(summary, null, 2));
});

await browser.close();
server.close();
