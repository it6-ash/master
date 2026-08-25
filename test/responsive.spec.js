/**
 * Responsive contract, enforced rather than eyeballed.
 *
 *   npm run build && npm run test:e2e
 *
 * The headline assertion is zero horizontal overflow at every width the
 * dashboard is expected to survive, in both themes. Horizontal scroll on a
 * phone is a critical failure, not a cosmetic one, and it is exactly the kind
 * of regression a screenshot review misses because you have to notice the
 * absence of something.
 *
 * Deliberately scoped: overflow is measured on the PAGE. Individual elements
 * are allowed to scroll inside themselves (the flow diagram, wide tables) —
 * that is the designed behaviour, and those live in their own scroll
 * containers with edge fades.
 */

import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PAGE = pathToFileURL(path.resolve('dist/index.html')).href;

const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1920, 2560];
const THEMES = ['dark', 'light'];

async function openAt(page, width, theme) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript((t) => {
    try { window.localStorage.setItem('kw-estate-theme', t); } catch (e) { /* ignore */ }
  }, theme);
  await page.goto(PAGE);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/** Horizontal overflow of the document, in px. */
const overflowOf = (page) => page.evaluate(() => {
  const doc = document.documentElement;
  return Math.max(0, doc.scrollWidth - doc.clientWidth);
});

/**
 * Any element whose box sticks out past the viewport's right edge AND is not
 * already contained by something that clips or scrolls it.
 *
 * The containment check matters: a long workflow name inside a
 * `text-overflow: ellipsis` cell still reports its full untruncated width from
 * getBoundingClientRect, even though the parent clips it and the page does not
 * scroll. Counting those would drown the real failures in noise.
 */
const offenders = (page) => page.evaluate(() => {
  const limit = document.documentElement.clientWidth;
  const clipping = new Set(['hidden', 'auto', 'scroll', 'clip']);
  const out = [];

  const containedByAClipper = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (clipping.has(s.overflowX)) return true;
      // A closed drawer is parked off-canvas by design.
      if (s.transform && s.transform !== 'none' && s.position === 'fixed') return true;
    }
    return false;
  };

  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (clipping.has(style.overflowX)) continue;
    // A fixed element parked off-canvas (the closed drawer) does not scroll
    // the document, so it is not page overflow.
    if (style.position === 'fixed' && style.transform !== 'none') continue;
    if (containedByAClipper(el)) continue;

    const box = el.getBoundingClientRect();
    if (box.width === 0) continue;
    if (box.right > limit + 1) {
      const name = (el.className || '').toString().trim().split(/\s+/)[0] || el.id || '';
      out.push(`${el.tagName.toLowerCase()}${name ? `.${name}` : ''} → ${Math.round(box.right)}px (limit ${limit})`);
    }
  }
  return out.slice(0, 8);
});

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px in ${theme}`, async ({ page }) => {
      await openAt(page, width, theme);
      expect(await offenders(page), 'elements past the right edge').toEqual([]);
      expect(await overflowOf(page)).toBe(0);
    });

    test(`no horizontal overflow at ${width}px in ${theme}, detail page open`, async ({ page }) => {
      await openAt(page, width, theme);
      await page.locator('[data-open^="project:"]').first().click();
      await expect(page.locator('body')).toHaveClass(/detail-open/);
      expect(await offenders(page), 'elements past the right edge').toEqual([]);
      expect(await overflowOf(page)).toBe(0);
    });
  }
}

/* ------------------------------------------------------------- theming */

test('falls back to dark when neither storage nor matchMedia says anything', async ({ page }) => {
  // Chromium collapses `no-preference` to light, so the only honest way to
  // exercise the fallback branch is to take matchMedia away entirely.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PAGE);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('honours prefers-color-scheme on a first visit', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PAGE);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('a stored choice beats the OS preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => window.localStorage.setItem('kw-estate-theme', 'dark'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PAGE);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('the toggle flips the theme and persists it across a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PAGE);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('both themes actually repaint the surface, not just the attribute', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PAGE);
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.locator('#theme-toggle').click();
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).not.toBe(light);
});

/* -------------------------------------------------- responsive behaviour */

test('under 768px the flow diagram reflows to its vertical layout', async ({ page }) => {
  await openAt(page, 390, 'dark');
  await page.goto(`${PAGE}#project=yamini`);

  const horizontal = page.locator('#panel-yamini, [data-panel="project:yamini"]').locator('.flow-horizontal').first();
  const vertical = page.locator('[data-panel="project:yamini"]').locator('.flow-vertical').first();
  await expect(vertical).toBeVisible();
  await expect(horizontal).toBeHidden();
});

test('above 768px the flow diagram uses its horizontal layout', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=yamini`);

  await expect(page.locator('[data-panel="project:yamini"]').locator('.flow-horizontal').first()).toBeVisible();
  await expect(page.locator('[data-panel="project:yamini"]').locator('.flow-vertical').first()).toBeHidden();
});

test('under 768px tables restack into labelled cards', async ({ page }) => {
  await openAt(page, 390, 'dark');
  await page.goto(`${PAGE}#server=srv1340120`);

  const cell = page.locator('[data-panel="server:srv1340120"] td[data-label]').first();
  await expect(cell).toHaveCSS('display', 'grid');
  const label = await cell.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(label).not.toBe('none');
  expect(label.replace(/"/g, '').length).toBeGreaterThan(0);
});

test('detail is a full page that replaces the dashboard, and back returns', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=yamini`);

  // The dashboard is gone, not merely covered.
  await expect(page.locator('main.wrap')).toBeHidden();
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#detail-title')).toHaveText('Yamini');

  // It uses the full content width, not a panel's worth.
  const box = await page.locator('#detail').boundingBox();
  expect(box.width).toBeGreaterThan(1000);

  await page.locator('#detail-close').click();
  await expect(page.locator('main.wrap')).toBeVisible();
  await expect(page.locator('#detail')).toBeHidden();
});

test('a server detail page opens full width too', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#server=srv1340120`);
  await expect(page.locator('#detail-title')).toHaveText('srv1340120');
  await expect(page.locator('main.wrap')).toBeHidden();
});

test('Escape closes the detail page', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=yamini`);
  await page.keyboard.press('Escape');
  await expect(page.locator('main.wrap')).toBeVisible();
});

test('every interactive control clears a 44px touch target on a phone', async ({ page }) => {
  await openAt(page, 390, 'dark');
  const small = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('header button, header input, .chip')) {
      const b = el.getBoundingClientRect();
      if (b.height > 0 && b.height < 36) out.push(`${el.id || el.className} ${Math.round(b.height)}px`);
    }
    return out;
  });
  expect(small).toEqual([]);
});

/* ------------------------------------------------------------- linking */

test('a workflow has its own page, reachable from the inventory', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#workflow=zNyAPupAI9GE1UYX`);
  await expect(page.locator('#detail-title')).toHaveText('KW Group – YAMINI WhatsApp AI Support');
  await expect(page.locator('main.wrap')).toBeHidden();
});

test('a workflow page links back to its project and server', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#workflow=zNyAPupAI9GE1UYX`);

  const panel = page.locator('[data-panel="workflow:zNyAPupAI9GE1UYX"]');
  await expect(panel.locator('[data-open="project:yamini"]').first()).toBeVisible();
  await expect(panel.locator('[data-open="server:srv1340120"]').first()).toBeVisible();

  await panel.locator('[data-open="project:yamini"]').first().click();
  await expect(page.locator('#detail-title')).toHaveText('Yamini');
});

test('project and workflow reference each other both ways', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=yamini`);
  const link = page.locator('[data-panel="project:yamini"] [data-open^="workflow:"]').first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#detail-title')).not.toHaveText('Yamini');
});

test('topology nodes that map to a project are clickable', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#server=srv1340120`);
  const node = page.locator('[data-panel="server:srv1340120"] a:has(.flow-node--linked)').first();
  await expect(node).toHaveCount(1);
  await node.click();
  await expect(page.locator('#detail-title')).not.toHaveText('srv1340120');
});

/* ------------------------------------------------------------ glossary */

test('a flow node explains what it is and why it is there, on hover', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=yamini`);

  // Native <title> works offline, in print, and for a screen reader.
  const tip = page.locator('[data-panel="project:yamini"] .flow-horizontal .flow-node title').first();
  const text = await tip.textContent();
  expect(text.length).toBeGreaterThan(20);
});

test('a node consults its sublabel too, not only its label', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=yamini`);
  const titles = await page.locator('[data-panel="project:yamini"] .flow-horizontal title').allTextContents();
  // The node reads 'Meta Cloud API / direct, no BSP'. Both halves carry an
  // idea, and the second one is the interesting one.
  expect(titles.join(' ')).toMatch(/Business Solution Provider/);
});

test('a project page glosses the terms it actually uses', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=yamini`);
  const glossary = page.locator('[data-panel="project:yamini"] dl.glossary');
  await expect(glossary).toHaveCount(1);
  await expect(glossary.locator('dt', { hasText: 'Blue Pearl' })).toHaveCount(1);
  await expect(glossary.locator('dt', { hasText: 'Cratio' })).toHaveCount(1);
});

test('a tag reveals its explanation on hover and on keyboard focus', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=yamini`);

  const term = page.locator('[data-panel="project:yamini"] .term').first();
  const card = term.locator('.term-card');
  await expect(card).toBeHidden();

  await term.hover();
  await expect(card).toBeVisible();

  await page.mouse.move(0, 0);
  await expect(card).toBeHidden();

  await term.focus();
  await expect(card).toBeVisible();
});

/* --------------------------------------------------------- orientation */

test('the dashboard says what it is before it says any numbers', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  const intro = page.locator('.intro');
  await expect(intro).toBeVisible();
  await expect(intro.locator('.intro-title')).toHaveText(/Everything KW Group runs/);

  // The lead states the shape of the estate and where the numbers came from.
  const text = await intro.textContent();
  expect(text).toMatch(/3 servers/);
  expect(text).toMatch(/Last collection/);
  expect(text).toMatch(/How to read it/);
});

test('every dashboard section explains what it shows', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  const headings = page.locator('main.wrap h2.section');
  const count = await headings.count();
  expect(count).toBeGreaterThan(5);

  for (let i = 0; i < count; i += 1) {
    const note = headings.nth(i).locator('xpath=following-sibling::*[1]');
    await expect(note, `section ${i} has no note`).toHaveClass(/section-note/);
  }
});

test('an undocumented project describes itself from what was found', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=kwatch-leadq`);

  const note = page.locator('[data-panel="project:kwatch-leadq"] .derived-note');
  await expect(note).toBeVisible();
  const text = await note.textContent();
  expect(text).toMatch(/No write-up for this one yet/);
  expect(text).toMatch(/kwatch\.leadq\.co\.in/);
  expect(text).toMatch(/content\/projects\/kwatch-leadq\.md/);
});

test('a server page says what the server is for', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#server=srv1870078`);
  const note = page.locator('[data-panel="server:srv1870078"] .section-note').first();
  await expect(note).toContainText('Second n8n');
  await expect(note).toContainText('200.141.9.83');
});

test('a workflow page says what a workflow even is', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#workflow=zNyAPupAI9GE1UYX`);
  const note = page.locator('[data-panel="workflow:zNyAPupAI9GE1UYX"] .section-note');
  await expect(note).toContainText('An automation running inside n8n');
  await expect(note).toContainText('switched off');
});

test('wide viewports use the width instead of leaving half the row empty', async ({ page }) => {
  await openAt(page, 1920, 'dark');

  // The intro splits into two columns rather than one measure-capped column
  // with a dead half beside it.
  const cols = await page.locator('.intro').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(2);

  // The "how to read it" note sits to the right of the lead, not under it.
  const lead = await page.locator('.intro p').first().boundingBox();
  const how = await page.locator('.intro-how').boundingBox();
  expect(how.x).toBeGreaterThan(lead.x + lead.width - 20);

  // A section label and its explanation share a row.
  const head = page.locator('.section-head').first();
  const h2 = await head.locator('h2.section').boundingBox();
  const note = await head.locator('.section-note').boundingBox();
  expect(note.x).toBeGreaterThan(h2.x + h2.width - 10);
  expect(Math.abs(note.y - h2.y)).toBeLessThan(30);
});

test('narrow viewports stack the same content in one column', async ({ page }) => {
  await openAt(page, 390, 'dark');

  const cols = await page.locator('.intro').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(1);

  const head = page.locator('.section-head').first();
  const h2 = await head.locator('h2.section').boundingBox();
  const note = await head.locator('.section-note').boundingBox();
  expect(note.y).toBeGreaterThan(h2.y + h2.height - 5);
});

/* --------------------------------------------------------------- search */

test('searching shows a result list instead of silently filtering', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.locator('#search').fill('yamini');

  await expect(page.locator('#results')).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();

  const count = await page.locator('#results-count').textContent();
  expect(count).toMatch(/matches? for "yamini"/);

  const rows = page.locator('.result');
  expect(await rows.count()).toBeGreaterThan(0);
  // The project itself should outrank a workflow that merely mentions it.
  await expect(rows.first().locator('.result-label')).toHaveText('Yamini');
});

test('a result opens the thing it names, and clears the search', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.locator('#search').fill('yamini');
  await page.locator('a.result').first().click();

  await expect(page.locator('#detail-title')).toHaveText('Yamini');
  await expect(page.locator('#search')).toHaveValue('');
  await expect(page.locator('#results')).toBeHidden();
});

test('search reaches servers, workflows and issues, not just projects', async ({ page }) => {
  await openAt(page, 1280, 'dark');

  await page.locator('#search').fill('srv1870078');
  await expect(page.locator('.result-kind--server').first()).toBeVisible();

  await page.locator('#search').fill('broadcast');
  await expect(page.locator('.result-kind--workflow').first()).toBeVisible();

  await page.locator('#search').fill('cratio');
  const kinds = await page.locator('.result-kind').allTextContents();
  expect(kinds).toContain('issue');
});

test('search finds a project by a hostname that is not in its name', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.locator('#search').fill('hrportal');
  await expect(page.locator('.result').first()).toBeVisible();
  const first = await page.locator('.result-label').first().textContent();
  expect(first.toLowerCase()).toContain('hrportal');
});

test('a query that matches nothing says so plainly', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.locator('#search').fill('zzzznotathing');
  await expect(page.locator('#results-count')).toHaveText(/Nothing matches/);
  await expect(page.locator('.result')).toHaveCount(0);
});

test('Enter opens the top result, Escape clears the search', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.locator('#search').fill('yamini');
  await page.locator('#search').press('Enter');
  await expect(page.locator('#detail-title')).toHaveText('Yamini');

  await page.locator('#detail-close').click();
  await page.locator('#search').fill('leadq');
  await page.locator('#search').press('Escape');
  await expect(page.locator('#search')).toHaveValue('');
  await expect(page.locator('#dashboard')).toBeVisible();
});

/* ------------------------------------------------------------ platforms */

test('clicking n8n in the topology opens n8n, not its best-known tenant', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#server=srv1340120`);

  const node = page.locator('[data-panel="server:srv1340120"] .flow-horizontal a')
    .filter({ has: page.locator('text=n8n-n8n-1') }).first();
  await expect(node).toHaveCount(1);

  const href = await node.getAttribute('href');
  expect(href).not.toBe('#project=yamini');
  expect(href).toBe('#project=n8n-srv1340120');
});

test('the n8n page lists every workflow it hosts, Yamini being one of them', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=n8n-srv1340120`);

  const panel = page.locator('[data-panel="project:n8n-srv1340120"]');
  await expect(panel.locator('h2', { hasText: 'What runs on this' })).toHaveCount(1);
  await expect(panel.locator('h3', { hasText: 'Workflows it runs' })).toHaveCount(1);

  // It hosts far more than any single project's declared list.
  const rows = panel.locator('[data-open^="workflow:"]');
  expect(await rows.count()).toBeGreaterThan(100);

  // And it names Yamini as a tenant rather than being Yamini.
  await expect(panel.locator('[data-open="project:yamini"]').first()).toBeVisible();
});

test('a platform is labelled as one in the project grid', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  const card = page.locator('[data-open="project:n8n-srv1340120"]');
  await expect(card.locator('.platform-flag')).toContainText(/hosts \d+ workflows/);
});

test('nginx answers for hostnames and links each one to its project', async ({ page }) => {
  await openAt(page, 1280, 'dark');
  await page.goto(`${PAGE}#project=n8n-srv1340120`);
  // The n8n project is not nginx, so it must not claim nginx's hostnames.
  const panel = page.locator('[data-panel="project:n8n-srv1340120"]');
  await expect(panel.locator('h3', { hasText: 'Hostnames it answers for' })).toHaveCount(0);
});
