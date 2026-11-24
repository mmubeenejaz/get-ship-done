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
