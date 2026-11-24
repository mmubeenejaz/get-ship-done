import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CARD_FIELDS, COMMAND_NAMES, CONFIG_KEYS, PHASES } from './gsd.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GSD = join(HERE, 'gsd.mjs');
const SHIP_SKILL = readFileSync(join(HERE, '..', 'skills', 'ship', 'SKILL.md'), 'utf8');
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

function gsd(args, { cwd, home, input, env } = {}) {
  const result = spawnSync(process.execPath, [GSD, ...args], {
    cwd: cwd ?? SANDBOX,
    encoding: 'utf8',
    input,
    env: { ...process.env, ...GIT_IDENTITY, GSD_HOME: home ?? freshDir('home'), ...env },
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
  assert.match(result.stderr, /missing level/);
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

test('lint reads a Pattern whose note contains a comma', () => {
  assert.equal(lint(BRIEF.replace('(the existing handler)', '(the handler, simplified)')).status, 0);
});

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

const hiddenFromOwnDiffCheck = (...parts) => parts.join('');
const SLASHES = hiddenFromOwnDiffCheck('/', '/');
const HASH = String.fromCharCode(35);
const SKIP_CALL = `${hiddenFromOwnDiffCheck('it', '.', 'skip')}("a", () => {});\n`;
const FOCUS_CALL = `${hiddenFromOwnDiffCheck('describe', '.', 'only')}("a", () => {});\n`;
const SUPPRESSION = `${SLASHES} ${hiddenFromOwnDiffCheck('eslint', '-disable-next-line')} no-undef\nexport const a = b;\n`;
const PY_SUPPRESSION = `x = f()  ${HASH} ${hiddenFromOwnDiffCheck('type:', ' ', 'ignore')}\n`;
const LATER = hiddenFromOwnDiffCheck('TO', 'DO');
const LONG_DOC = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the guide.`).join('\n') + '\n';
const DOCS_GUIDE = '## Get Ship Done\n\n- docs: `docs/modules/**`\n';

function branch(changes, { guide, remove = [], rename, base = {} } = {}) {
  const cwd = project({
    'src/a.js': 'export const a = 1;\n',
    'src/a.test.js': 'test("a", () => {});\n',
    'docs/guide.md': LONG_DOC,
    ...(guide ? { 'AGENTS.md': guide } : {}),
    ...base,
  });
  git(cwd, 'switch', '-q', '-c', 'work');
  for (const [path, content] of Object.entries(changes)) write(cwd, path, content);
  for (const path of remove) rmSync(join(cwd, path));
  if (rename) git(cwd, 'mv', rename[0], rename[1]);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'work');
  return cwd;
}

const diffCheck = (cwd) => gsd(['diff-check', '--base', 'main'], { cwd });

const BLOCKING_CASES = [
  ['a skipped test', { 'src/a.test.js': SKIP_CALL }, {}, /^block\s+src\/a\.test\.js:1 test-skipped: /m],
  ['a focused test', { 'src/a.test.js': FOCUS_CALL }, {}, /^block\s+src\/a\.test\.js:1 test-focused: /m],
  ['a deleted test file', {}, { remove: ['src/a.test.js'] }, /^block\s+src\/a\.test\.js test-deleted: /m],
  ['a lint suppression', { 'src/a.js': SUPPRESSION }, {}, /^block\s+src\/a\.js:1 suppression-added: /m],
  ['a trailing type suppression', { 'tool.py': PY_SUPPRESSION }, {}, /^block\s+tool\.py:1 suppression-added: /m],
  ['a suppression in a trailing block comment', { 'src/a.ts': `foo(); /* ${hiddenFromOwnDiffCheck('eslint', '-disable-line')} no-console */\n` }, {}, /^block\s+src\/a\.ts:1 suppression-added: /m],
  ['a suppression in an unlisted extension', { 'src/a.mts': `${SLASHES} ${hiddenFromOwnDiffCheck('@ts-', 'nocheck')}\n` }, {}, /^block\s+src\/a\.mts:1 suppression-added: /m],
  ['a suppression without a space after the hash', { 'tool.py': `x = f()  ${HASH}${hiddenFromOwnDiffCheck('no', 'qa')}\n` }, {}, /^block\s+tool\.py:1 suppression-added: /m],
  ['a test skipped through its options', { 'src/a.test.js': `test("a", { ${hiddenFromOwnDiffCheck('skip', ': true')} }, () => {});\n` }, {}, /^block\s+src\/a\.test\.js:1 test-skipped: /m],
  ['a conditionally skipped test', { 'src/a.test.js': `${hiddenFromOwnDiffCheck('it', '.', 'skipIf')}(true)("a", () => {});\n` }, {}, /^block\s+src\/a\.test\.js:1 test-skipped: /m],
  ['a chained skip', { 'src/a.test.js': `${hiddenFromOwnDiffCheck('it', '.concurrent.', 'skip')}("a", () => {});\n` }, {}, /^block\s+src\/a\.test\.js:1 test-skipped: /m],
  ['a Go skip with a format', { 'pkg/a_test.go': `\t${hiddenFromOwnDiffCheck('t.', 'Skipf')}("later")\n` }, {}, /^block\s+pkg\/a_test\.go:1 test-skipped: /m],
  ['an expected-failure mark', { 'tests/test_a.py': `${hiddenFromOwnDiffCheck('@pytest.mark.', 'xfail')}\n` }, {}, /^block\s+tests\/test_a\.py:1 test-skipped: /m],
  ['a workaround comment', { 'src/a.js': `${SLASHES} ${LATER} tidy this later\nexport const a = 1;\n` }, {}, /^block\s+src\/a\.js:1 workaround-comment: /m],
  ['a "for now" comment', { 'src/a.js': `export const a = 2; ${SLASHES} fine for now\n` }, {}, /^block\s+src\/a\.js:1 workaround-comment: /m],
  ['a planning artifact', { 'docs/PLAN.md': '# Plan\n' }, {}, /^block\s+docs\/PLAN\.md planning-artifact: /m],
  ['a stray log file', { 'debug.log': 'x\n' }, {}, /^block\s+debug\.log stray-file: /m],
  ['a Markdown file outside the docs globs', { 'docs/feature-x.md': '# X\n' }, { guide: DOCS_GUIDE }, /^block\s+docs\/feature-x\.md doc-outside-docs: /m],
];

for (const [name, changes, options, expected] of BLOCKING_CASES) {
  test(`diff-check blocks ${name} and names the fix`, () => {
    const result = diffCheck(branch(changes, options));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, expected);
    assert.match(result.stdout, / Fix: /);
  });
}

const REVIEW_CASES = [
  ['a plain why-comment', { 'src/a.js': `${SLASHES} The vendor API returns seconds, not milliseconds.\nexport const a = 1;\n` }, {}, /^review\s+src\/a\.js:1 comment-added: /m],
  ['a new Markdown file when the guide has no docs key', { 'docs/feature-x.md': '# X\n' }, {}, /^review\s+docs\/feature-x\.md doc-added: /m],
  ['a rewritten Markdown file', { 'docs/guide.md': 'All new.\n' }, {}, /^review\s+docs\/guide\.md doc-rewritten: /m],
  ['an unchanged comment next to changed code', { 'src/b.js': `${SLASHES} Returns the total in cents.\nexport const total = 2;\n` }, { base: { 'src/b.js': `${SLASHES} Returns the total in cents.\nexport const total = 1;\n` } }, /^review\s+src\/b\.js:1 comment-near-change: /m],
];

for (const [name, changes, options, expected] of REVIEW_CASES) {
  test(`diff-check lists ${name} for review without failing`, () => {
    const result = diffCheck(branch(changes, options));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, expected);
  });
}

const LEGACY = { 'src/legacy/x.js': 'export const x = 1;\n', 'app/legacy/old.py': 'def f():\n    pass\n' };
const LEGACY_GUIDE = '## Get Ship Done\n\n- deprecated: `src/legacy/**`, `app/legacy/**`\n';
const legacyBranch = (changes) => branch(changes, { guide: LEGACY_GUIDE, base: LEGACY });

const DEPRECATED_IMPORTS = [
  ['a relative import', 'src/a.js', "import { x } from './legacy/x.js';"],
  ['an extensionless relative import', 'src/feature/b.ts', "import { x } from '../legacy/x';"],
  ['an alias import', 'src/feature/c.tsx', "import { x } from '@/legacy/x';"],
  ['a require call', 'src/d.cjs', "const { x } = require('./legacy/x');"],
  ['a re-export', 'src/e.js', "export * from './legacy/x.js';"],
  ['a Python dotted import', 'app/main.py', 'from app.legacy.old import f'],
  ['a relative Python import', 'app/api/views.py', 'from ..legacy import old'],
];

for (const [name, path, line] of DEPRECATED_IMPORTS) {
  test(`diff-check blocks ${name} of deprecated code`, () => {
    const result = diffCheck(legacyBranch({ [path]: `${line}\n` }));
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, new RegExp(`^block\\s+${path.replace(/\./g, '\\.')}:1 deprecated-import: .* Fix: `, 'm'));
  });
}

test('diff-check lets deprecated code import itself and lists the edit for review', () => {
  const result = diffCheck(legacyBranch({ 'src/legacy/y.js': "import { x } from './x.js';\n" }));
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^review src\/legacy\/y\.js:1 deprecated-edit: .* Fix: /m);
});

test('diff-check passes an import of current code next to deprecated code', () => {
  const result = diffCheck(legacyBranch({ 'src/a.js': "import { b } from './b.js';\nimport { legacyName } from './legacy-names.js';\n" }));
  assert.match(result.stdout, /^diff-check: 0 blocking, 0 review$/m);
});

test('deprecated lists each area with its importers, marks one with none ready to delete and deletes nothing', () => {
  const cwd = project({
    'AGENTS.md': '## Get Ship Done\n\n- deprecated: `src/legacy/**`, `app/legacy/**`, `old/**`\n',
    ...LEGACY,
    'src/legacy/y.js': "import { x } from './x.js';\n",
    'src/a.js': "export const a = 1;\nimport { x } from './legacy/x.js';\n",
    'app/main.py': 'import os\n',
  });
  const result = gsd(['deprecated'], { cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^area src\/legacy\/\*\* files=2 importers=1$/m);
  assert.match(result.stdout, /^ {2}importer src\/a\.js:2$/m);
  assert.match(result.stdout, /^area app\/legacy\/\*\* files=1 importers=0 ready-to-delete$/m);
  assert.match(result.stdout, /^area old\/\*\* files=0 stale-glob$/m);
  assert.match(result.stdout, /^deprecated: 3 areas, 1 ready-to-delete, 1 stale-glob$/m);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});

test('deprecated without a deprecated key names the fix', () => {
  const result = gsd(['deprecated'], { cwd: project() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no deprecated globs.*Fix: /);
});

const FAR_FILE = (value) => `${SLASHES} Returns the total in cents.\n${'export const filler = 0;\n'.repeat(8)}export const total = ${value};\n`;

test('diff-check leaves a comment far from changed code alone', () => {
  const result = diffCheck(branch({ 'src/b.js': FAR_FILE(2) }, { base: { 'src/b.js': FAR_FILE(1) } }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /comment-near-change/);
});

const SLOP_CASES = [
  ['ui-gradient', 'src/Hero.tsx', '<div className="bg-gradient-to-r from-purple-500 to-blue-500" />'],
  ['ui-gradient', 'src/app.css', '.hero { background: linear-gradient(90deg, #7c3aed, #2563eb); }'],
  ['ui-gradient-text', 'src/Hero.tsx', '<h1 className="bg-clip-text text-transparent">Plans</h1>'],
  ['ui-glass-glow', 'src/Card.tsx', '<div className="backdrop-blur-md" />'],
  ['ui-glass-glow', 'src/Card.vue', '<div class="shadow-lg shadow-purple-500/50" />'],
  ['ui-transition-all', 'src/app.css', '.card { transition: all 0.2s; }'],
  ['ui-looping-motion', 'src/Badge.tsx', '<span className="animate-pulse">Live</span>'],
  ['ui-hover-lift', 'src/Card.tsx', '<div className="hover:-translate-y-1" />'],
  ['ui-emoji', 'src/Badge.svelte', '<span>New ✨</span>'],
  ['ui-heavy-weight', 'src/Hero.tsx', '<h1 className="font-extrabold">Plans</h1>'],
  ['ui-tracked-caps', 'src/Label.tsx', '<p className="text-xs uppercase tracking-widest">Plans</p>'],
  ['ui-one-off-value', 'src/Card.tsx', '<div className="mt-[13px]" />'],
  ['ui-one-off-value', 'src/Card.jsx', '<div className="bg-[#7c3aed]" />'],
  ['ui-focus-removed', 'src/Button.tsx', '<button className="outline-none">Save</button>'],
  ['ui-hype-copy', 'src/index.html', '<p>A seamless way to plan your week</p>'],
  ['ui-fake-stat', 'src/Hero.tsx', '<p>Trusted by 10K+ teams</p>'],
  ['ui-default-font', 'src/app.scss', 'body { font-family: Inter, sans-serif; }'],
  ['ui-default-font', 'src/layout.tsx', 'const sans = Inter({ subsets: ["latin"] });'],
];

for (const [rule, path, line] of SLOP_CASES) {
  test(`diff-check lists ${rule} in ${path} for review: ${line}`, () => {
    const result = diffCheck(branch({ [path]: `${line}\n` }));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^review\\s+${path.replace(/\./g, '\\.')}:1 ${rule}: .+\\. Fix: `, 'm'));
  });
}

test('ui-audit lists slop in tracked UI files with a tally', () => {
  const cwd = project({
    'src/App.tsx': '<div className="transition-all">\n  <span>Ready ✨</span>\n</div>\n',
    'src/notes.md': 'transition-all\n',
    'src/server.js': 'export const css = "transition-all";\n',
    'src/App.test.tsx': 'render(<App label="Ready ✨" />);\n',
  });
  write(cwd, 'src/Scratch.tsx', '<div className="backdrop-blur" />\n');
  for (const args of [['src'], []]) {
    const result = gsd(['ui-audit', ...args], { cwd });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^review src\/App\.tsx:1 ui-transition-all: .+\. Fix: /m);
    assert.match(result.stdout, /^review src\/App\.tsx:2 ui-emoji: /m);
    assert.doesNotMatch(result.stdout, /Scratch|notes|server|App\.test/);
    assert.match(result.stdout, /^ui-audit rules: ui-emoji 1, ui-transition-all 1$/m);
    assert.match(result.stdout, /^ui-audit: 1 files, 2 findings$/m);
  }
});

test('ui-audit shows at most 50 findings and counts the rest', () => {
  const cwd = project({ 'src/app.css': '.a { transition: all 1s; }\n'.repeat(60) });
  const result = gsd(['ui-audit'], { cwd });
  assert.equal(result.stdout.match(/^review /gm).length, 51);
  assert.match(result.stdout, /^review \(10 more not shown\)$/m);
  assert.match(result.stdout, /^ui-audit: 1 files, 60 findings$/m);
});

test('ui-audit without a tracked UI file exits 1 and names the fix', () => {
  const result = gsd(['ui-audit', 'src'], { cwd: project() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no tracked UI file under src\. Fix: /);
});

const CLEAN_CASES = [
  ['a plain code change', { 'src/a.js': 'export const a = 2;\n' }, {}],
  ['a Markdown file inside the docs globs', { 'docs/modules/x.md': '# X\n' }, { guide: DOCS_GUIDE }],
  ['a new README', { 'src/README.md': '# Src\n' }, { guide: DOCS_GUIDE }],
  ['a suppression word in prose', { 'docs/guide.md': `${LONG_DOC}Avoid ${hiddenFromOwnDiffCheck('eslint', '-disable')} where you can.\n` }, {}],
  ['a renamed test file', {}, { rename: ['src/a.test.js', 'src/b.test.js'] }],
  ['a URL in code', { 'src/a.js': 'export const a = "https://example.com/x";\n' }, {}],
  ['slop words in Markdown', { 'docs/guide.md': `${LONG_DOC}Avoid bg-clip-text, transition-all and seamless copy.\n` }, {}],
  ['slop words in a script', { 'src/a.js': 'export const banned = ["transition-all", "backdrop-blur", "10K+"];\n' }, {}],
  ['emoji in a UI test fixture', { 'src/Form.test.tsx': 'const label = "How do you sleep? 😴";\n' }, {}],
  ['a programmatic focus target without an outline', { 'src/Summary.tsx': '<div ref={summary} tabIndex={-1} className="outline-none" />\n' }, {}],
  ['plain UI with tokens', { 'src/Footer.tsx': '<footer className="bg-primary text-sm font-bold uppercase">© 2026 <span className="animate-spin" /><a className="outline-none focus-visible:ring-2">Home</a></footer>\n' }, {}],
];

for (const [name, changes, options] of CLEAN_CASES) {
  test(`diff-check passes ${name}`, () => {
    const result = diffCheck(branch(changes, options));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^diff-check: 0 blocking, 0 review$/m);
  });
}

test('diff-check fails when git cannot produce the diff', () => {
  const cwd = branch({});
  git(cwd, 'switch', '-q', '--orphan', 'unrelated');
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'no shared history');
  const result = diffCheck(cwd);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /0 blocking/);
  assert.match(result.stderr, /could not read the diff.* Fix: /);
});

const SEARCH_FEATURE = ['# Search', '', 'Find a note by title.', '', 'Paths: `src/search/**`, `server/search.js`', 'Specs: `e2e/search.spec.js`', '', '## Sub-features', ''].join('\n');

function mappedBranch({ mapDir = 'docs/feature-map', guide } = {}) {
  const cwd = project({
    'src/search/index.js': 'export const s = 1;\n',
    'src/other/x.js': 'export const x = 1;\n',
    'src/other/x.test.js': 'test("x", () => {});\n',
    [`${mapDir}/README.md`]: '# Map\n',
    [`${mapDir}/search.md`]: SEARCH_FEATURE,
    ...(guide ? { 'AGENTS.md': guide } : {}),
  });
  git(cwd, 'switch', '-q', '-c', 'work');
  write(cwd, 'src/search/index.js', 'export const s = 2;\n');
  write(cwd, 'src/other/x.js', 'export const x = 2;\n');
  write(cwd, 'src/other/x.test.js', 'test("x2", () => {});\n');
  write(cwd, 'README.md', 'changed\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'work');
  return cwd;
}

test('features lists each touched feature with its specs and the unmapped source files', () => {
  const result = gsd(['features', '--base', 'main'], { cwd: mappedBranch() });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'feature docs/feature-map/search.md',
    '  spec e2e/search.spec.js',
    'unmapped src/other/x.js',
    'features: 1 touched, 1 unmapped',
  ]);
});

test('features omits a feature whose paths the branch does not touch', () => {
  const cwd = mappedBranch();
  git(cwd, 'switch', '-q', '-c', 'elsewhere', 'main');
  write(cwd, 'src/other/x.js', 'export const x = 3;\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'elsewhere');
  const result = gsd(['features', '--base', 'main'], { cwd });
  assert.deepEqual(result.stdout.trim().split('\n'), ['unmapped src/other/x.js', 'features: 0 touched, 1 unmapped']);
});

function mappedBranchWith(change) {
  const cwd = mappedBranch();
  git(cwd, 'switch', '-q', '-c', 'other-work', 'main');
  change(cwd);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'other work');
  return gsd(['features', '--base', 'main'], { cwd });
}

test('features lists the feature a file was moved out of', () => {
  const result = mappedBranchWith((cwd) => {
    mkdirSync(join(cwd, 'src/shared'), { recursive: true });
    git(cwd, 'mv', 'src/search/index.js', 'src/shared/find.js');
  });
  assert.match(result.stdout, /^feature docs\/feature-map\/search\.md$/m);
  assert.match(result.stdout, /^unmapped src\/shared\/find\.js$/m);
});

test('features lists a feature when only its spec changes', () => {
  const result = mappedBranchWith((cwd) => write(cwd, 'e2e/search.spec.js', 'test("s", () => {});\n'));
  assert.match(result.stdout, /^feature docs\/feature-map\/search\.md$/m);
});

test('features warns about a feature file without a Paths line', () => {
  const result = mappedBranchWith((cwd) => {
    write(cwd, 'docs/feature-map/export.md', '# Export\n\n**Paths:** src/export\n');
    write(cwd, 'src/other/x.js', 'export const x = 4;\n');
  });
  assert.match(result.stderr, /export\.md has no "Paths:" line.* Fix: /);
});

test('features reads the map folder named by the guide', () => {
  const cwd = mappedBranch({ mapDir: 'docs/map', guide: '## Get Ship Done\n\n- feature-map: `docs/map`\n' });
  assert.match(gsd(['features', '--base', 'main'], { cwd }).stdout, /^feature docs\/map\/search\.md$/m);
});

const SETUP_DIR = join(HERE, '..', 'skills', 'setup');
const readSetup = (...path) => readFileSync(join(SETUP_DIR, ...path), 'utf8');

test('the setup skill is user-invoked and writes only section keys gsd config knows', () => {
  const skill = readSetup('SKILL.md');
  assert.match(skill, /^disable-model-invocation: true$/m);
  const keys = [...skill.matchAll(/^- ([a-z][a-z-]*): /gm)].map((line) => line[1]);
  assert.ok(['gate', 'docs', 'feature-map', 'design'].every((key) => keys.includes(key)), `found keys: ${keys}`);
  for (const key of keys) assert.ok(CONFIG_KEYS.includes(key), `the setup skill writes unknown key "${key}"`);
});

test('the shipped example feature works as a feature map entry', () => {
  const example = readSetup('references', 'feature-map', 'example-feature.md');
  for (const heading of ['## Sub-features', '## How to reach it', '## Driving it', '## Gotchas']) assert.ok(example.includes(heading), `missing ${heading}`);
  const cwd = project({
    'src/search/index.js': 'export const s = 1;\n',
    'docs/feature-map/README.md': readSetup('references', 'feature-map', 'README.md'),
    'docs/feature-map/search.md': example,
  });
  git(cwd, 'switch', '-q', '-c', 'work');
  write(cwd, 'src/search/index.js', 'export const s = 2;\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'work');
  const result = gsd(['features', '--base', 'main'], { cwd });
  assert.match(result.stdout, /^feature docs\/feature-map\/search\.md\n  spec e2e\/search\.spec\.ts$/m);
});

test('features without a map exits 1 naming setup', () => {
  const result = gsd(['features', '--base', 'main'], { cwd: branch({}) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/get-ship-done:setup/);
});

test('diff-check rejects an unknown base ref and names the fix', () => {
  const result = gsd(['diff-check', '--base', 'nope'], { cwd: branch({}) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nope.* Fix: /);
});

const HISTORY = [
  'a 2026-11-01 intake ok lane=Standard base=origin/main@abc',
  'a 2026-11-01 card T1 level=standard builder=fable first-pass=pass commit=1',
  'a 2026-11-01 card T2 level=standard builder=fable first-pass=fail commit=2',
  'a 2026-11-01 card T3 level=mechanical builder=haiku first-pass=pass commit=3',
  'a 2026-11-01 note the gate needed one rerun',
  'a 2026-11-02 ship done pr=5 gate-first-pass=pass diff-check=pass',
  'a 2026-11-03 outcome merged pr=5',
  'b 2026-11-04 intake ok lane=Risky base=origin/main@def',
  'b 2026-11-05 ship done pr=6 gate-first-pass=fail diff-check=accepted',
  'b 2026-11-06 outcome reverted pr=6',
  'b 2026-11-07 ship pr=7',
  'this line is broken',
  '',
].join('\n');

test('stats reports first-pass rates, lanes, outcomes and unparsed lines', () => {
  const home = freshDir('home');
  write(home, 'proj/history.log', HISTORY);
  const result = gsd(['stats', 'proj'], { home });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'repo: proj',
    'runs by lane: Risky 1, Standard 1',
    'cards first-pass: mechanical/haiku 1/1 (100%), standard/fable 1/2 (50%)',
    'gate first-pass: 1/2 (50%)',
    'diff-check accepted: 1/2',
    'outcomes: merged 1, closed 0, reverted 1',
    'escapes: deploy 0, release 0, post-release 0',
    'checks added: none',
    'unparsed lines: 2',
  ]);
});

test('stats counts escapes by layer and lists the checks they added', () => {
  const home = freshDir('home');
  write(home, 'proj/history.log', ['a 2026-11-08 escape post-release pr=5 check=null-total-test', 'b 2026-11-09 escape deploy pr=6 check=health-smoke', 'b 2026-11-10 escape post-release pr=7 check=null-total-test', ''].join('\n'));
  const lines = gsd(['stats', 'proj'], { home }).stdout.split('\n');
  assert.ok(lines.includes('escapes: deploy 1, release 0, post-release 2'), lines.join('\n'));
  assert.ok(lines.includes('checks added: health-smoke, null-total-test'), lines.join('\n'));
});

test('stats uses the current repo and names the fix when there is no history', () => {
  const result = gsd(['stats'], { cwd: project() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /proj.* Fix: /);
});

const FAKE_GH = join(SANDBOX, 'fake-gh.mjs');
writeFileSync(
  FAKE_GH,
  [
    "import { readFileSync } from 'node:fs';",
    "const answers = JSON.parse(readFileSync(process.env.FAKE_GH_ANSWERS, 'utf8'));",
    "const answer = answers[process.argv.slice(2, 4).join(' ')];",
    'if (answer === undefined) process.exit(1);',
    'process.stdout.write(JSON.stringify(answer));',
  ].join('\n'),
);

function shipRun(changes = {}, { lane = 'Direct', lines = [], gh = () => ({}), files = {}, guide } = {}) {
  const cwd = branch(changes, { guide });
  const home = freshDir('home');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const runDir = join(home, 'proj', 's');
  for (const [name, content] of Object.entries(files)) write(runDir, name, content);
  write(runDir, 'log.md', [`2026-11-01 intake ok lane=${lane} base=main@${git(cwd, 'rev-parse', 'main')}`, ...lines, ''].join('\n'));
  const answers = join(freshDir('gh'), 'answers.json');
  writeFileSync(answers, JSON.stringify({ 'pr view': { state: 'OPEN', headRefOid: head, headRefName: 'work' }, 'run list': [], ...gh(head) }));
  const env = { GSD_GH: FAKE_GH, FAKE_GH_ANSWERS: answers };
  const ship = ({ gate = 'pass', diff = 'pass' } = {}) => gsd(['log', 's', 'ship', 'done', 'pr=5', `gate-first-pass=${gate}`, `diff-check=${diff}`], { cwd, home, env });
  return { cwd, home, head, env, ship, log: () => readFileSync(join(runDir, 'log.md'), 'utf8') };
}

const WHY_COMMENT = `${SLASHES} The vendor API returns seconds, not milliseconds.\nexport const a = 1;\n`;

function assertRefused(run, result, expected) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, expected);
  assert.doesNotMatch(run.log(), / ship /);
  assert.equal(existsSync(join(run.home, 'proj', 'history.log')), false);
}

test('ship logs a clean branch', () => {
  const run = shipRun({ 'src/a.js': 'export const a = 2;\n' });
  const result = run.ship();
  assert.equal(result.status, 0, result.stderr);
  assert.match(run.log(), / ship done pr=5 gate-first-pass=pass diff-check=pass\n$/);
});

test('ship refuses pass while diff-check blocks', () => {
  const run = shipRun({ 'src/a.test.js': SKIP_CALL });
  assertRefused(run, run.ship(), /^block\s+src\/a\.test\.js:1 test-skipped: .* Fix: /m);
});

test('ship refuses a review finding without a keep line and prints the command to keep it', () => {
  const run = shipRun({ 'src/a.js': WHY_COMMENT });
  assertRefused(run, run.ship(), /^review src\/a\.js:1 comment-added: [\s\S]*gsd log s keep ok at=src\/a\.js:1 rule=comment-added why=</m);
});

test('ship takes a review finding once a keep line names it', () => {
  const run = shipRun({ 'src/a.js': WHY_COMMENT }, { lines: ['2026-11-01 keep ok at=src/a.js:1 rule=comment-added why=external-api-units'] });
  assert.equal(run.ship().status, 0);
});

test('ship refuses a keep line for another place or rule', () => {
  const run = shipRun({ 'src/a.js': WHY_COMMENT }, { lines: ['2026-11-01 keep ok at=src/a.js:2 rule=comment-added why=moved', '2026-11-01 keep ok at=src/a.js:1 rule=doc-added why=wrong-rule'] });
  assertRefused(run, run.ship(), /keep ok at=src\/a\.js:1 rule=comment-added/);
});

test('ship refuses diff-check=accepted while a blocking finding has no accept line', () => {
  const run = shipRun({ 'src/a.test.js': SKIP_CALL });
  assertRefused(run, run.ship({ diff: 'accepted' }), /gsd log s accept ok at=src\/a\.test\.js:1 rule=test-skipped by=user/);
});

test('ship takes diff-check=accepted once the user accepted each blocking finding', () => {
  const run = shipRun({ 'src/a.test.js': SKIP_CALL }, { lines: ['2026-11-01 accept ok at=src/a.test.js:1 rule=test-skipped by=user'] });
  assert.equal(run.ship({ diff: 'accepted' }).status, 0);
});

test('ship refuses diff-check=pass when the user accepted every blocking finding', () => {
  const run = shipRun({ 'src/a.test.js': SKIP_CALL }, { lines: ['2026-11-01 accept ok at=src/a.test.js:1 rule=test-skipped by=user'] });
  assertRefused(run, run.ship(), /diff-check=pass but 1 findings block, each accepted by the user\. Fix: .*diff-check=accepted/);
});

test('ship refuses diff-check=accepted when nothing blocks', () => {
  const run = shipRun({ 'src/a.js': 'export const a = 2;\n' });
  assertRefused(run, run.ship({ diff: 'accepted' }), /nothing blocks.* Fix: .*diff-check=pass/);
});

const COVERED_CHANGE = { 'src/a.js': 'export const a = 1;\nexport const b = 2;\n', 'src/b.js': 'export const c = 3;\n', 'README.md': 'more\n' };
const LCOV = (sourceFile = 'src/a.js') => `TN:\nSF:${sourceFile}\nDA:1,4\nDA:2,0\nend_of_record\n`;
const coverage = (cwd, args = []) => gsd(['coverage', '--base', 'main', ...args], { cwd });

test('coverage lists a changed line with zero hits and a changed file missing from the report', () => {
  const cwd = branch(COVERED_CHANGE);
  write(cwd, 'coverage/lcov.info', LCOV());
  const result = coverage(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^review src\/a\.js:2 uncovered-line: .* Fix: /m);
  assert.match(result.stdout, /^review src\/b\.js:1 not-in-coverage: .* Fix: /m);
  assert.doesNotMatch(result.stdout, /src\/a\.js:1 |README/);
  assert.match(result.stdout, /^coverage: 1 uncovered-line, 1 not-in-coverage$/m);
});

test('coverage matches absolute Windows-style report paths and takes the report from the guide', () => {
  const cwd = branch(COVERED_CHANGE, { guide: '## Get Ship Done\n\n- lcov: `out/lcov.info`\n' });
  write(cwd, 'out/lcov.info', LCOV(`${git(cwd, 'rev-parse', '--show-toplevel')}/src/a.js`.replace(/\//g, '\\')));
  assert.match(coverage(cwd).stdout, /^review src\/a\.js:2 uncovered-line: /m);
});

test('coverage fails on a report older than HEAD and on a missing report', () => {
  const cwd = branch(COVERED_CHANGE);
  write(cwd, 'coverage/lcov.info', LCOV());
  const old = new Date('2020-01-01');
  utimesSync(join(cwd, 'coverage/lcov.info'), old, old);
  const stale = coverage(cwd);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /older than HEAD.*Fix: /);
  const missing = coverage(cwd, ['--lcov', 'nope.info']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no coverage report at nope\.info.*Fix: /);
});

test('ship refuses an uncovered changed line when the guide has coverage, until it is kept', () => {
  const guide = '## Get Ship Done\n\n- coverage: `npm run coverage`\n';
  const run = shipRun({ 'src/a.js': 'export const a = 1;\nexport const b = 2;\n' }, { guide });
  write(run.cwd, 'coverage/lcov.info', LCOV());
  assertRefused(run, run.ship(), /^review src\/a\.js:2 uncovered-line: [\s\S]*gsd log s keep ok at=src\/a\.js:2 rule=uncovered-line/m);
  const kept = shipRun({ 'src/a.js': 'export const a = 1;\nexport const b = 2;\n' }, { guide, lines: ['2026-11-01 keep ok at=src/a.js:2 rule=uncovered-line why=defensive-branch'] });
  write(kept.cwd, 'coverage/lcov.info', LCOV());
  const shipped = kept.ship();
  assert.equal(shipped.status, 0, shipped.stderr);
});

const CLEAN_CHANGE = { 'src/a.js': 'export const a = 2;\n' };
const ciRun = (headSha, conclusion, createdAt, status = 'completed') => ({ name: 'gate', headSha, status, conclusion, createdAt });

const GITHUB_REFUSALS = [
  ['a PR whose head is not HEAD', () => ({ 'pr view': { state: 'OPEN', headRefOid: 'f'.repeat(40), headRefName: 'work' } }), {}, /head is fffffff but HEAD is .* Fix: git push/],
  ['a PR that is not open', (head) => ({ 'pr view': { state: 'MERGED', headRefOid: head, headRefName: 'work' } }), {}, /PR #5 is merged, not open\. Fix: /],
  ['a PR gh cannot read', () => ({ 'pr view': undefined }), {}, /gh could not read PR #5\. Fix: /],
  ['runs gh cannot list', () => ({ 'run list': undefined }), {}, /gh could not list the workflow runs of work\. Fix: /],
  ['a failed run on HEAD', (head) => ({ 'run list': [ciRun(head, 'failure', '2026-11-01T10:00:00Z')] }), {}, /run "gate" on HEAD ended failure\. Fix: /],
  ['a branch whose runs have not reached HEAD yet', () => ({ 'run list': [ciRun('a'.repeat(40), 'success', '2026-11-01T10:00:00Z')] }), {}, /no workflow run on HEAD yet\. Fix: /],
  ['a run on HEAD still in progress', (head) => ({ 'run list': [ciRun(head, '', '2026-11-01T10:00:00Z', 'in_progress')] }), {}, /run "gate" on HEAD is in_progress\. Fix: /],
  [
    'gate-first-pass=pass when the first run failed',
    (head) => ({ 'run list': [ciRun(head, 'success', '2026-11-01T11:00:00Z'), ciRun('a'.repeat(40), 'failure', '2026-11-01T10:00:00Z')] }),
    {},
    /gate-first-pass=pass but the first gate runs, on aaaaaaa, failed\. Fix: .*gate-first-pass=fail/,
  ],
  ['gate-first-pass=fail when the first run passed', (head) => ({ 'run list': [ciRun(head, 'success', '2026-11-01T10:00:00Z')] }), { gate: 'fail' }, /gate-first-pass=fail but .* passed\. Fix: /],
];

for (const [name, gh, shipped, expected] of GITHUB_REFUSALS) {
  test(`ship refuses ${name}`, () => {
    const run = shipRun(CLEAN_CHANGE, { gh });
    assertRefused(run, run.ship(shipped), expected);
  });
}

test('ship takes gate-first-pass=fail when a cancelled run came before the first failure', () => {
  const runs = (head) => ({
    'run list': [ciRun(head, 'success', '2026-11-01T12:00:00Z'), ciRun('b'.repeat(40), 'failure', '2026-11-01T11:00:00Z'), ciRun('a'.repeat(40), 'cancelled', '2026-11-01T10:00:00Z')],
  });
  const run = shipRun(CLEAN_CHANGE, { gh: runs });
  assert.equal(run.ship({ gate: 'fail' }).status, 0, run.log());
});

test('ship takes the reported gate-first-pass when the branch has no workflow runs', () => {
  const run = shipRun(CLEAN_CHANGE);
  assert.equal(run.ship({ gate: 'fail' }).status, 0);
});

const BUILT_T1 = '2026-11-01 card T1 level=standard builder=opus first-pass=pass commit=abc';
const PROVEN_1 = '2026-11-01 criterion 1 test=src/a.test.js proven=yes';
const LOGGED_2 = '2026-11-01 criterion 2 test=none proven=no';
const REVIEWED = '2026-11-01 review clean';
const standardShip = (lines, files = { 'brief.md': BRIEF }) => {
  const run = shipRun(CLEAN_CHANGE, { lane: 'Standard', lines, files });
  return { run, result: run.ship() };
};

test('Standard ship takes each criterion logged, one proven and a review line', () => {
  const { result } = standardShip([BUILT_T1, PROVEN_1, LOGGED_2, REVIEWED]);
  assert.equal(result.status, 0, result.stderr);
});

const CRITERIA_REFUSALS = [
  ['an uncovered criterion', [BUILT_T1, PROVEN_1, REVIEWED], /criterion 2 has no criterion line\. Fix: gsd log s criterion 2 test=<path\|none> proven=yes\|no/],
  ['a run where no criterion with a test is proven', [BUILT_T1, PROVEN_1.replace('yes', 'no'), LOGGED_2, REVIEWED], /no criterion with a test is proven\. Fix: /],
  ['a run without a review line', [BUILT_T1, PROVEN_1, LOGGED_2], /no review line\. Fix: .*review clean\|changes/],
  ['a criterion whose test file does not exist', [BUILT_T1, PROVEN_1.replace('src/a.test.js', 'src/gone.test.js'), LOGGED_2, REVIEWED], /criterion 1 names test=src\/gone\.test\.js, which is not in the checkout\. Fix: /],
];

for (const [name, lines, expected] of CRITERIA_REFUSALS) {
  test(`Standard ship refuses ${name}`, () => {
    const { run, result } = standardShip(lines);
    assertRefused(run, result, expected);
  });
}

test('Standard ship refuses a run folder without its brief', () => {
  const { run, result } = standardShip([BUILT_T1, PROVEN_1, LOGGED_2, REVIEWED], {});
  assertRefused(run, result, /no numbered acceptance criteria in .*brief\.md\. Fix: /);
});

test('Risky ship of an early PR needs only the criteria its built cards cover', () => {
  const firstCard = CARD.join('\n').replace('Covers:     1, 2', 'Covers:     1');
  const plan = `${firstCard}\n${firstCard.replace('## Tasks', '').replace('### T1', '### T2').replace('Covers:     1', 'Covers:     2')}`;
  const files = { 'spec.md': ['# Spec', '', ...CRITERIA].join('\n'), 'plan.md': plan };
  const run = shipRun(CLEAN_CHANGE, { lane: 'Risky', lines: [BUILT_T1, PROVEN_1, REVIEWED], files });
  assert.equal(run.ship().status, 0, run.log());
});

test('summary lists the trust record with criteria, tests and proof', () => {
  const cwd = project();
  const home = freshDir('home');
  const log = [
    '2026-11-01 intake ok lane=Standard base=main@abc',
    '2026-11-01 note this note stays out of the summary',
    '2026-11-01 criterion 2 test=none proven=no',
    '2026-11-01 criterion 1 test=src/a.test.js proven=no',
    '2026-11-01 criterion 1 test=src/a.test.js proven=yes',
    '2026-11-01 keep ok at=src/a.js:1 rule=comment-added why=external-api-units',
    '2026-11-01 accept ok at=src/a.test.js:4 rule=test-skipped by=user',
    '2026-11-01 review changes',
    '2026-11-02 ship done pr=5 gate-first-pass=fail diff-check=accepted',
    '',
  ];
  write(home, 'proj/s/log.md', log.join('\n'));
  const result = gsd(['summary', 's'], { cwd, home });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    '## Trust record',
    '',
    '| Check | Result |',
    '|---|---|',
    '| Lane | Standard |',
    '| Diff-check | accepted; 1 review finding kept, 1 blocking finding accepted by the user |',
    '| Cold review | changes |',
    '| Gate first pass | fail |',
    '',
    '| Criterion | Test | Proven by breaking the code |',
    '|---|---|---|',
    '| 1 | `src/a.test.js` | yes |',
    '| 2 | none | no |',
    '',
    'Kept review findings:',
    '- `src/a.js:1` comment-added: external api units',
    '',
    'Blocking findings the user accepted:',
    '- `src/a.test.js:4` test-skipped',
  ]);
});

test('summary before the ship line says what is not logged yet', () => {
  const home = freshDir('home');
  write(home, 'proj/s/log.md', '2026-11-01 intake ok lane=Direct base=main@abc\n');
  const result = gsd(['summary', 's'], { cwd: project(), home });
  assert.match(result.stdout, /^\| Diff-check \| not logged; 0 review findings kept, 0 blocking findings accepted by the user \|$/m);
  assert.match(result.stdout, /^\| Gate first pass \| not logged \|$/m);
});

test('summary of an unknown run exits 1 and names the fix', () => {
  const result = gsd(['summary', 'nope'], { cwd: project() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nope.* Fix: /);
});

test('ship refuses a run without an intake line', () => {
  const run = shipRun({ 'src/a.js': 'export const a = 2;\n' });
  writeFileSync(join(run.home, 'proj', 's', 'log.md'), '');
  assertRefused(run, run.ship(), /intake.* Fix: /);
});

const GSD_CALL = 'node "/plugins/get-ship-done/scripts/gsd.mjs" log s note started';

function guard(command, { home, cwd, session = 'session-1', tool = 'Bash' }) {
  const input = JSON.stringify({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } });
  const result = gsd(['guard'], { home, cwd, input });
  return { ...result, decision: result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null };
}

function runSession({ branch: branchName } = {}) {
  const home = freshDir('home');
  const cwd = project();
  if (branchName) git(cwd, 'switch', '-q', '-c', branchName);
  guard(GSD_CALL, { home, cwd });
  return { home, cwd };
}

test('guard is silent in a session that never ran gsd', () => {
  const result = guard('gh pr merge 5', { home: freshDir('home'), cwd: project() });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('guard applies only to the session that ran gsd', () => {
  const run = runSession();
  assert.equal(guard('gh pr merge 5', run).decision.permissionDecision, 'ask');
  assert.equal(guard('gh pr merge 5', { ...run, session: 'session-2' }).stdout, '');
});

test('guard marks the session and checks the rest of the same command', () => {
  const result = guard(`${GSD_CALL} && gh pr merge 5`, { home: freshDir('home'), cwd: project() });
  assert.equal(result.decision.permissionDecision, 'ask');
});

test('guard marks the session for every gsd command a run uses', () => {
  for (const name of COMMAND_NAMES.filter((command) => command !== 'guard')) {
    const result = guard(`node "/plugins/get-ship-done/scripts/gsd.mjs" ${name} && gh pr merge 5`, { home: freshDir('home'), cwd: project() });
    assert.equal(result.decision?.permissionDecision, 'ask', `gsd ${name} does not mark the session`);
  }
});

const ASK_COMMANDS = [
  'gh pr merge 5 --squash',
  'gh api -X PUT repos/o/r/pulls/5/merge',
  'gh pr ready 5',
  'git push origin main',
  'git push origin HEAD:main',
  'git push -u origin +work:refs/heads/main',
  'git -C . push origin main',
  'git push',
];

for (const command of ASK_COMMANDS) {
  test(`guard asks the user before: ${command}`, () => {
    const { decision } = guard(command, runSession());
    assert.equal(decision.hookEventName, 'PreToolUse');
    assert.equal(decision.permissionDecision, 'ask');
    assert.match(decision.permissionDecisionReason, /Get Ship Done/);
  });
}

test('guard asks on the PowerShell tool as well', () => {
  assert.equal(guard('gh pr merge 5', { ...runSession(), tool: 'PowerShell' }).decision.permissionDecision, 'ask');
});

const SILENT_COMMANDS = [
  'git push origin work',
  'git push -u origin work',
  'git push origin maintenance',
  'git push',
  'gh pr ready 5 --undo',
  'gh pr view 5',
  'git stash push -m main',
  'git commit -m "explain why merges are the user\'s"',
];

for (const command of SILENT_COMMANDS) {
  test(`guard stays silent on a feature branch for: ${command}`, () => {
    const result = guard(command, runSession({ branch: 'work' }));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });
}

test('guard takes the base branch from origin/HEAD when it is set', () => {
  const run = runSession({ branch: 'work' });
  git(run.cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  assert.equal(guard('git push origin develop', run).decision.permissionDecision, 'ask');
  assert.equal(guard('git push origin main', run).stdout, '');
});

for (const command of ['git commit --no-verify -m x', 'git push --no-verify origin work']) {
  test(`guard denies: ${command}`, () => {
    const { decision } = guard(command, runSession({ branch: 'work' }));
    assert.equal(decision.permissionDecision, 'deny');
    assert.match(decision.permissionDecisionReason, /Fix: /);
  });
}

test('every gsd log call in the ship skill uses a known phase', () => {
  const phases = [...SHIP_SKILL.matchAll(/gsd log <slug> ([a-z-]+)/g)].map((call) => call[1]);
  assert.ok(phases.length >= 6, `expected the skill to log through gsd, found ${phases.length} calls`);
  for (const phase of phases) assert.ok(phase in PHASES, `the ship skill logs unknown phase "${phase}"`);
});

test('every gsd command the ship skill names exists in the script', () => {
  const named = [...SHIP_SKILL.matchAll(/`gsd ([a-z-]+)/g)].map((call) => call[1]);
  for (const expected of ['lint', 'diff-check', 'config', 'features', 'ui-audit', 'summary']) assert.ok(named.includes(expected), `the ship skill never names gsd ${expected}`);
  for (const name of named) assert.ok(COMMAND_NAMES.includes(name), `the ship skill names unknown command "gsd ${name}"`);
});

test('every relative link in the ship skill resolves, including the UI design reference', () => {
  const links = [...SHIP_SKILL.matchAll(/\]\(([^)#:]+)(?:#[^)]*)?\)/g)].map((link) => link[1]);
  assert.ok(links.includes('references/ui-design.md'), `the ship skill does not link the UI design reference, found: ${links}`);
  for (const link of links) assert.ok(existsSync(join(HERE, '..', 'skills', 'ship', link)), `the ship skill links missing file ${link}`);
});

test('the ship skill logs every phase the ship line is verified against, and escapes', () => {
  for (const phase of ['keep', 'accept', 'criterion', 'review', 'escape']) assert.match(SHIP_SKILL, new RegExp(`gsd log <slug> ${phase} `), `the ship skill never logs ${phase}`);
  assert.doesNotMatch(SHIP_SKILL, /below Opus/, 'every Standard change gets a cold review, whatever the model');
});

test("the ship skill's card template has every field lint requires", () => {
  const template = SHIP_SKILL.match(/```\n### T<n>[\s\S]*?```/)?.[0] ?? '';
  for (const field of CARD_FIELDS) assert.ok(template.includes(`\n${field}:`), `the card template lacks "${field}:"`);
});

test('no log format in the ship skill is written by hand', () => {
  assert.doesNotMatch(SHIP_SKILL, /`<date> /);
});

test('guard lets the command through on empty hook input', () => {
  const result = gsd(['guard'], { input: '{}' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('guard lets the command through on malformed hook input and reports it', () => {
  const result = gsd(['guard'], { input: 'not json' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /gsd guard: let the command through/);
});

const ASK_FROM_A_FEATURE_BRANCH = [
  'gh api \\\n  --method PUT \\\n  repos/o/r/pulls/5/merge',
  'gh api -f commit_title="a & b" -X PUT repos/o/r/pulls/5/merge',
  "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  'gh.exe pr merge 5',
  'git push \\\n  origin main',
  'git -C "E:/my repo" push origin main',
  'git push --all origin',
  'git push --mirror',
];

for (const command of ASK_FROM_A_FEATURE_BRANCH) {
  test(`guard asks from a feature branch before: ${JSON.stringify(command)}`, () => {
    const { decision } = guard(command, runSession({ branch: 'work' }));
    assert.equal(decision?.permissionDecision, 'ask');
  });
}

const DENY_COMMANDS = [
  'git commit -m "$(cat <<\'EOF\'\nfix: thing\nEOF\n)" --no-verify',
  'git commit -m "fix: a; b" --no-verify',
  'git commit -n -m x',
  'git commit -anm x',
];

for (const command of DENY_COMMANDS) {
  test(`guard denies: ${JSON.stringify(command)}`, () => {
    const { decision } = guard(command, runSession({ branch: 'work' }));
    assert.equal(decision?.permissionDecision, 'deny');
  });
}

test('guard does not read a commit message flag as the no-verify alias', () => {
  assert.equal(guard('git commit -m "x"', runSession({ branch: 'work' })).stdout, '');
});

const REJECTED_LOG_LINES = [
  [['bogus', 'ok'], /unknown phase "bogus"/],
  [['card', 'T1', 'level=standard', 'builder=fable', 'first-pass=maybe', 'commit=abc'], /first-pass=maybe.*pass\|fail/],
  [['card', 'one', 'level=standard', 'builder=fable', 'first-pass=pass', 'commit=abc'], /result "one"/],
  [['intake', 'ok', 'lane=Fast', 'base=main'], /lane=Fast.*Direct\|Standard\|Risky/],
  [['intake', 'ok', 'lane=Risky'], /missing base/],
  [['ship', 'done', 'pr=5', 'gate-first-pass=pass'], /missing diff-check.*pass\|accepted/],
  [['ship', 'done', 'pr=five', 'gate-first-pass=pass', 'diff-check=pass'], /pr=five/],
  [['outcome', 'merged'], /missing pr/],
  [['outcome', 'landed', 'pr=5'], /result "landed".*merged\|closed\|reverted/],
  [['gate', 'two words'], /result/],
  [['keep', 'ok', 'at=src/a.js:1', 'rule=comment-added', 'why=Because'], /why=Because.*kebab/],
  [['keep', 'ok', 'at=src/a.js:1', 'rule=comment-added'], /missing why/],
  [['accept', 'ok', 'at=src/a.js:1', 'rule=test-skipped', 'by=agent'], /by=agent.*user/],
  [['review', 'done'], /result "done".*clean\|changes/],
  [['escape', 'prod', 'pr=5', 'check=x'], /result "prod".*deploy\|release\|post-release/],
  [['escape', 'release', 'pr=5'], /missing check/],
  [['criterion', 'two', 'test=none', 'proven=no'], /result "two".*a number/],
  [['criterion', '1', 'test=a.test.js', 'proven=maybe'], /proven=maybe.*yes\|no/],
  [['note', 'line one\nline two'], /one line/],
  [['note'], /needs text/],
];

for (const [args, expected] of REJECTED_LOG_LINES) {
  test(`log rejects ${JSON.stringify(args)} and writes nothing`, () => {
    const home = freshDir('home');
    const result = gsd(['log', 's', ...args], { cwd: project(), home });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.match(result.stderr, / Fix: /);
    assert.equal(existsSync(join(home, 'proj')), false);
  });
}

test('lint prefers --criteria over the document\'s own criteria', () => {
  const cwd = lintProject();
  const dir = freshDir('run');
  writeFileSync(join(dir, 'other.md'), ['## Acceptance criteria', '', '1. Only one.', ''].join('\n'));
  writeFileSync(join(dir, 'brief.md'), BRIEF);
  const result = gsd(['lint', join(dir, 'brief.md'), '--criteria', join(dir, 'other.md')], { cwd });
  assert.match(result.stdout, /covers-unknown: .*criterion 2/);
});

test('diff-check checks every file after an added line that looks like a diff header', () => {
  const cwd = branch({ 'a.txt': '++ b/not-a-header\n', 'src/z.js': SUPPRESSION });
  assert.match(diffCheck(cwd).stdout, /^block\s+src\/z\.js:1 suppression-added: /m);
});

test('diff-check reads a test path that contains a space', () => {
  const cwd = branch({ 'src/my thing.test.js': SKIP_CALL });
  assert.match(diffCheck(cwd).stdout, /^block\s+src\/my thing\.test\.js:1 test-skipped: /m);
});
