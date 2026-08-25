/**
 * The no-horizontal-scrollbar contract.
 *
 * Horizontal scroll on a page like this is always a defect: it hides content
 * off an edge nobody looks at. This suite is deliberately exhaustive because
 * the failure is invisible in a screenshot — you have to notice the absence of
 * something — and because it only takes one long unbroken token to reintroduce.
 *
 * Covered: every width from a 280px watch-sized viewport to a 3440px
 * ultrawide, real device profiles with their own scale factors, both themes,
 * and every page kind the dashboard can be in.
 *
 * NOT covered, by design: elements that scroll inside themselves. A wide table
 * or a ten-node diagram lives in its own scroll container with edge fades, and
 * that is the intended behaviour. The assertion is about the PAGE.
 */

import { test, expect, devices } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PAGE = pathToFileURL(path.resolve('dist/index.html')).href;

const WIDTHS = [280, 320, 360, 390, 414, 430, 600, 768, 834, 1024, 1280, 1440, 1600, 1920, 2560, 3440];
const THEMES = ['dark', 'light'];

/** Every distinct kind of page this dashboard can show. */
const VIEWS = [
  { name: 'dashboard', hash: '' },
  { name: 'documented project', hash: '#project=yamini' },
  { name: 'derived project', hash: '#project=kwatch-leadq' },
  { name: 'platform project', hash: '#project=n8n-srv1340120' },
  { name: 'server', hash: '#server=srv1340120' },
  { name: 'workflow', hash: '#workflow=zNyAPupAI9GE1UYX' },
];

/**
 * How far the page scrolls sideways, measured three ways so a regression
 * cannot hide behind whichever one happens to round in its favour.
 */
const overflow = (page) => page.evaluate(() => {
  const doc = document.documentElement;
  return {
    doc: Math.max(0, doc.scrollWidth - doc.clientWidth),
    body: Math.max(0, document.body.scrollWidth - doc.clientWidth),
    visual: Math.max(0, Math.round((window.visualViewport?.width ?? 0) < doc.clientWidth
      ? 0 : doc.scrollWidth - (window.visualViewport?.width ?? doc.clientWidth))),
  };
});

/** The widest offending element, ignoring anything a parent already clips. */
const worstOffender = (page) => page.evaluate(() => {
  const limit = document.documentElement.clientWidth;
  const clipping = new Set(['hidden', 'auto', 'scroll', 'clip']);
  let worst = null;

  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (clipping.has(s.overflowX)) return true;
      if (s.position === 'fixed' && s.transform !== 'none') return true;
    }
    return false;
  };

  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    if (clipping.has(s.overflowX)) continue;
    if (s.position === 'fixed' && s.transform !== 'none') continue;
    if (clipped(el)) continue;

    const box = el.getBoundingClientRect();
    if (box.width === 0) continue;
    const past = box.right - limit;
    if (past > 1 && (!worst || past > worst.past)) {
      worst = {
        past: Math.round(past),
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().trim().split(/\s+/)[0] || el.id || '',
        text: (el.textContent || '').trim().slice(0, 60),
      };
    }
  }
  return worst;
});

async function load(page, hash, theme) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript((t) => {
    try { window.localStorage.setItem('kw-estate-theme', t); } catch (e) { /* ignore */ }
  }, theme);
  await page.goto(PAGE + hash);
  await page.waitForTimeout(60);
}

/* ------------------------------------------------- widths x themes x views */

for (const width of WIDTHS) {
  test(`no horizontal scroll at ${width}px, every view, both themes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });

    for (const theme of THEMES) {
      for (const view of VIEWS) {
        await load(page, view.hash, theme);
        const worst = await worstOffender(page);
        const measured = await overflow(page);
        expect(
          worst,
          `${width}px · ${theme} · ${view.name} — widest offender`,
        ).toBeNull();
        expect(measured.doc, `${width}px · ${theme} · ${view.name} — document`).toBe(0);
        expect(measured.body, `${width}px · ${theme} · ${view.name} — body`).toBe(0);
      }
    }
  });
}

/* ----------------------------------------------------------- real devices */

const PROFILES = [
  'iPhone SE',
  'iPhone 12',
  'iPhone 14 Pro Max',
  'Pixel 7',
  'Galaxy S9+',
  'iPad Mini',
  'iPad Pro 11',
];

for (const name of PROFILES) {
  const profile = devices[name];
  if (!profile) continue;

  test(`no horizontal scroll on ${name}`, async ({ browser }) => {
    const context = await browser.newContext({ ...profile });
    const page = await context.newPage();

    for (const view of VIEWS) {
      await load(page, view.hash, 'dark');
      expect(await worstOffender(page), `${name} · ${view.name}`).toBeNull();
      expect((await overflow(page)).doc, `${name} · ${view.name}`).toBe(0);
    }

    await context.close();
  });

  test(`no horizontal scroll on ${name}, landscape`, async ({ browser }) => {
    const context = await browser.newContext({
      ...profile,
      viewport: { width: profile.viewport.height, height: profile.viewport.width },
      isLandscape: true,
    });
    const page = await context.newPage();
    await load(page, '#server=srv1340120', 'light');
    expect(await worstOffender(page), `${name} landscape`).toBeNull();
    expect((await overflow(page)).doc).toBe(0);
    await context.close();
  });
}

/* ------------------------------------------------------------ interactions */

test('search results do not overflow at any width', async ({ page }) => {
  for (const width of [280, 360, 768, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await load(page, '', 'dark');
    // A long query with no spaces is the classic way to blow out a layout.
    for (const q of ['yamini', 'srv1340120', 'kw-collect-srv1340120-2026-08-24T1203']) {
      await page.locator('#search').fill(q);
      await page.waitForTimeout(50);
      expect(await worstOffender(page), `${width}px search "${q}"`).toBeNull();
      expect((await overflow(page)).doc, `${width}px search "${q}"`).toBe(0);
    }
  }
});

test('opening every workflow group does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await load(page, '', 'dark');
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach((d) => { d.open = true; });
  });
  await page.waitForTimeout(80);
  expect(await worstOffender(page), 'all details open at 360px').toBeNull();
  expect((await overflow(page)).doc).toBe(0);
});

test('expanding every table view does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await load(page, '#project=yamini', 'light');
  await page.evaluate(() => {
    document.querySelectorAll('.table-view').forEach((d) => { d.open = true; });
  });
  await page.waitForTimeout(80);
  expect(await worstOffender(page), 'table views open at 320px').toBeNull();
  expect((await overflow(page)).doc).toBe(0);
});

test('a hover card near the right edge stays on screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await load(page, '#project=yamini', 'dark');

  // .term exists in every project panel, most of which are display:none.
  // Scope to the one actually on screen.
  const terms = page.locator('[data-panel="project:yamini"] .term');
  const n = Math.min(await terms.count(), 6);

  for (let i = 0; i < n; i += 1) {
    const term = terms.nth(i);
    await term.scrollIntoViewIfNeeded();
    // Below 640px the card is a sheet pinned to the bottom of the viewport, so
    // it can sit over the next term. force skips the occlusion check, which is
    // about the pointer, not about what we are measuring here.
    await term.hover({ force: true });
    await page.waitForTimeout(60);

    await expect(term.locator('.term-card')).toBeVisible();
    expect(await worstOffender(page), `term ${i} hover card`).toBeNull();
    expect((await overflow(page)).doc, `term ${i} hover card`).toBe(0);

    await page.mouse.move(2, 2);
  }
});

/* ------------------------------------------------------ card detail */

test('cards carry virtualisation, OS and the next certificate renewal', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await load(page, '', 'dark');

  const spec = await page.locator('[data-open="server:srv1340120"] .server-spec').textContent();
  expect(spec).toMatch(/4 vCPU/);
  expect(spec).toMatch(/kvm/);
  expect(spec).toMatch(/Ubuntu 24\.04/);
  expect(spec).not.toMatch(/24\.04\.4/);   // patch level belongs on the detail page

  const cert = await page.locator('[data-open="server:srv1340120"] .cert-line').textContent();
  expect(cert).toMatch(/next renewal 34d/);
  expect(cert).toMatch(/leadq\.co\.in/);
  expect(cert).toMatch(/\d{4}-\d{2}-\d{2}/);
  // certbot issues one cert for several names; count certificates, not hostnames.
  expect(cert).toMatch(/\+7 more certificates/);
});

test('a server with no certificates shows no certificate line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await load(page, '', 'dark');
  await expect(page.locator('[data-open="server:srv1870078"] .cert-line')).toHaveCount(0);
});

test('the added detail does not reintroduce overflow', async ({ page }) => {
  for (const width of [280, 360, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await load(page, '', 'light');
    expect(await worstOffender(page), `${width}px with card detail`).toBeNull();
    expect((await overflow(page)).doc, `${width}px with card detail`).toBe(0);
  }
});

test('template imports get no page, so nothing links to one', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await load(page, '', 'dark');

  // 106 of 138 workflows are n8n demo templates. Rendering a page for each was
  // a third of the output; they are listed but not linked.
  const links = await page.locator('[data-open^="workflow:"]').count();
  const panels = await page.locator('[data-panel^="workflow:"]').count();
  expect(panels).toBeLessThan(40);
  expect(panels).toBeGreaterThan(20);

  // Every link must resolve to a panel that exists.
  const dangling = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('[data-open^="workflow:"]')) {
      const key = a.getAttribute('data-open');
      if (!document.querySelector(`[data-panel="${CSS.escape(key)}"]`)) out.push(key);
    }
    return out;
  });
  expect(dangling, 'links pointing at a page that was not rendered').toEqual([]);
  expect(links).toBeGreaterThan(0);
});
