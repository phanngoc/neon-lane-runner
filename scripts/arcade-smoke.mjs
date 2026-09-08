/**
 * Kiểm thử tích hợp platform Arcade — chạy trên bundle ĐANG ĐƯỢC PLATFORM PHỤC VỤ,
 * không phải server tĩnh tự dựng. Chứng minh đúng ba thứ mà `npm run smoke`
 * không chứng minh được, vì ở đó platform cố tình vắng mặt:
 *
 *   1. SDK bắt tay được với API thật (guest auth) -> ArcadeGame.ready
 *   2. điểm một lượt chơi thật đi vào leaderboard và đọc ngược ra được
 *   3. kỷ lục đi vào cloud save và quay về ở phiên sau (đổi máy vẫn còn)
 *
 * Dùng:  node scripts/arcade-smoke.mjs [baseUrl]
 * Mặc định http://127.0.0.1:8090/g/neon-lane-runner/
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8090/g/neon-lane-runner/').replace(/\/?$/, '/');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.neonLaneRunner, null, { timeout: 10_000 });

// 1. Bắt tay với API thật. Đây là chỗ phân biệt "có gọi SDK" với "SDK chạy được".
const handshake = await page
  .waitForFunction(() => window.ArcadeGame?.ready === true, null, { timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
const who = await page.evaluate(() => ({
  ready: window.ArcadeGame?.ready ?? false,
  playerId: window.ArcadeGame?.playerId ?? null,
}));
check('SDK bắt tay được với platform (guest auth)', handshake && !!who.playerId,
  JSON.stringify(who));
if (!handshake) {
  console.log('\nDừng sớm: không bắt tay được thì các cổng sau vô nghĩa.');
  await browser.close();
  process.exit(1);
}

// 2. Ép một lượt chơi kết thúc với điểm biết trước, rồi đọc ngược từ bảng.
const TARGET = 700 + Math.floor(Number(process.env.ARCADE_SMOKE_SALT ?? '0'));
await page.locator('#overlay-action').click();
await page.evaluate((target) => {
  const s = window.neonLaneRunner.state;
  s.distance = target;
  s.player.x = s.player.targetLane;
  s.player.lane = s.player.targetLane;
  s.obstacles = [{ id: 99999, kind: 'wall', lane: s.player.targetLane, z: 3,
    depth: 1.1, yMin: 0, yMax: 2.6 }];
  s.nextSpawnZ = 1e6;
}, TARGET);
await page.waitForFunction(() => window.neonLaneRunner.state.phase === 'over',
  null, { timeout: 8000 });
const runScore = await page.evaluate(() => window.neonLaneRunner.state.score);
check('lượt chơi kết thúc với điểm > 0', runScore > 0, `score=${runScore}`);

// Khớp cả playerId, KHÔNG chỉ khớp điểm: mỗi lần chạy test lại để lại đúng
// khoảng điểm đó trên bảng, nên "có ai đó điểm 702" là tự lừa mình — phải là
// CHÍNH lượt vừa chơi của CHÍNH người chơi này.
const onBoard = await page
  .waitForFunction(async (score) => {
    const me = window.ArcadeGame.playerId;
    const rows = await window.ArcadeGame.top('alltime', 100);
    return Array.isArray(rows) && rows.some((r) => r.score === score && r.playerId === me);
  }, runScore, { timeout: 15_000, polling: 700 })
  .then(() => true)
  .catch(() => false);
const board = await page.evaluate(() => window.ArcadeGame.top('alltime', 5));
check('điểm vào bảng alltime và đọc ngược ra được', onBoard,
  JSON.stringify(board?.slice?.(0, 3) ?? board));

const onDaily = await page
  .waitForFunction(async (score) => {
    const me = window.ArcadeGame.playerId;
    const rows = await window.ArcadeGame.top('daily', 100);
    return Array.isArray(rows) && rows.some((r) => r.score === score && r.playerId === me);
  }, runScore, { timeout: 10_000, polling: 700 })
  .then(() => true)
  .catch(() => false);
check('điểm vào bảng daily', onDaily);

// 3. Cloud save: nạp lại trang, kỷ lục phải quay về từ platform chứ không chỉ localStorage.
const best = await page.evaluate(() => window.neonLaneRunner.state.best);
await page.waitForTimeout(1200);          // để save.set kịp bay đi
// Chỉ xoá kỷ lục cục bộ, KHÔNG xoá cả localStorage: phiên guest của SDK
// (khoá "arcade:<gameId>") cũng nằm trong đó. Xoá sạch = thành người chơi mới,
// và khi đó save trống là đúng chứ không phải lỗi tích hợp.
await page.evaluate(() => localStorage.removeItem('neon-lane-runner:best'));
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.ArcadeGame?.ready === true, null, { timeout: 15_000 });
const restored = await page
  .waitForFunction((b) => window.neonLaneRunner.state.best >= b, best,
    { timeout: 10_000, polling: 500 })
  .then(() => true)
  .catch(() => false);
const after = await page.evaluate(() => ({
  best: window.neonLaneRunner.state.best,
  local: localStorage.getItem('neon-lane-runner:best'),
}));
check('kỷ lục quay về từ cloud save sau khi xoá localStorage', restored,
  `best=${best} -> ${JSON.stringify(after)}`);

check('không có lỗi console/page', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} cổng pass  (${BASE})`);
process.exit(failed.length === 0 ? 0 : 1);
