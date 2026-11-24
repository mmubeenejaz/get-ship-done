#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

class Fail extends Error {}
const fail = (message) => {
  throw new Fail(message);
};

const home = () => process.env.GSD_HOME || join(homedir(), '.get-ship-done');

function git(args, cwd = process.cwd()) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function repoName(cwd = process.cwd()) {
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!commonDir) fail('gsd: not inside a git repository. Fix: run it from the project checkout.');
  return basename(dirname(commonDir.trim()));
}

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const LANES = ['Direct', 'Standard', 'Risky'];
export const LEVELS = ['mechanical', 'standard', 'judgment'];
const PASS_FAIL = ['pass', 'fail'];
const DIGITS = { test: (value) => /^\d+$/.test(value), hint: 'a number' };
const ANY = { test: (value) => value.length > 0, hint: 'a value' };
const oneOf = (values) => ({ test: (value) => values.includes(value), hint: values.join('|') });

export const PHASES = {
  intake: { keys: { lane: oneOf(LANES), base: ANY } },
  clarify: {},
  design: {},
  build: {},
  card: {
    result: { test: (value) => /^T\d+$/.test(value), hint: 'the card id, for example T3' },
    keys: { level: oneOf(LEVELS), builder: ANY, 'first-pass': oneOf(PASS_FAIL), commit: ANY },
  },
  simplify: {},
  gate: {},
  'self-review': {},
  review: {},
  ship: { keys: { pr: DIGITS, 'gate-first-pass': oneOf(PASS_FAIL), 'diff-check': oneOf(['pass', 'accepted']) } },
  handoff: {},
  outcome: { result: oneOf(['merged', 'closed', 'reverted']), keys: { pr: DIGITS } },
  note: { freeText: true },
  next: { freeText: true },
};

function logLine(phase, rest) {
  const rule = PHASES[phase];
  if (!rule) fail(`gsd log: unknown phase "${phase}". Fix: use one of ${Object.keys(PHASES).join(', ')}.`);
  if (rule.freeText) {
    if (rest.length === 0) fail(`gsd log: "${phase}" needs text. Fix: gsd log <slug> ${phase} "<text>".`);
    return `${today()} ${phase} ${rest.join(' ')}`;
  }
  const [result, ...pairs] = rest;
  if (!result || result.includes('=')) fail(`gsd log: "${phase}" needs a result word before any key=value. Fix: gsd log <slug> ${phase} <result> [key=value ...].`);
  if (rule.result && !rule.result.test(result)) fail(`gsd log: "${phase}" result "${result}" is not valid. Fix: use ${rule.result.hint}.`);
  const given = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at < 1 || /\s/.test(pair)) fail(`gsd log: "${pair}" is not key=value without spaces. Fix: put free text in its own line with gsd log <slug> note "<text>".`);
    given[pair.slice(0, at)] = pair.slice(at + 1);
  }
  for (const [key, check] of Object.entries(rule.keys ?? {})) {
    if (!(key in given)) fail(`gsd log: "${phase}" is missing ${key}. Fix: add ${key}=<${check.hint}>.`);
    if (!check.test(given[key])) fail(`gsd log: ${key}=${given[key]} is not valid for "${phase}". Fix: use ${key}=<${check.hint}>.`);
  }
  return [today(), phase, result, ...pairs].join(' ');
}

function log([slug, phase, ...rest]) {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail('gsd log: the first argument is the run slug in kebab-case. Fix: gsd log <slug> <phase> <result> [key=value ...].');
  const line = logLine(phase, rest);
  const repoDir = join(home(), repoName());
  mkdirSync(join(repoDir, slug), { recursive: true });
  appendFileSync(join(repoDir, slug, 'log.md'), `${line}\n`);
  appendFileSync(join(repoDir, 'history.log'), `${slug} ${line}\n`);
}

const COMMANDS = { log };

function main(argv) {
  const [name, ...args] = argv;
  const command = COMMANDS[name];
  if (!command) fail(`gsd: unknown command "${name ?? ''}". Fix: use one of ${Object.keys(COMMANDS).join(', ')}.`);
  return command(args);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2)) ?? 0;
  } catch (error) {
    if (!(error instanceof Fail)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
