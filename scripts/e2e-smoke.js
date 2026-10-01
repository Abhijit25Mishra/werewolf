'use strict';
// Plays one game through the real UI in headless Chrome against a running server, with bots
// filling the room, and screenshots every new screen. Needs Playwright (not a repo dependency):
//   PLAYWRIGHT=/path/to/node_modules/playwright URL=http://localhost:3000 node scripts/e2e-smoke.js
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || path.join(__dirname, '../../.tools/node_modules/playwright'));
const { Bot, mulberry32 } = require('../test/helpers/bot');

const URL = process.env.URL || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(__dirname, '../../.tmp/e2e');
const BOTS = Number(process.env.BOTS || 4);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const seen = new Set();
  const shot = async (name) => { await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const by = (id) => page.getByTestId(id);
  const visible = async (id) => (await by(id).count()) > 0 && by(id).first().isVisible();
  const confirmDialog = async () => { if (await visible('dialog-confirm')) await by('dialog-confirm').click(); };

  await page.goto(URL);
  await by('name-input').fill('Abhijit');
  await by('create-btn').click();
  await by('screen-lobby').waitFor({ timeout: 10000 });
  const code = (await by('room-code').innerText()).replace(/[^A-Z]/g, '');
  console.log(`room ${code}`);
  await shot('01-lobby');
  const bots = [];
  for (let i = 0; i < BOTS; i++) {
    const bot = new Bot(URL, `Bot ${i + 1}`, mulberry32(4242 + i), { flaky: 0, hold: false });
    const r = await bot.join(code);
    if (!r.ok) throw new Error(`bot ${i + 1} couldn't join: ${r.error}`);
    bots.push(bot);
  }
  await page.waitForTimeout(800);
  await shot('02-lobby-full');
  await by('ready-toggle').click();
  await by('screen-reveal').waitFor({ timeout: 20000 });
  await shot('03-reveal');
  const box = await by('role-card').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await shot('04-reveal-held');
  await page.mouse.up();
  await by('got-it').click();

  let step = 0;
  const started = Date.now();
  while (Date.now() - started < 8 * 60 * 1000) {
    step++;
    const screen = await page.locator('[data-testid^="screen-"]').first().getAttribute('data-testid').catch(() => null);
    if (screen && !seen.has(screen)) { seen.add(screen); await shot(`${String(seen.size + 4).padStart(2, '0')}-${screen.replace('screen-', '')}`); console.log(`screen: ${screen}`); }
    if (screen === 'screen-over') break;
    if (await visible('death-moment')) { await shot('death-moment'); await by('death-ok').click(); continue; }
    if (await visible('modal-confirm')) { await confirmDialog(); continue; }
    if (screen === 'screen-night' && (await visible('confirm-btn')) && !(await visible('night-done'))) {
      for (let tries = 0; tries < 3 && !(await by('confirm-btn').isEnabled()); tries++) {
        const tiles = page.locator('[data-testid^="tile-"]:not([aria-disabled="true"]):not([disabled])');
        const n = await tiles.count();
        if (n) await tiles.nth(Math.min(tries, n - 1)).click();
      }
      if (await by('confirm-btn').isEnabled()) await by('confirm-btn').click();
    } else if (screen === 'screen-day-discussion' && (await visible('host-start-vote'))) {
      await by('host-start-vote').click(); await confirmDialog();
    } else if (screen === 'screen-day-vote' && (await visible('vote-skip')) && (await by('vote-skip').getAttribute('aria-pressed')) !== 'true') {
      await by('vote-skip').click();
    } else if (screen === 'screen-day-verdict' && (await visible('host-next-night'))) {
      await by('host-next-night').click(); await confirmDialog();
    } else if (screen === 'screen-day-shot' && (await visible('shoot-btn'))) {
      await page.locator('[data-testid^="tile-"]').first().click();
      await by('shoot-btn').click();
    }
    await page.waitForTimeout(400);
  }
  await shot('99-final');
  const finalScreen = await page.locator('[data-testid^="screen-"]').first().getAttribute('data-testid').catch(() => null);
  const botAcks = bots.flatMap((b) => b.acks.filter((a) => !['NOT_ALLOWED', 'BAD_TARGET', 'RATE_LIMITED'].includes(a.code)).map((a) => `${b.name}: ${a.event} ${a.code}`));
  console.log(JSON.stringify({ finalScreen, screensSeen: [...seen], steps: step, pageErrors: errors.slice(0, 10), unexpectedBotAcks: botAcks.slice(0, 10) }, null, 2));
  bots.forEach((b) => b.close());
  await browser.close();
  process.exit(finalScreen === 'screen-over' && !errors.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
