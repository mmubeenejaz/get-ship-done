import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GSD = join(HERE, 'gsd.mjs');
const SANDBOX = mkdtempSync(join(tmpdir(), 'gsd-test-'));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

let counter = 0;
const freshDir = (name) => {
  const dir = join(SANDBOX, String(++counter), name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function project(files = { 'README.md': 'base\n' }) {
  const root = freshDir('proj');
  git(root, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function gsd(args, { cwd, home, input } = {}) {
  const result = spawnSync(process.execPath, [GSD, ...args], {
    cwd: cwd ?? SANDBOX,
    encoding: 'utf8',
    input,
    env: { ...process.env, ...GIT_IDENTITY, GSD_HOME: home ?? freshDir('home') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const today = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

test('log writes a card line to log.md and history.log', () => {
  const cwd = project();
  const home = freshDir('home');
  const result = gsd(['log', 's', 'card', 'T1', 'level=standard', 'builder=fable', 'first-pass=pass', 'commit=abc1234'], { cwd, home });
  assert.equal(result.status, 0, result.stderr);
  const line = `${today()} card T1 level=standard builder=fable first-pass=pass commit=abc1234`;
  assert.equal(readFileSync(join(home, 'proj', 's', 'log.md'), 'utf8'), `${line}\n`);
  assert.equal(readFileSync(join(home, 'proj', 'history.log'), 'utf8'), `s ${line}\n`);
});

test('log rejects a card line without level and writes nothing', () => {
  const cwd = project();
  const home = freshDir('home');
  const result = gsd(['log', 's', 'card', 'T1', 'builder=fable', 'first-pass=pass', 'commit=abc1234'], { cwd, home });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /level/);
  assert.match(result.stderr, /mechanical\|standard\|judgment/);
  assert.equal(existsSync(join(home, 'proj')), false);
});

const GUIDE = [
  '# Guide',
  '',
  '## Get Ship Done',
  '',
  '- gate: `npm run gate`',
  '- tests: `spec/**`, `src/**/*.check.ts`',
  '- deprecated: `src/legacy/**`',
  '- docs: `docs/modules/**`',
  '',
  'Prose in the section is ignored.',
  '',
  '## Other',
  '',
  '- gate: not this one',
  '',
].join('\n');

test('config prints the section keys as JSON', () => {
  const cwd = project({ 'AGENTS.md': GUIDE });
  const result = gsd(['config'], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    gate: 'npm run gate',
    tests: ['spec/**', 'src/**/*.check.ts'],
    deprecated: ['src/legacy/**'],
    docs: ['docs/modules/**'],
  });
});

test('config reads CLAUDE.md when AGENTS.md has no section', () => {
  const cwd = project({ 'AGENTS.md': '# Guide\n', 'CLAUDE.md': GUIDE });
  assert.equal(JSON.parse(gsd(['config'], { cwd }).stdout).gate, 'npm run gate');
});

test('config warns about a key it does not know', () => {
  const cwd = project({ 'AGENTS.md': '## Get Ship Done\n\n- gaet: `npm run gate`\n' });
  const result = gsd(['config'], { cwd });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /gaet/);
});

test('config without a section exits 1 naming setup', () => {
  const cwd = project();
  const result = gsd(['config'], { cwd });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/get-ship-done:setup/);
});

const CRITERIA = ['## Acceptance criteria', '', '1. First thing.', '2. Second thing.', ''];
const CARD = [
  '## Tasks',
  '',
  '### T1  Do the first thing        level: standard   after: none',
  'Files:      src/a.js (modify), src/b.js (new)',
  'Pattern:    src/a.js:1 (the existing handler)',
  'Interface:  none',
  'Covers:     1, 2',
  'Test first: a.test.js "does it"; given x, when y, expect z',
  'Done when:  npm test -> pass',
  "Don't:      touch c",
  'Stop if:    none',
  '',
];
const BRIEF = ['# Title', '', 'The `[NEEDS CLARIFICATION` rule is described here, not used.', '', ...CRITERIA, ...CARD].join('\n');

function lintProject() {
  return project({
    'src/a.js': 'export const a = 1;\n',
    'src/legacy/old.js': 'export const old = 1;\n',
    'AGENTS.md': '## Get Ship Done\n\n- deprecated: `src/legacy/**`\n',
  });
}

function lint(document, extraArgs = []) {
  const cwd = lintProject();
  const dir = freshDir('run');
  writeFileSync(join(dir, 'brief.md'), document);
  return gsd(['lint', join(dir, 'brief.md'), ...extraArgs], { cwd });
}

test('lint passes a valid brief', () => {
  const result = lint(BRIEF);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /lint: ok/);
});

const LINT_CASES = [
  ['an open clarification marker', (doc) => `${doc}\n[NEEDS CLARIFICATION: which one?]\n`, /brief\.md:\d+ needs-clarification: /],
  ['a document without cards', (doc) => doc.slice(0, doc.indexOf('### T1')), /no-cards: /],
  ['a card missing a field', (doc) => doc.replace(/^Stop if:.*\n/m, ''), /brief\.md:\d+ card-field-missing: .*Stop if/],
  ['an invalid level', (doc) => doc.replace('level: standard', 'level: easy'), /brief\.md:\d+ card-level: /],
  ['a Files entry without a marker', (doc) => doc.replace('src/b.js (new)', 'src/b.js'), /brief\.md:\d+ files-marker: /],
  ['a modify path that does not exist', (doc) => doc.replace('src/a.js (modify)', 'src/zzz.js (modify)'), /brief\.md:\d+ path-missing: .*src\/zzz\.js/],
  ['a Pattern path that does not exist', (doc) => doc.replace('src/a.js:1 (the', 'src/nope.js:1 (the'), /brief\.md:\d+ pattern-missing: .*src\/nope\.js/],
  ['a Pattern line past the end of the file', (doc) => doc.replace('src/a.js:1 (the', 'src/a.js:99 (the'), /brief\.md:\d+ pattern-missing: /],
  ['a deprecated Pattern', (doc) => doc.replace('src/a.js:1 (the', 'src/legacy/old.js:1 (the'), /brief\.md:\d+ pattern-deprecated: /],
  ['an uncovered criterion', (doc) => doc.replace('Covers:     1, 2', 'Covers:     1'), /brief\.md:\d+ criterion-uncovered: .*criterion 2/],
  ['a Covers number with no criterion', (doc) => doc.replace('Covers:     1, 2', 'Covers:     1, 2, 7'), /brief\.md:\d+ covers-unknown: .*7/],
];

for (const [name, mutate, expected] of LINT_CASES) {
  test(`lint fails on ${name} and names the fix`, () => {
    const result = lint(mutate(BRIEF));
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, expected);
    assert.match(result.stdout, / Fix: /);
  });
}

test('lint accepts a Pattern of none with a reason', () => {
  assert.equal(lint(BRIEF.replace('src/a.js:1 (the existing handler)', 'none: first file of its kind')).status, 0);
});

test('lint takes a plan\'s criteria from the sibling spec.md', () => {
  const cwd = lintProject();
  const dir = freshDir('run');
  writeFileSync(join(dir, 'spec.md'), ['# Spec', '', ...CRITERIA, '3. Third thing.', ''].join('\n'));
  writeFileSync(join(dir, 'plan.md'), ['# Plan', '', ...CARD].join('\n'));
  const result = gsd(['lint', join(dir, 'plan.md')], { cwd });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /spec\.md:\d+ criterion-uncovered: .*criterion 3/);
});

test('lint fails when it cannot find any criteria', () => {
  const result = lint(['# Plan', '', ...CARD].join('\n'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no-criteria: .* Fix: /);
});

test('lint lets a later card modify or copy a file an earlier card creates', () => {
  const second = CARD.slice(2)
    .join('\n')
    .replace('### T1', '### T2')
    .replace('src/a.js (modify), src/b.js (new)', 'src/b.js (modify)')
    .replace('src/a.js:1 (the existing handler)', 'src/b.js:1');
  const result = lint(`${BRIEF}\n${second}\n`);
  assert.equal(result.status, 0, result.stdout);
});
