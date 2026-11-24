#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
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

function parseFlags(args, names) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : null;
    if (name === null) positional.push(args[i]);
    else if (!names.includes(name)) fail(`gsd: unknown option --${name}. Fix: use ${names.map((n) => `--${n}`).join(', ')}.`);
    else if (args[i + 1] === undefined) fail(`gsd: --${name} needs a value.`);
    else flags[name] = args[++i];
  }
  return { flags, positional };
}

const repoRoot = (cwd = process.cwd()) => git(['rev-parse', '--show-toplevel'], cwd)?.trim() ?? cwd;

export const CONFIG_KEYS = ['gate', 'gate-backup', 'preflight', 'precheck', 'selector', 'migration', 'pr-facts', 'tidy', 'subagent-text', 'tests', 'deprecated', 'docs', 'feature-map', 'verify'];
const LIST_KEYS = ['tests', 'deprecated', 'docs'];
const GUIDES = ['AGENTS.md', 'CLAUDE.md'];
const SECTION = /^##\s+Get Ship Done\s*$/i;

function readConfig(root) {
  for (const guide of GUIDES) {
    const path = join(root, guide);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const start = lines.findIndex((line) => SECTION.test(line));
    if (start < 0) continue;
    const values = {};
    for (const line of lines.slice(start + 1)) {
      if (/^##\s/.test(line)) break;
      const entry = line.match(/^\s*[-*]\s+([a-z][a-z-]*):\s*(.+)$/);
      if (!entry) continue;
      const [, key, raw] = entry;
      const value = raw.replace(/`/g, '').trim();
      values[key] = LIST_KEYS.includes(key) ? value.split(',').map((item) => item.trim()).filter(Boolean) : value;
    }
    return { guide, values };
  }
  return null;
}

function config(args) {
  const { flags } = parseFlags(args, ['root']);
  const found = readConfig(flags.root ?? repoRoot());
  if (!found) fail(`gsd config: no "## Get Ship Done" section in ${GUIDES.join(' or ')}. Fix: run /get-ship-done:setup in this project to write it.`);
  for (const key of Object.keys(found.values)) {
    if (!CONFIG_KEYS.includes(key)) process.stderr.write(`gsd config: unknown key "${key}" in ${found.guide}. Fix: use one of ${CONFIG_KEYS.join(', ')}.\n`);
  }
  process.stdout.write(`${JSON.stringify(found.values, null, 2)}\n`);
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      const dirOnly = glob[i + 2] === '/';
      source += dirOnly ? '(?:.*/)?' : '.*';
      i += dirOnly ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const underDirectory = (path, glob) => !/[*?]/.test(glob) && path.startsWith(`${glob.replace(/\/$/, '')}/`);
const matchesAny = (path, globs) => globs.some((glob) => globToRegExp(glob).test(path) || underDirectory(path, glob));

const CARD_FIELDS = ['Files', 'Pattern', 'Interface', 'Covers', 'Test first', 'Done when', "Don't", 'Stop if'];
const FIELD_LINE = new RegExp(`^(${CARD_FIELDS.join('|')}):\\s*(.*)$`);
const unquote = (text) => text.replace(/`/g, '').trim();

function readCards(lines) {
  const cards = [];
  let inFence = false;
  let card = null;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) return;
    const header = line.match(/^###\s+(T\d+)\b(.*)$/);
    if (header) {
      card = { id: header[1], line: index + 1, level: header[2].match(/\blevel:\s*(\S+)/)?.[1], fields: {} };
      cards.push(card);
    } else if (/^##\s/.test(line)) card = null;
    else if (card) {
      const field = line.match(FIELD_LINE);
      if (field && field[2].trim()) card.fields[field[1]] = { value: field[2].trim(), line: index + 1 };
    }
  });
  return cards;
}

function readCriteria(file) {
  if (!existsSync(file)) return [];
  const criteria = [];
  let inSection = false;
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (/^##\s/.test(line)) inSection = /^##\s+Acceptance criteria\b/i.test(line);
    const numbered = inSection && line.match(/^\s*(\d+)\.\s/);
    if (numbered) criteria.push({ number: Number(numbered[1]), file, line: index + 1 });
  });
  return criteria;
}

function lint(args) {
  const { flags, positional } = parseFlags(args, ['criteria', 'root']);
  const [file] = positional;
  if (!file || !existsSync(file)) fail('gsd lint: give the brief.md or plan.md to check. Fix: gsd lint <file> [--criteria <spec.md>] [--root <checkout>].');
  const root = flags.root ?? repoRoot();
  const deprecated = readConfig(root)?.values.deprecated ?? [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const problems = [];
  const report = (where, line, rule, problem, fix) => problems.push(`${where}:${line} ${rule}: ${problem}. Fix: ${fix}.`);
  const here = (line, ...rest) => report(file, line, ...rest);

  lines.forEach((line, index) => {
    if (line.replace(/`[^`]*`/g, '').includes('[NEEDS CLARIFICATION')) here(index + 1, 'needs-clarification', 'an open question is still in the document', 'ask the user, record the answer under Decisions and delete the marker');
  });

  const cards = readCards(lines);
  if (cards.length === 0) here(1, 'no-cards', 'the document has no task card', 'end it with a "## Tasks" section holding one "### T<n>" card per slice');

  const covered = new Map();
  const created = new Set();
  const exists = (path) => created.has(path) || existsSync(join(root, path));
  for (const card of cards) {
    if (!LEVELS.includes(card.level)) here(card.line, 'card-level', `${card.id} has level "${card.level ?? ''}"`, `write "level: ${LEVELS.join(' | ')}" on the card's heading line`);
    for (const name of CARD_FIELDS) {
      if (!card.fields[name]) here(card.line, 'card-field-missing', `${card.id} has no "${name}:" line`, `add it; a card must stand on its own, so write "${name}: none" only when that is true`);
    }
    const { Files: files, Pattern: pattern, Covers: covers } = card.fields;
    for (const entry of files ? files.value.split(/[,;]/).map(unquote).filter(Boolean) : []) {
      const marked = entry.match(/^(.+?)\s*\((new|modify)\)$/);
      if (!marked) here(files.line, 'files-marker', `${card.id} lists "${entry}" without saying whether it exists`, 'write the path followed by (new) or (modify)');
      else if (marked[2] === 'modify' && !exists(marked[1])) here(files.line, 'path-missing', `${card.id} modifies ${marked[1]}, which does not exist`, 'correct the path, or mark it (new)');
      else if (marked[2] === 'new') created.add(marked[1]);
    }
    for (const entry of pattern && !/^none\b/i.test(pattern.value) ? pattern.value.split(/[,;]/).map(unquote).filter(Boolean) : []) {
      const [, path, lineNumber] = entry.match(/^(\S+?)(?::(\d+))?(?:\s.*)?$/);
      const target = join(root, path);
      if (!exists(path)) here(pattern.line, 'pattern-missing', `${card.id} copies ${path}, which does not exist`, 'point at real code to copy, or write "none: <reason>"');
      else if (lineNumber && existsSync(target) && Number(lineNumber) > readFileSync(target, 'utf8').split('\n').length) here(pattern.line, 'pattern-missing', `${card.id} copies ${path}:${lineNumber}, past the end of the file`, 'correct the line number');
      else if (matchesAny(path, deprecated)) here(pattern.line, 'pattern-deprecated', `${card.id} copies ${path}, which the project guide lists as deprecated`, 'copy a current example of the same thing, or ask the user what replaces it');
    }
    for (const number of covers?.value.match(/\d+/g) ?? []) covered.set(Number(number), { card, line: covers.line });
  }

  const sources = [file, flags.criteria, join(dirname(file), 'spec.md')].filter(Boolean);
  const criteria = sources.map(readCriteria).find((found) => found.length > 0) ?? [];
  if (criteria.length === 0) here(1, 'no-criteria', 'no numbered acceptance criteria were found', 'add a "## Acceptance criteria" section, or pass --criteria <spec.md>');
  else {
    const numbers = criteria.map((criterion) => criterion.number);
    for (const criterion of criteria) {
      if (!covered.has(criterion.number)) report(criterion.file, criterion.line, 'criterion-uncovered', `no card covers criterion ${criterion.number}`, `add ${criterion.number} to the "Covers:" line of the card whose test proves it, or add a card`);
    }
    for (const [number, { card, line }] of covered) {
      if (!numbers.includes(number)) here(line, 'covers-unknown', `${card.id} covers criterion ${number}, which does not exist`, 'use the numbers from the acceptance criteria');
    }
  }

  if (problems.length === 0) {
    process.stdout.write(`lint: ok (${cards.length} cards, ${criteria.length} criteria)\n`);
    return 0;
  }
  process.stdout.write(`${problems.join('\n')}\nlint: ${problems.length} problems\n`);
  return 1;
}

const TEST_FILE = /(^|\/)(__tests__|tests?|e2e|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.(cs|java|kt)$/;
const SKIPPED_TEST = /\b(?:it|test|describe|context)\.(?:skip|todo|fixme)\b|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip(?:Now)?\(|@Ignore\b|@Disabled\b/;
const FOCUSED_TEST = /\b(?:it|test|describe|context)\.only\b|\bf(?:it|describe)\s*\(/;
const SUPPRESSION = /eslint-disable|@ts-(?:ignore|expect-error|nocheck)|\btype:\s*ignore\b|\bnoqa\b|\bnolint\b/;
const WORKAROUND = /\b(?:TODO|FIXME|HACK|XXX|workaround|temporary|temporarily|for now|do not remove|don't remove)\b/i;
const PLANNING_FILE = /^(?:brief|spec|plan|notes?|todo|scratch|handover|handoff|summary)(?:[-_.][^/]*)?\.(?:md|txt)$/i;
const STRAY_FILE = /\.(?:log|tmp|bak|orig|rej)$/i;
const KEPT_DOC = /^(?:README|CHANGELOG)\.md$/i;
const SLASH_COMMENTS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'go', 'rs', 'java', 'cs', 'kt', 'swift', 'php', 'c', 'h', 'cpp', 'css', 'scss'];
const HASH_COMMENTS = ['py', 'rb', 'sh', 'bash', 'ps1', 'yml', 'yaml', 'toml'];
const REVIEW_LIMIT = 30;
const REWRITE_MIN_LINES = 40;

function commentText(path, line) {
  const extension = path.split('.').pop().toLowerCase();
  if (SLASH_COMMENTS.includes(extension)) return line.match(/^\s*(?:\/\/|\/\*|\*(?!\/)|\{\/\*)(.*)$/)?.[1] ?? line.match(/\s\/\/(.*)$/)?.[1] ?? null;
  if (HASH_COMMENTS.includes(extension)) return line.match(/^\s*#(?!!)(.*)$/)?.[1] ?? line.match(/\s#\s(.*)$/)?.[1] ?? null;
  if (extension === 'sql') return line.match(/^\s*--(.*)$/)?.[1] ?? null;
  return null;
}

function addedLines(range, cwd) {
  const added = [];
  let path = null;
  let lineNumber = 0;
  for (const line of (git(['diff', '--unified=0', '--no-color', '-M', range], cwd) ?? '').split('\n')) {
    if (line.startsWith('+++ ')) path = line.startsWith('+++ b/') ? line.slice(6) : null;
    else if (line.startsWith('@@')) lineNumber = Number(line.match(/\+(\d+)/)[1]);
    else if (line.startsWith('+') && path) added.push({ path, line: lineNumber++, text: line.slice(1) });
  }
  return added;
}

function diffCheck(args) {
  const { flags } = parseFlags(args, ['base']);
  const base = flags.base;
  if (!base || git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) === null) fail(`gsd diff-check: "${base ?? ''}" is not a known base ref. Fix: git fetch, then pass --base origin/<base branch>.`);
  const range = `${base}...HEAD`;
  const settings = readConfig(repoRoot())?.values ?? {};
  const isTest = (path) => TEST_FILE.test(path) || matchesAny(path, settings.tests ?? []);
  const blocking = [];
  const review = [];
  const block = (where, rule, problem, fix) => blocking.push(`block  ${where} ${rule}: ${problem}. Fix: ${fix}.`);
  const note = (where, rule, problem, fix) => review.push(`review ${where} ${rule}: ${problem}. Fix: ${fix}.`);

  for (const entry of (git(['diff', '--name-status', '-M', range]) ?? '').split('\n').filter(Boolean)) {
    const [status, ...paths] = entry.split('\t');
    const path = paths[paths.length - 1];
    const name = basename(path);
    if (status === 'D' && isTest(path)) block(path, 'test-deleted', 'a test file is deleted', 'restore it; if the behavior it covers is gone on purpose, say so in the PR and ask the user');
    if (status !== 'A') continue;
    if (PLANNING_FILE.test(name)) block(path, 'planning-artifact', 'a planning or notes file is added to the repo', 'keep it in the run folder and the PR description; a lasting doc is named for its subject');
    else if (STRAY_FILE.test(name)) block(path, 'stray-file', 'a log, backup or scratch file is added', 'delete it from the branch, and add its pattern to .gitignore if a tool writes it');
    else if (/\.md$/i.test(name) && !KEPT_DOC.test(name)) {
      if (!settings.docs) note(path, 'doc-added', 'a new Markdown file', 'keep it only if it is a living doc; otherwise edit the section of an existing doc');
      else if (!matchesAny(path, settings.docs)) block(path, 'doc-outside-docs', `a new Markdown file outside the guide's docs globs (${settings.docs.join(', ')})`, 'edit the section of the living doc it belongs to, or move it under those globs');
    }
  }

  const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
  for (const entry of (git(['diff', '--numstat', '--no-renames', range]) ?? '').split('\n').filter(Boolean)) {
    const [, removed, path] = entry.split('\t');
    if (!/\.md$/i.test(path) || removed === '-') continue;
    const before = git(['show', `${mergeBase}:${path}`])?.split('\n').length ?? 0;
    if (before >= REWRITE_MIN_LINES && Number(removed) * 2 >= before) note(path, 'doc-rewritten', `${removed} of about ${before} lines are replaced`, 'edit only the sections this change makes untrue');
  }

  for (const { path, line, text } of addedLines(range)) {
    const where = `${path}:${line}`;
    if (isTest(path) && SKIPPED_TEST.test(text)) block(where, 'test-skipped', 'a test is skipped', 'make it pass; if the test itself is wrong, say why in the PR and ask the user');
    if (isTest(path) && FOCUSED_TEST.test(text)) block(where, 'test-focused', 'a focused test stops the rest of the file from running', 'remove the focus before committing');
    const comment = commentText(path, text);
    if (comment === null) continue;
    if (SUPPRESSION.test(comment)) block(where, 'suppression-added', 'a lint or type check is switched off', 'fix what the rule reports; if the rule is wrong here, ask the user');
    else if (WORKAROUND.test(comment)) block(where, 'workaround-comment', 'a comment defers or defends a workaround', 'fix the cause now, or stop and report it; encode a "do not remove" claim as a type, test or lint');
    else note(where, 'comment-added', 'a new comment', 'keep it only for a license header, a public API doc, behavior forced by an external system, or a link for a constraint code cannot express; otherwise rename or restructure so the code says it');
  }

  const shown = review.length > REVIEW_LIMIT ? [...review.slice(0, REVIEW_LIMIT), `review (${review.length - REVIEW_LIMIT} more not shown)`] : review;
  process.stdout.write([...blocking, ...shown, `diff-check: ${blocking.length} blocking, ${review.length} review`].join('\n') + '\n');
  return blocking.length > 0 ? 1 : 0;
}

const COMMANDS = { log, config, lint, 'diff-check': diffCheck };

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
