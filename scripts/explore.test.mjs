import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GSD = join(HERE, 'gsd.mjs');
const FIXTURE = join(HERE, 'fixtures', 'explore-app');
const NODE_MODULES = join(HERE, '..', 'node_modules');
const BROWSER = process.env.GSD_TEST_BROWSER ?? 'msedge';
const SKIP_KEY = 'explore-skip';
const SANDBOX = mkdtempSync(join(tmpdir(), 'gsd-explore-test-'));

let server;
let origin;
before(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname;
    if (path === '/500') {
      response.writeHead(500).end('planted server error');
      return;
    }
    const file = join(FIXTURE, path === '/' ? 'index.html' : path.slice(1));
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(SANDBOX, { recursive: true, force: true });
});

let counter = 0;
function exploreProject({ guide = '', withPlaywright = true, files = {} } = {}) {
  const root = join(SANDBOX, String(++counter));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), `# Project\n\n## Get Ship Done\n\n${guide}`);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  if (withPlaywright) symlinkSync(NODE_MODULES, join(root, 'node_modules'), 'junction');
  const git = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, head: git('rev-parse', 'HEAD').stdout.trim() };
}

function explore(args, { cwd, home = join(SANDBOX, `home-${++counter}`) } = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [GSD, 'explore', ...args], { cwd, env: { ...process.env, GSD_HOME: home }, timeout: 120000 }, (error, stdout, stderr) => {
      done({ status: error ? (error.code ?? 1) : 0, stdout, stderr, home });
    });
  });
}

const run = (page, extra = [], options = {}) => explore(['--url', `${origin}/${page}`, '--browser', BROWSER, '--seed', '7', '--time', '20', '--steps', '25', '--out', join(SANDBOX, `out-${++counter}`), ...extra], options);

test('explore reports an uncaught error from a planted button and never touches skipped controls', async () => {
  const { root } = exploreProject({ guide: `- ${SKIP_KEY}: \`.custom-skip\`\n` });
  const result = await run('index.html', [], { cwd: root });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^violation page-error \/index\.html: .*planted fault/m);
  assert.doesNotMatch(result.stdout, /skipped fault|example\.invalid/);
  assert.match(result.stdout, /^explore: \d+ steps, \d+ violations?, seed 7/m);
});

test('explore reports console errors, server errors, unnamed controls and overflow at phone width', async () => {
  const { root } = exploreProject();
  const result = await run('faults.html', ['--steps', '2'], { cwd: root });
  assert.equal(result.status, 1, result.stderr);
  for (const property of ['console-error', 'server-error', 'unnamed-control', 'overflow']) assert.match(result.stdout, new RegExp(`^violation ${property} /faults\\.html: `, 'm'), `${property} not reported:\n${result.stdout}`);
});

test('explore reports a blank page', async () => {
  const { root } = exploreProject();
  const result = await run('blank.html', ['--steps', '1'], { cwd: root });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^violation blank-page \/blank\.html: /m, result.stderr);
});

test('explore passes a clean page and runs the guide\'s project properties', async () => {
  const properties = "export default { 'has-heading': async (page) => ((await page.locator('h2').count()) === 0 ? 'no h2 heading' : undefined) };\n";
  const { root } = exploreProject({ guide: '- explore-properties: `properties.mjs`\n', files: { 'properties.mjs': properties } });
  const result = await run('clean.html', [], { cwd: root });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stdout.match(/^violation \S+/gm), ['violation has-heading']);
  const clean = await run('clean.html', [], { cwd: exploreProject().root });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /^explore: \d+ steps, 0 violations, seed 7/m);
});

test('explore refuses a host that is not local unless the guide lists it', async () => {
  const refused = await explore(['--url', 'http://example.com/'], { cwd: exploreProject().root });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /example\.com is not a local host.*Fix: .*explore-hosts/);
  const listed = await explore(['--url', 'http://example.com/'], { cwd: exploreProject({ guide: '- explore-hosts: `example.com`\n', withPlaywright: false }).root });
  assert.equal(listed.status, 1);
  assert.match(listed.stderr, /Playwright is not installed.*Fix: .*install/);
});

const traceOf = (stdout) => stdout.match(/^violation page-error .*\(trace (.+)\)$/m)?.[1];

test('replay reproduces a recorded violation, and shrink keeps only the actions it needs', async () => {
  const { root } = exploreProject();
  const found = await run('index.html', [], { cwd: root });
  const trace = traceOf(found.stdout);
  assert.ok(trace && existsSync(trace) && existsSync(trace.replace(/\.json$/, '.png')), found.stdout);
  const recorded = JSON.parse(readFileSync(trace, 'utf8'));
  assert.equal(recorded.seed, 7);
  assert.equal(recorded.violation.property, 'page-error');

  const replayed = await explore(['--replay', trace, '--browser', BROWSER], { cwd: root });
  assert.equal(replayed.status, 1, replayed.stderr);
  assert.match(replayed.stdout, /^violation page-error \/index\.html: .*planted fault/m);
  assert.match(replayed.stdout, /^replay: reproduced page-error/m);

  const shrunk = await explore(['--replay', trace, '--browser', BROWSER, '--shrink'], { cwd: root });
  assert.equal(shrunk.status, 1, shrunk.stderr);
  const file = shrunk.stdout.match(/^shrink: \d+ to (\d+) actions, trace (.+)$/m);
  assert.ok(file, shrunk.stdout);
  const { actions } = JSON.parse(readFileSync(file[2], 'utf8'));
  assert.deepEqual(actions.map((action) => action.target ?? action.type), ['goto', '#break']);
});

test('replay of a file that is not a trace exits 1 and names the fix', async () => {
  const { root } = exploreProject({ files: { 'bad.json': '{}' } });
  const result = await explore(['--replay', 'bad.json'], { cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bad\.json is not an explore trace\. Fix: /);
});

test('explore with --slug logs an explore line with HEAD and keeps the findings in the run folder', async () => {
  const { root, head } = exploreProject();
  const result = await explore(['--url', `${origin}/faults.html`, '--browser', BROWSER, '--seed', '3', '--steps', '1', '--slug', 's'], { cwd: root });
  assert.equal(result.status, 1, result.stderr);
  const runDir = join(result.home, basename(root), 's');
  assert.match(readFileSync(join(runDir, 'log.md'), 'utf8'), new RegExp(`^\\d{4}-\\d{2}-\\d{2} explore fail steps=1 violations=\\d+ seed=3 head=${head}\\n$`));
  const findings = JSON.parse(readFileSync(join(runDir, 'explore.json'), 'utf8'));
  assert.ok(findings.some((finding) => finding.rule === 'console-error' && finding.where === '/faults.html'), JSON.stringify(findings));
  assert.ok(result.stdout.includes(`(trace ${join(runDir, 'explore')}`), result.stdout);
});
