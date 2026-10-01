#!/usr/bin/env node
'use strict';
// Screenshots every mock screen (public/mock/) at phone sizes and reports layout problems:
// horizontal scrolling, clipped text, tap targets under 44 px and console errors.
//   python3 -m http.server 4173 --directory public &
//   node scripts/shoot-mocks.js [baseUrl] [outDir] [onlyName,...]
// Playwright is not a project dependency; set PLAYWRIGHT to its path if it lives elsewhere.
const path = require('path');
const fs = require('fs');

const PW = process.env.PLAYWRIGHT || path.join(__dirname, '..', '..', '.tools', 'node_modules', 'playwright');
const { chromium } = require(PW);

const base = process.argv[2] || 'http://localhost:4173';
const out = process.argv[3] || path.join(__dirname, '..', '..', '.tmp', 'shots');
const only = process.argv[4] ? process.argv[4].split(',') : null;
const SIZES = [[390, 844], [360, 640]];

async function audit(page) {
  return page.evaluate(() => {
    const issues = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1) issues.push(`horizontal scroll: ${doc.scrollWidth}px wide`);
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[aria-hidden="true"], .sr-only, .sprite, svg')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.right > window.innerWidth + 1 && cs.position !== 'fixed' && !el.closest('.host-strip')) issues.push(`overflows right: ${el.className || el.tagName} (${Math.round(r.right)}px)`);
      const clips = cs.overflow !== 'visible' || cs.overflowX !== 'visible';
      const intended = cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none' || el.matches('.sheet-body, .card-front, .host-strip, .winner, .meter-scale, .tile-badge');
      if (clips && !intended && el.scrollWidth > el.clientWidth + 1 && el.textContent.trim()) issues.push(`clipped text: ${el.className || el.tagName}`);
      const interactive = el.matches('button, a[href], input, select, [role="switch"], [role="radio"]');
      if (interactive && !el.disabled && !el.closest('[inert]') && (r.width < 43.5 || r.height < 43.5) && !el.matches('.scrim')) {
        issues.push(`small target ${Math.round(r.width)}x${Math.round(r.height)}: ${el.dataset.testid || el.className || el.tagName}`);
      }
    }
    return Array.from(new Set(issues));
  });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const listPage = await browser.newPage();
  await listPage.goto(`${base}/?mock=list`, { waitUntil: 'networkidle' });
  await listPage.waitForSelector('[data-mock]');
  let names = await listPage.$$eval('[data-mock]', (els) => els.map((e) => e.dataset.mock));
  await listPage.screenshot({ path: path.join(out, 'list@390.png'), fullPage: true });
  await listPage.close();
  if (only) names = names.filter((n) => only.includes(n));
  const report = {};
  for (const [w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    for (const name of names) {
      errors.length = 0;
      await page.goto(`${base}/?mock=${encodeURIComponent(name)}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#app .screen');
      await page.evaluate(() => document.fonts && document.fonts.ready);
      await page.waitForTimeout(450);
      await page.screenshot({ path: path.join(out, `${name}@${w}.png`) });
      const tall = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 4);
      if (tall && w === 390) await page.screenshot({ path: path.join(out, `${name}@${w}-full.png`), fullPage: true });
      const issues = (await audit(page)).concat(errors);
      if (issues.length) report[`${name}@${w}`] = issues;
    }
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const n = Object.keys(report).length;
  console.log(`${names.length} mocks x ${SIZES.length} sizes -> ${out}`);
  console.log(n ? `${n} shots with issues:\n${JSON.stringify(report, null, 2)}` : 'No layout issues found.');
})().catch((e) => { console.error(e); process.exit(1); });
