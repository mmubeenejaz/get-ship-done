import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.localhost)$/i;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 375, height: 812 };
const SETTLE_MS = 150;
const BACK_CHANCE = 0.1;
const FILL_VALUES = ['', 'a', 'Test value', '0', '-1', '9999999999', 'x'.repeat(300), `<b>&'"`, 'Zoë Ångström', 'user@example.com'];
const BROWSER_CHANNELS = [undefined, 'chrome', 'msedge'];
const NETWORK_ECHO = /^Failed to load resource\b/;

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function checkHost(url, allowed, fail) {
  const { hostname } = new URL(url);
  if (!LOCAL_HOST.test(hostname) && !allowed.includes(hostname)) {
    fail(`gsd explore: ${hostname} is not a local host, and explore never drives production. Fix: explore a local or staging copy; list a staging host under "- explore-hosts:" in the guide's Get Ship Done section.`);
  }
}

function loadPlaywright(root, fail) {
  const require = createRequire(join(root, 'package.json'));
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require(name);
    } catch {}
  }
  return fail('gsd explore: Playwright is not installed in this project. Fix: install it as a dev dependency (npm install -D playwright-core, or the same with your package manager; under Yarn PnP use nodeLinker: node-modules), then run it again.');
}

async function launch(playwright, channel, fail) {
  const errors = [];
  for (const candidate of channel ? [channel] : BROWSER_CHANNELS) {
    try {
      return await playwright.chromium.launch({ channel: candidate });
    } catch (error) {
      errors.push(`${candidate ?? 'bundled chromium'}: ${error.message.split('\n')[0]}`);
    }
  }
  return fail(`gsd explore: no browser launched (${errors.join('; ')}). Fix: pass --browser msedge or --browser chrome for an installed browser, set "- explore-browser:" in the guide, or run npx playwright install chromium.`);
}

function candidates(skip) {
  const cssPath = (element) => {
    const parts = [];
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.tagName === node.tagName) index++;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
    }
    return parts.join(' > ');
  };
  const actions = [];
  for (const element of document.querySelectorAll('a[href], button, input, select, textarea, summary, [role=button], [role=link]')) {
    if (element.disabled || element.closest('[data-explore=skip]') || skip.some((selector) => element.closest(selector))) continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || getComputedStyle(element).visibility === 'hidden') continue;
    const target = cssPath(element);
    if (element.tagName === 'A') {
      const link = new URL(element.href, location.href);
      if (element.hasAttribute('download') || (element.target && element.target !== '_self') || link.origin !== location.origin) continue;
    }
    if (element.tagName === 'INPUT') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'file' || type === 'hidden') continue;
      actions.push(['button', 'submit', 'reset', 'checkbox', 'radio', 'image'].includes(type) ? { type: 'click', target } : { type: 'fill', target });
    } else if (element.tagName === 'TEXTAREA') actions.push({ type: 'fill', target });
    else if (element.tagName === 'SELECT') element.options.length > 0 && actions.push({ type: 'select', target, options: [...element.options].map((option) => option.value) });
    else actions.push({ type: 'click', target });
  }
  return actions;
}

function pageFaults() {
  const named = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    const text = [
      element.getAttribute('aria-label'),
      labelledBy && labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '),
      element.getAttribute('title'),
      element.labels && [...element.labels].map((label) => label.textContent).join(' '),
      ['INPUT', 'TEXTAREA'].includes(element.tagName) ? element.getAttribute('placeholder') : null,
      element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type) ? element.value || element.type : null,
      element.tagName === 'INPUT' && element.type === 'image' ? element.alt : null,
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) ? null : element.textContent,
      ...[...element.querySelectorAll('img[alt], [aria-label]')].map((child) => child.getAttribute('alt') ?? child.getAttribute('aria-label')),
    ];
    return text.some((part) => part && part.trim());
  };
  const controls = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link]')];
  const unnamed = controls.filter((element) => element.getBoundingClientRect().width > 0 && !named(element)).map((element) => element.outerHTML.slice(0, 80));
  const blank = !document.body || (!document.body.innerText.trim() && !document.querySelector('img, svg, canvas, video, iframe, input, button'));
  return { unnamed, blank };
}

async function runProperties(file, root) {
  if (!file) return {};
  return (await import(pathToFileURL(resolve(root, file)).href)).default ?? {};
}

export async function explore({ url, seed, seconds, steps, start, skip, browser: channel, out, root, propertiesFile, state, fail }) {
  const playwright = loadPlaywright(root, fail);
  const properties = await runProperties(propertiesFile, root);
  const axe = (() => {
    try {
      return createRequire(join(root, 'package.json'))('@axe-core/playwright').default;
    } catch {
      return null;
    }
  })();
  const base = new URL(url);
  const routes = start.length > 0 ? start.map((path) => new URL(path, base).href) : [base.href];
  const random = seeded(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const browser = await launch(playwright, channel, fail);
  const violations = [];
  const seen = new Set();
  const checkedPages = new Set();
  const actions = [];
  let pending = [];
  try {
    const context = await browser.newContext({ viewport: DESKTOP, acceptDownloads: false, ...(state ? { storageState: resolve(root, state) } : {}) });
    const page = await context.newPage();
    context.on('page', (opened) => opened.close());
    const where = () => {
      try {
        return new URL(page.url()).pathname;
      } catch {
        return page.url();
      }
    };
    const sameOrigin = (address) => {
      try {
        return new URL(address).origin === base.origin;
      } catch {
        return false;
      }
    };
    const found = (property, message) => pending.push({ property, where: where(), message: message.split('\n')[0].slice(0, 200) });
    page.on('pageerror', (error) => found('page-error', error.message));
    page.on('console', (message) => message.type() === 'error' && !NETWORK_ECHO.test(message.text()) && found('console-error', message.text()));
    page.on('response', (response) => response.status() >= 500 && sameOrigin(response.url()) && found('server-error', `${response.status()} from ${new URL(response.url()).pathname}`));
    page.on('requestfailed', (request) => sameOrigin(request.url()) && !/ERR_ABORTED|NS_BINDING_ABORTED/.test(request.failure()?.errorText ?? '') && found('request-failed', `${request.failure()?.errorText} for ${new URL(request.url()).pathname}`));
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

    const settle = async () => {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(SETTLE_MS);
      if (!sameOrigin(page.url())) await page.goto(routes[0]).catch(() => {});
    };
    const checkPage = async () => {
      const path = where();
      if (checkedPages.has(path)) return;
      checkedPages.add(path);
      const { unnamed, blank } = await page.evaluate(pageFaults).catch(() => ({ unnamed: [], blank: false }));
      if (blank) found('blank-page', 'the page shows no text or media');
      for (const control of unnamed) found('unnamed-control', `no accessible name: ${control}`);
      await page.setViewportSize(PHONE);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
      if (overflow > 1) found('overflow', `${overflow}px wider than a ${PHONE.width}px phone screen`);
      await page.setViewportSize(DESKTOP);
      if (axe) {
        const report = await new axe({ page }).analyze().catch(() => ({ violations: [] }));
        for (const item of report.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact))) found('axe', `${item.id}: ${item.help}`);
      }
    };
    const record = async () => {
      await checkPage();
      for (const [name, property] of Object.entries(properties)) {
        const message = await Promise.resolve(property(page)).catch((error) => `the property threw: ${error.message}`);
        if (message) found(name, String(message));
      }
      for (const violation of pending) {
        const key = `${violation.property} ${violation.where} ${violation.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const name = `${violations.length + 1}-${violation.property}`;
        mkdirSync(out, { recursive: true });
        const trace = join(out, `${name}.json`);
        writeFileSync(trace, `${JSON.stringify({ url: routes[0], seed, viewport: DESKTOP, actions: [...actions], violation }, null, 2)}\n`);
        await page.screenshot({ path: join(out, `${name}.png`) }).catch(() => {});
        violations.push({ ...violation, trace });
      }
      pending = [];
    };
    const perform = async (action) => {
      actions.push(action);
      if (action.type === 'goto') await page.goto(action.url).catch((error) => found('request-failed', error.message));
      else if (action.type === 'back') await page.goBack().catch(() => {});
      else {
        const target = page.locator(action.target).first();
        if (action.type === 'click') await target.click({ timeout: 2000 }).catch(() => {});
        else if (action.type === 'fill') await target.fill(action.value, { timeout: 2000 }).catch(() => {});
        else await target.selectOption(action.value, { timeout: 2000 }).catch(() => {});
      }
      await settle();
      await record();
    };

    await perform({ type: 'goto', url: routes[0] });
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline && actions.length < steps) {
      const options = await page.evaluate(candidates, skip).catch(() => []);
      if (actions.length > 1 && random() < BACK_CHANCE) await perform({ type: 'back' });
      else if (options.length === 0) await perform({ type: 'goto', url: pick(routes) });
      else {
        const { options: values, ...chosen } = pick(options);
        if (chosen.type === 'fill') chosen.value = pick(FILL_VALUES);
        if (chosen.type === 'select') chosen.value = pick(values);
        await perform(chosen);
      }
    }
  } finally {
    await browser.close();
  }
  return { steps: actions.length, violations };
}
