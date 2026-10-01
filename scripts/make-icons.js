#!/usr/bin/env node
'use strict';
// Renders the app icons from one SVG with Playwright (Chrome) into public/icons/:
// icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png (180) and favicon.svg.
//   node scripts/make-icons.js
// Playwright is not a project dependency; set PLAYWRIGHT to its path if it lives elsewhere.
const fs = require('fs');
const path = require('path');

const PW = process.env.PLAYWRIGHT || path.join(__dirname, '..', '..', '.tools', 'node_modules', 'playwright');
const { chromium } = require(PW);
const outDir = path.join(__dirname, '..', 'public', 'icons');

const INK = '#0C1719';
const AMBER = '#F4B740';
// The wolf's head against the moon, drawn on a 64-unit grid (same as #i-mark in index.html).
const MARK = `
  <circle cx="32" cy="32" r="30" fill="${AMBER}"/>
  <path fill="${INK}" d="M14 12l11 10.5h14L50 12l2.2 20.5L43 47l-11 8-11-8-9.2-14.5z"/>
  <path fill="${AMBER}" d="M21.5 33.5l7 2.2-1.6 3.1zM42.5 33.5l-7 2.2 1.6 3.1zM28.6 45.5h6.8L32 49.2z"/>`;

// Full-bleed square: night sky, a few stars, the mark inside the maskable safe zone.
function squareSvg(scale) {
  const size = 64 * scale;
  const offset = (64 - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><radialGradient id="g" cx="50%" cy="38%" r="70%"><stop offset="0" stop-color="#1D3A3F"/><stop offset="1" stop-color="${INK}"/></radialGradient></defs>
  <rect width="64" height="64" fill="url(#g)"/>
  <g fill="#ECF2EE" opacity=".55"><circle cx="9" cy="10" r=".7"/><circle cx="55" cy="8" r=".6"/><circle cx="57" cy="52" r=".7"/><circle cx="7" cy="50" r=".6"/></g>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${MARK}</g>
</svg>`;
}

const roundSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${MARK}</svg>`;

async function shoot(page, svg, px, file) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${px}" height="${px}" style="display:block"></body></html>`);
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: path.join(outDir, file), clip: { x: 0, y: 0, width: px, height: px }, omitBackground: true });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await shoot(page, squareSvg(0.78), 192, 'icon-192.png');
  await shoot(page, squareSvg(0.78), 512, 'icon-512.png');
  await shoot(page, squareSvg(0.66), 512, 'icon-maskable-512.png');
  await shoot(page, squareSvg(0.74), 180, 'apple-touch-icon.png');
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'favicon.svg'), roundSvg() + '\n');
  console.log(`Icons written to ${path.relative(process.cwd(), outDir)}`);
})().catch((e) => { console.error(e); process.exit(1); });
