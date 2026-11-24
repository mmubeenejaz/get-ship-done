#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
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
const ESCAPE_LAYERS = ['deploy', 'release', 'post-release'];
export const LEVELS = ['mechanical', 'standard', 'judgment'];
const PASS_FAIL = ['pass', 'fail'];
const DIGITS = { test: (value) => /^\d+$/.test(value), hint: 'a number' };
const ANY = { test: (value) => value.length > 0, hint: 'a value' };
const KEBAB = { test: (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value), hint: 'kebab-case words' };
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
  review: { result: oneOf(['clean', 'changes']) },
  criterion: { result: DIGITS, keys: { test: ANY, proven: oneOf(['yes', 'no']) } },
  keep: { result: oneOf(['ok']), keys: { at: ANY, rule: KEBAB, why: KEBAB } },
  accept: { result: oneOf(['ok']), keys: { at: ANY, rule: KEBAB, by: oneOf(['user']) } },
  ship: { keys: { pr: DIGITS, 'gate-first-pass': oneOf(PASS_FAIL), 'diff-check': oneOf(['pass', 'accepted']) } },
  handoff: {},
  outcome: { result: oneOf(['merged', 'closed', 'reverted']), keys: { pr: DIGITS } },
  escape: { result: oneOf(ESCAPE_LAYERS), keys: { pr: DIGITS, check: KEBAB } },
  explore: { result: oneOf(PASS_FAIL), keys: { steps: DIGITS, violations: DIGITS, seed: DIGITS, head: ANY } },
  note: { freeText: true },
  next: { freeText: true },
};

function readEntry(phase, rest) {
  const rule = PHASES[phase];
  if (!rule) fail(`gsd log: unknown phase "${phase}". Fix: use one of ${Object.keys(PHASES).join(', ')}.`);
  if (rule.freeText) {
    if (rest.length === 0) fail(`gsd log: "${phase}" needs text. Fix: gsd log <slug> ${phase} "<text>".`);
    if (rest.some((word) => /[\r\n]/.test(word))) fail(`gsd log: "${phase}" text must be one line. Fix: log each line with its own gsd log <slug> ${phase} "<text>".`);
    return { result: null, given: {} };
  }
  const [result, ...pairs] = rest;
  if (!result || result.includes('=') || /\s/.test(result)) fail(`gsd log: "${phase}" needs a result word before any key=value. Fix: gsd log <slug> ${phase} <result> [key=value ...].`);
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
  return { result, given };
}

function parseLine([date, phase, ...rest]) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  try {
    return { phase, ...readEntry(phase, rest) };
  } catch (error) {
    if (!(error instanceof Fail)) throw error;
    return null;
  }
}

const runDir = (slug) => join(home(), repoName(), slug);

const ofPhase = (entries, phase) => entries.filter((entry) => entry.phase === phase);

function runEntries(dir) {
  const file = join(dir, 'log.md');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).map((line) => parseLine(line.split(' '))).filter(Boolean);
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const EXPLORE_FINDINGS = 'explore.json';

function log([slug, phase, ...rest]) {
  if (!slug || !SLUG.test(slug)) fail('gsd log: the first argument is the run slug in kebab-case. Fix: gsd log <slug> <phase> <result> [key=value ...].');
  const { given } = readEntry(phase, rest);
  const dir = runDir(slug);
  if (phase === 'ship') verifyShip(slug, dir, given);
  const line = [today(), phase, ...rest].join(' ');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'log.md'), `${line}\n`);
  appendFileSync(join(dirname(dir), 'history.log'), `${slug} ${line}\n`);
}

const isCommit = (ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
const atOf = (where) => where.replace(/\s/g, '%20');
const findingLine = (kind, { where, rule, text }) => `${kind} ${where} ${rule}: ${text}`;

function verifyShip(slug, dir, given) {
  const entries = runEntries(dir);
  const intake = entries.findLast((entry) => entry.phase === 'intake');
  if (!intake) fail(`gsd log: ship refused, run ${slug} has no intake line, so there is no base to check against. Fix: gsd log ${slug} intake ok lane=<lane> base=<branch>@<sha>, then log ship again.`);
  const [ref, sha] = intake.given.base.split('@');
  const base = [`origin/${ref}`, ref, sha].find((candidate) => candidate && isCommit(candidate));
  if (!base) fail(`gsd log: ship refused, the intake base "${intake.given.base}" is not a commit git knows. Fix: git fetch, or log a new intake line whose base=<branch>@<sha> resolves.`);
  const settings = readConfig(repoRoot())?.values ?? {};
  const measured = [...(settings.coverage ? coverageFindings(base, settings) : []), ...(settings.mutate ? mutationFindings(base, settings) : [])];
  const problems = [...diffProblems(slug, base, given, entries, measured), ...criteriaProblems(slug, dir, intake.given.lane, entries), ...githubProblems(given)];
  if (problems.length > 0) fail(['gsd log: ship refused, nothing was written. Fix each problem, then log ship again:', ...capped(problems, REVIEW_LIMIT)].join('\n'));
}

function diffProblems(slug, base, given, entries, measured) {
  const { blocking, review: found } = diffFindings(base);
  const review = [...found, ...measured];
  const [kept, accepted] = [ofPhase(entries, 'keep'), ofPhase(entries, 'accept')];
  const named = (lines, finding) => lines.some(({ given: line }) => line.at === atOf(finding.where) && line.rule === finding.rule);
  const unaccepted = blocking.filter((finding) => !named(accepted, finding));
  const problems = [];
  if (given['diff-check'] === 'accepted' && blocking.length === 0) problems.push('diff-check=accepted but nothing blocks. Fix: log the ship line with diff-check=pass.');
  if (given['diff-check'] === 'pass' && blocking.length > 0 && unaccepted.length === 0) problems.push(`diff-check=pass but ${blocking.length} findings block, each accepted by the user. Fix: log the ship line with diff-check=accepted.`);
  for (const finding of unaccepted) {
    problems.push(`${findingLine('block ', finding)}\n  Only on the user's yes: gsd log ${slug} accept ok at=${atOf(finding.where)} rule=${finding.rule} by=user, then ship with diff-check=accepted.`);
  }
  for (const finding of review.filter((item) => !named(kept, item))) {
    problems.push(`${findingLine('review', finding)}\n  Or keep it: gsd log ${slug} keep ok at=${atOf(finding.where)} rule=${finding.rule} why=<kebab-case-reason>.`);
  }
  return problems;
}

const coveredNumbers = (card) => card.fields.Covers?.value.match(/\d+/g)?.map(Number) ?? [];

function criteriaProblems(slug, dir, lane, entries) {
  if (lane === 'Direct') return [];
  const [criteriaFile, cardsFile] = (lane === 'Standard' ? ['brief.md', 'brief.md'] : ['spec.md', 'plan.md']).map((name) => join(dir, name));
  const numbers = readCriteria(criteriaFile).map((criterion) => criterion.number);
  const cards = existsSync(cardsFile) ? readCards(readFileSync(cardsFile, 'utf8').split(/\r?\n/)) : [];
  const built = new Set(ofPhase(entries, 'card').map((entry) => entry.result));
  const isBuilt = (number) => cards.filter((card) => coveredNumbers(card).includes(number)).every((card) => built.has(card.id));
  const required = built.size === 0 ? numbers : numbers.filter(isBuilt);
  const logged = new Map(ofPhase(entries, 'criterion').map((entry) => [Number(entry.result), entry.given]));
  const problems = [];
  if (numbers.length === 0) problems.push(`no numbered acceptance criteria in ${criteriaFile}. Fix: keep the approved ${basename(criteriaFile)}, with its "## Acceptance criteria" section, in the run folder.`);
  for (const number of required.filter((item) => !logged.has(item))) problems.push(`criterion ${number} has no criterion line. Fix: gsd log ${slug} criterion ${number} test=<path|none> proven=yes|no.`);
  for (const [number, { test }] of logged) {
    if (test !== 'none' && !existsSync(join(repoRoot(), test))) problems.push(`criterion ${number} names test=${test}, which is not in the checkout. Fix: log it again with the test file's path from the repository root.`);
  }
  if (required.length > 0 && !required.some((number) => logged.get(number)?.test !== 'none' && logged.get(number)?.proven === 'yes')) {
    problems.push("no criterion with a test is proven. Fix: break the code under the most important criterion's test, see the test fail, restore the code, and log that criterion with proven=yes.");
  }
  if (!entries.some((entry) => entry.phase === 'review')) problems.push(`no review line. Fix: run the cold review, then gsd log ${slug} review clean|changes.`);
  return problems;
}

function gh(args) {
  const [command, prefix] = process.env.GSD_GH ? [process.execPath, [process.env.GSD_GH]] : ['gh', []];
  const result = spawnSync(command, [...prefix, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

const RUN_PASSED = ['success', 'neutral', 'skipped'];
const RUN_UNDECIDED = ['cancelled', 'skipped'];
const short = (sha) => sha.slice(0, 7);

function githubProblems(given) {
  const pr = gh(['pr', 'view', given.pr, '--json', 'state,headRefOid,headRefName']);
  if (!pr) return [`gh could not read PR #${given.pr}. Fix: check the number and gh auth status, then log ship again.`];
  const head = git(['rev-parse', 'HEAD']).trim();
  const problems = [];
  if (pr.state !== 'OPEN') problems.push(`PR #${given.pr} is ${pr.state.toLowerCase()}, not open. Fix: ship an open PR; open a new one if this one is closed.`);
  if (pr.headRefOid !== head) problems.push(`PR #${given.pr} head is ${short(pr.headRefOid)} but HEAD is ${short(head)}. Fix: git push, then log ship again.`);
  const runs = gh(['run', 'list', '--branch', pr.headRefName, '--limit', '200', '--json', 'name,headSha,status,conclusion,createdAt']);
  if (!runs) return [...problems, `gh could not list the workflow runs of ${pr.headRefName}. Fix: check gh auth status, then log ship again.`];
  const onHead = runs.filter((item) => item.headSha === head);
  if (runs.length > 0 && onHead.length === 0) problems.push(`no workflow run on HEAD yet. Fix: ${pr.headRefName} has runs, so wait for CI to start on HEAD (gh run watch), then log ship again.`);
  for (const run of onHead) {
    if (run.status !== 'completed') problems.push(`run "${run.name}" on HEAD is ${run.status}. Fix: wait for it to finish (gh run watch), then log ship again.`);
    else if (!RUN_PASSED.includes(run.conclusion)) problems.push(`run "${run.name}" on HEAD ended ${run.conclusion}. Fix: fix the cause and push; log ship again once it passes.`);
  }
  const decided = runs.filter((run) => run.status === 'completed' && !RUN_UNDECIDED.includes(run.conclusion)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (decided.length > 0) {
    const first = decided[0].headSha;
    const firstPass = decided.filter((run) => run.headSha === first).every((run) => RUN_PASSED.includes(run.conclusion)) ? 'pass' : 'fail';
    if (given['gate-first-pass'] !== firstPass) {
      problems.push(`gate-first-pass=${given['gate-first-pass']} but the first gate runs, on ${short(first)}, ${firstPass === 'pass' ? 'passed' : 'failed'}. Fix: log the ship line with gate-first-pass=${firstPass}.`);
    }
  }
  return problems;
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

export const CONFIG_KEYS = ['gate', 'gate-backup', 'preflight', 'precheck', 'selector', 'migration', 'pr-facts', 'tidy', 'subagent-text', 'tests', 'deprecated', 'docs', 'feature-map', 'verify', 'design', 'coverage', 'lcov', 'mutate', 'mutation-report', 'smoke', 'health', 'explore', 'explore-hosts', 'explore-skip', 'explore-properties', 'explore-state', 'explore-browser'];
const LIST_KEYS = ['tests', 'deprecated', 'docs', 'explore-hosts', 'explore-skip'];
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

export const CARD_FIELDS = ['Files', 'Pattern', 'Interface', 'Covers', 'Test first', 'Done when', "Don't", 'Stop if'];
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
    for (const entry of pattern && !/^none\b/i.test(pattern.value) ? pattern.value.replace(/\([^)]*\)/g, '').split(/[,;]/).map(unquote).filter(Boolean) : []) {
      const [, path, lineNumber] = entry.match(/^(\S+?)(?::(\d+))?(?:\s.*)?$/);
      const target = join(root, path);
      if (!exists(path)) here(pattern.line, 'pattern-missing', `${card.id} copies ${path}, which does not exist`, 'point at real code to copy, or write "none: <reason>"');
      else if (lineNumber && existsSync(target) && Number(lineNumber) > readFileSync(target, 'utf8').split('\n').length) here(pattern.line, 'pattern-missing', `${card.id} copies ${path}:${lineNumber}, past the end of the file`, 'correct the line number');
      else if (matchesAny(path, deprecated)) here(pattern.line, 'pattern-deprecated', `${card.id} copies ${path}, which the project guide lists as deprecated`, 'copy a current example of the same thing, or ask the user what replaces it');
    }
    for (const number of coveredNumbers(card)) covered.set(number, { card, line: covers.line });
  }

  const sources = [flags.criteria, file, join(dirname(file), 'spec.md')].filter(Boolean);
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
const SKIPPED_TEST = /\b(?:it|test|describe|context)(?:\.\w+)*\.(?:skip|skipIf|todo|fixme)\b|\bx(?:it|describe|test)\s*\(|\bskip:\s*(?:true|['"`])|\bthis\.skip\(|@pytest\.mark\.(?:skip|xfail)|\bpytest\.skip\(|@unittest\.skip|\bt\.Skip(?:f|Now)?\(|@Ignore\b|@Disabled\b/;
const FOCUSED_TEST = /\b(?:it|test|describe|context)(?:\.\w+)*\.only\b|\bf(?:it|describe)\s*\(/;
const SUPPRESSION = /(?:\/\/|\/\*|\x23|<!-{2}).*(?:eslint-disable|@ts-(?:ignore|expect-error|nocheck)|\btype:\s*ignore\b|\bnoqa\b|\bnolint\b)/;
const PROSE_FILE = /\.(?:md|mdx|txt)$/i;
const WORKAROUND = /\b(?:TODO|FIXME|HACK|XXX|workaround|temporary|temporarily|for now|do not remove|don't remove)\b/i;
const PLANNING_FILE = /^(?:brief|spec|plan|notes?|todo|scratch|handover|handoff|summary)(?:[-_.][^/]*)?\.(?:md|txt)$/i;
const STRAY_FILE = /\.(?:log|tmp|bak|orig|rej)$/i;
const KEPT_DOC = /^(?:README|CHANGELOG)\.md$/i;
const SLASH_COMMENTS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'go', 'rs', 'java', 'cs', 'kt', 'swift', 'php', 'c', 'h', 'cpp', 'css', 'scss'];
const HASH_COMMENTS = ['py', 'rb', 'sh', 'bash', 'ps1', 'yml', 'yaml', 'toml'];
const UI_FILE = /\.(?:css|scss|sass|less|html?|jsx|tsx|vue|svelte|astro)$/i;
const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const DEFAULT_FACES = 'Inter|Roboto|Arial|Geist';
const UI_SLOP = [
  {
    rule: 'ui-gradient',
    pattern: /\bbg-(?:gradient-to|linear-to|linear-\d|radial|conic)\b|\b(?:linear|radial|conic)-gradient\(/,
    problem: 'a decorative gradient',
    fix: 'use a flat surface from the neutral ramp; keep a gradient only where it carries meaning, such as a fade over scrolling content',
  },
  { rule: 'ui-gradient-text', pattern: /\bbg-clip-text\b|background-clip:\s*text\b/, problem: 'gradient or clipped text', fix: 'use one solid text color from the palette' },
  {
    rule: 'ui-glass-glow',
    pattern: new RegExp(`\\bbackdrop-blur\\b|backdrop-filter:\\s*blur|\\bblur-(?:2xl|3xl)\\b|\\bshadow-(?:${HUES})-\\d`),
    problem: 'glass, a blurred blob or a colored glow',
    fix: 'use a solid surface with a neutral shadow or a border',
  },
  { rule: 'ui-transition-all', pattern: /\btransition-all\b|\btransition:\s*all\b/, problem: 'every property is animated', fix: 'name the properties: color, opacity or transform' },
  {
    rule: 'ui-looping-motion',
    pattern: /\banimate-(?:pulse|bounce|ping)\b|animation(?:-iteration-count)?:[^;]*\binfinite\b/,
    problem: 'a looping animation',
    fix: 'remove it, or keep it only on a loading placeholder',
  },
  { rule: 'ui-hover-lift', pattern: /\bhover:(?:-translate-y-|scale-1\d\d)/, problem: 'a hover lift or grow', fix: 'show hover with a color change; keep movement for press feedback' },
  {
    rule: 'ui-emoji',
    pattern: /(?![©®™↔-↙↩↪])\p{Extended_Pictographic}/u,
    problem: 'an emoji in the interface',
    fix: "use the project's icon set, or plain words",
  },
  { rule: 'ui-heavy-weight', pattern: /\bfont-(?:extrabold|black)\b|font-weight:\s*(?:800|900)\b/, problem: 'an 800 or 900 weight', fix: 'use 600 at most; build hierarchy with size and color' },
  {
    rule: 'ui-tracked-caps',
    pattern: /^(?=.*\buppercase\b)(?=.*(?:\btracking-(?:wide|wider|widest|\[)|letter-spacing))/,
    problem: 'an all-caps label with wide tracking',
    fix: 'use sentence case at a quieter color or size',
  },
  {
    rule: 'ui-one-off-value',
    pattern: /(?<![\w-])-?(?:[mp][trblxyse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|w|h|min-w|min-h|max-w|max-h|size|rounded(?:-[a-z]{1,2})?|text|leading|tracking|bg|border(?:-[trblxy])?|ring|fill|stroke|from|via|to|shadow)-\[(?:-?[\d.]|#)/,
    problem: 'a one-off size or color outside the scale',
    fix: "use the project's spacing, type or color token",
  },
  {
    rule: 'ui-focus-removed',
    pattern: /\boutline-none\b|\boutline:\s*(?:none|0)\b/,
    unless: /focus(?:-visible|-within)?:(?:ring|outline|border|shadow)|:focus-visible|tab[iI]ndex=\{?["']?-1\b/,
    problem: 'the focus outline is removed with no visible replacement',
    fix: 'keep the outline, or add a focus-visible ring on the same element',
  },
  {
    rule: 'ui-hype-copy',
    pattern: /\b(?:seamless(?:ly)?|empower(?:s|ing)?|supercharge[sd]?|revolutioni[sz](?:e|es|ing)|game-?changer|cutting-edge|next-level|effortless(?:ly)?|unleash|elevate your|blazing(?:ly)? fast)\b/i,
    problem: 'hype words in copy',
    fix: 'say plainly what the thing does',
  },
  { rule: 'ui-fake-stat', pattern: /\b\d+(?:\.\d+)?[kKMB]\+|\b99\.\d+%/, problem: 'a round-number claim that may be invented', fix: 'keep it only if the user confirms the figure, otherwise remove it' },
  {
    rule: 'ui-default-font',
    pattern: new RegExp(`(?:font-family|--font-[\\w-]*):\\s*["']?(?:${DEFAULT_FACES})\\b|\\b(?:${DEFAULT_FACES})\\(\\s*\\{`),
    problem: 'a default face as the whole type personality',
    fix: 'choose type from the direction; keep a default face only for body text under a face with character',
  },
];
const testFileMatcher = (settings) => (path) => TEST_FILE.test(path) || matchesAny(path, settings.tests ?? []);
const capped = (lines, limit) => (lines.length > limit ? [...lines.slice(0, limit), `review (${lines.length - limit} more not shown)`] : lines);
const slopFindings = (text) => UI_SLOP.filter(({ pattern, unless }) => pattern.test(text) && !unless?.test(text));
const REVIEW_LIMIT = 30;
const REWRITE_MIN_LINES = 40;

function commentText(path, line) {
  const extension = path.split('.').pop().toLowerCase();
  if (SLASH_COMMENTS.includes(extension)) return line.match(/^\s*(?:\/\/|\/\*|\*(?!\/)|\{\/\*)(.*)$/)?.[1] ?? line.match(/\s\/\/(.*)$/)?.[1] ?? null;
  if (HASH_COMMENTS.includes(extension)) return line.match(/^\s*#(?!!)(.*)$/)?.[1] ?? line.match(/\s#\s(.*)$/)?.[1] ?? null;
  if (extension === 'sql') return line.match(/^\s*--(.*)$/)?.[1] ?? null;
  return null;
}

function readDiff(args) {
  const output = git(['diff', ...args]);
  if (output === null) fail(`gsd: could not read the diff (git diff ${args.join(' ')} failed), so nothing was checked. Fix: make sure the base and HEAD share history (git fetch), then run it again.`);
  return output;
}

const NEAR_CHANGE_LINES = 2;

function hunkLines(range) {
  const lines = [];
  let path = null;
  let lineNumber = 0;
  let inHeader = false;
  for (const line of readDiff([`--unified=${NEAR_CHANGE_LINES}`, '--no-color', '-M', range]).split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      path = null;
    } else if (inHeader && line.startsWith('+++ ')) path = line.startsWith('+++ b/') ? line.slice(6).replace(/\t$/, '') : null;
    else if (line.startsWith('@@')) {
      inHeader = false;
      lineNumber = Number(line.match(/\+(\d+)/)[1]);
    } else if (!inHeader && path && (line.startsWith('+') || line.startsWith(' '))) lines.push({ added: line.startsWith('+'), path, line: lineNumber++, text: line.slice(1) });
  }
  return lines;
}

function branchRange(args, options = []) {
  const { flags } = parseFlags(args, ['base', ...options]);
  const base = flags.base;
  if (!base || !isCommit(base)) fail(`gsd: "${base ?? ''}" is not a known base ref. Fix: git fetch, then pass --base origin/<base branch>.`);
  return { base, range: `${base}...HEAD`, flags };
}

const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const SCRIPT_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro'];
const SCRIPT_SPECIFIER = /\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
const PYTHON_IMPORT = /^\s*(?:from\s+(\.*)([\w.]*)\s+import\s+([\w\s,()*]+?)|import\s+([\w.\s,]+?))\s*(?:#.*)?$/;

const withScriptFiles = (target) => [target, ...SCRIPT_EXTENSIONS.flatMap((extension) => [`${target}.${extension}`, `${target}/index.${extension}`])];

function importTargets(path, line) {
  if (SCRIPT_FILE.test(path)) {
    const targets = [];
    for (const [, specifier] of line.matchAll(SCRIPT_SPECIFIER)) {
      if (specifier.startsWith('.')) targets.push(...withScriptFiles(posix.join(posix.dirname(path), specifier)));
      else if (/^[@~]\//.test(specifier)) targets.push(...withScriptFiles(specifier.slice(2)), ...withScriptFiles(`src/${specifier.slice(2)}`));
    }
    return targets;
  }
  if (!path.endsWith('.py')) return [];
  const match = line.match(PYTHON_IMPORT);
  if (!match) return [];
  const [, dots = '', from, names, plain] = match;
  const asFiles = (target) => [`${target}/`, `${target}.py`];
  const importedNames = (list) => list.replace(/[()]/g, '').split(',').map((name) => name.trim().split(/\s+/)[0]).filter((name) => name && name !== '*');
  if (plain) return importedNames(plain).flatMap((name) => asFiles(name.replace(/\./g, '/')));
  const anchor = dots ? posix.join(posix.dirname(path), ...Array(dots.length - 1).fill('..')) : '';
  const module = posix.join(anchor || '.', from.replace(/\./g, '/'));
  return [module, ...importedNames(names).map((name) => posix.join(module, name))].flatMap(asFiles);
}

function diffFindings(base) {
  const range = `${base}...HEAD`;
  const settings = readConfig(repoRoot())?.values ?? {};
  const isTest = testFileMatcher(settings);
  const deprecated = settings.deprecated ?? [];
  const blocking = [];
  const review = [];
  const block = (where, rule, problem, fix) => blocking.push({ where, rule, text: `${problem}. Fix: ${fix}.` });
  const note = (where, rule, problem, fix) => review.push({ where, rule, text: `${problem}. Fix: ${fix}.` });

  for (const entry of readDiff(['--name-status', '-M', range]).split('\n').filter(Boolean)) {
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
  for (const entry of readDiff(['--numstat', '--no-renames', range]).split('\n').filter(Boolean)) {
    const [, removed, path] = entry.split('\t');
    if (!/\.md$/i.test(path) || removed === '-') continue;
    const before = git(['show', `${mergeBase}:${path}`])?.split('\n').length ?? 0;
    if (before >= REWRITE_MIN_LINES && Number(removed) * 2 >= before) note(path, 'doc-rewritten', `${removed} of about ${before} lines are replaced`, 'edit only the sections this change makes untrue');
  }

  for (const { added, path, line, text } of hunkLines(range)) {
    const where = `${path}:${line}`;
    if (!added) {
      if (commentText(path, text) !== null) note(where, 'comment-near-change', 'an unchanged comment sits next to changed code', 'update it if the change makes it untrue, remove it if it no longer meets Comments, otherwise leave it');
      continue;
    }
    if (deprecated.length > 0) {
      if (matchesAny(path, deprecated)) note(where, 'deprecated-edit', 'a line is added inside deprecated code', 'move the caller onto the code that replaces it, or delete this area if the change supersedes it; keep the edit only for a fix the area needs until then');
      else if (importTargets(path, text).some((target) => matchesAny(target, deprecated))) block(where, 'deprecated-import', 'new code imports deprecated code', 'import the code that replaces it; if none exists yet, ask the user before adding a caller');
    }
    if (UI_FILE.test(path) && !isTest(path)) for (const { rule, problem, fix } of slopFindings(text)) note(where, rule, problem, fix);
    if (isTest(path) && SKIPPED_TEST.test(text)) block(where, 'test-skipped', 'a test is skipped', 'make it pass; if the test itself is wrong, say why in the PR and ask the user');
    if (isTest(path) && FOCUSED_TEST.test(text)) block(where, 'test-focused', 'a focused test stops the rest of the file from running', 'remove the focus before committing');
    if (!PROSE_FILE.test(path) && SUPPRESSION.test(text)) {
      block(where, 'suppression-added', 'a lint or type check is switched off', 'fix what the rule reports; if the rule is wrong here, ask the user');
      continue;
    }
    const comment = commentText(path, text);
    if (comment === null) continue;
    if (WORKAROUND.test(comment)) block(where, 'workaround-comment', 'a comment defers or defends a workaround', 'fix the cause now, or stop and report it; encode a "do not remove" claim as a type, test or lint');
    else note(where, 'comment-added', 'a new comment', 'keep it only for a license header, a public API doc, behavior forced by an external system, a link for a constraint code cannot express, or why a non-obvious choice was made; log what you keep and why; otherwise rename or restructure so the code says it');
  }
  return { blocking, review };
}

function diffCheck(args) {
  const { blocking, review } = diffFindings(branchRange(args).base);
  const lines = [...blocking.map((finding) => findingLine('block ', finding)), ...capped(review.map((finding) => findingLine('review', finding)), REVIEW_LIMIT)];
  process.stdout.write([...lines, `diff-check: ${blocking.length} blocking, ${review.length} review`].join('\n') + '\n');
  return blocking.length > 0 ? 1 : 0;
}

const percent = (part, whole) => `${part}/${whole} (${Math.round((part / whole) * 100)}%)`;
const tally = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);
const listed = (counts) => [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key} ${count}`).join(', ') || 'none';

function stats([repo = repoName()]) {
  const historyFile = join(home(), repo, 'history.log');
  if (!existsSync(historyFile)) fail(`gsd stats: no history for "${repo}". Fix: runs record it with gsd log; pass the repo name if this is the wrong one.`);
  const lanes = new Map();
  const cards = new Map();
  const outcomes = new Map([['merged', 0], ['closed', 0], ['reverted', 0]]);
  const escapes = new Map(ESCAPE_LAYERS.map((layer) => [layer, 0]));
  const checksAdded = new Set();
  const gate = { pass: 0, total: 0, accepted: 0 };
  let unparsed = 0;
  for (const line of readFileSync(historyFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const entry = parseLine(line.split(' ').slice(1));
    if (!entry) {
      unparsed++;
      continue;
    }
    const { phase } = entry;
    if (phase === 'intake') tally(lanes, entry.given.lane);
    if (phase === 'outcome') tally(outcomes, entry.result);
    if (phase === 'escape') {
      tally(escapes, entry.result);
      checksAdded.add(entry.given.check);
    }
    if (phase === 'card') {
      const key = `${entry.given.level}/${entry.given.builder}`;
      const count = cards.get(key) ?? { pass: 0, total: 0 };
      count.total++;
      if (entry.given['first-pass'] === 'pass') count.pass++;
      cards.set(key, count);
    }
    if (phase === 'ship') {
      gate.total++;
      if (entry.given['gate-first-pass'] === 'pass') gate.pass++;
      if (entry.given['diff-check'] === 'accepted') gate.accepted++;
    }
  }
  const cardRates = [...cards].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key} ${percent(count.pass, count.total)}`);
  process.stdout.write(
    [
      `repo: ${repo}`,
      `runs by lane: ${listed(lanes)}`,
      `cards first-pass: ${cardRates.join(', ') || 'none'}`,
      `gate first-pass: ${gate.total ? percent(gate.pass, gate.total) : 'none'}`,
      `diff-check accepted: ${gate.accepted}/${gate.total}`,
      `outcomes: ${['merged', 'closed', 'reverted'].map((key) => `${key} ${outcomes.get(key)}`).join(', ')}`,
      `escapes: ${ESCAPE_LAYERS.map((layer) => `${layer} ${escapes.get(layer)}`).join(', ')}`,
      `checks added: ${[...checksAdded].sort().join(', ') || 'none'}`,
      `unparsed lines: ${unparsed}`,
    ].join('\n') + '\n',
  );
}

const SAME_COMMAND = '[^\\n;&|]*';
const GH_API = '\\bgh(?:\\.exe)?\\s+api\\b[\\s\\S]*?';
const MERGE = new RegExp(`\\bgh(?:\\.exe)?\\s+pr\\s+merge\\b|${GH_API}(?:/merge\\b|\\bmergePullRequest\\b)`);
const READY = new RegExp(`\\bgh(?:\\.exe)?\\s+pr\\s+ready\\b(?!${SAME_COMMAND}--undo)|${GH_API}\\bmarkPullRequestReadyForReview\\b`);
const USES_GIT = /\bgit(?:\.exe)?\b/;
const NO_VERIFY_FLAG = /(?:^|\s)--no-verify\b/;
const NO_VERIFY_ALIAS = new RegExp(`\\bcommit\\b${SAME_COMMAND}?\\s-[a-mo-zA-Z]*n[a-zA-Z]*(?=\\s|$)`);
const PUSH = /\bgit(?:\.exe)?(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*\s+push\b([^\n;&|]*)/g;
const PUSHES_EVERY_BRANCH = /\s--(?:all|mirror)\b/;
const LINE_CONTINUATION = /[\\`]\r?\n/g;
const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function pushesToBase(command, cwd) {
  const pushes = [...command.matchAll(PUSH)];
  if (pushes.length === 0) return false;
  const remoteHead = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)?.trim();
  const bases = remoteHead ? [remoteHead.replace(/^[^/]+\//, '')] : ['main', 'master'];
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)?.trim();
  return pushes.some(([, tail]) => {
    if (PUSHES_EVERY_BRANCH.test(tail)) return true;
    const [, ...refspecs] = tail.split(/\s+/).filter((word) => word && !word.startsWith('-'));
    if (refspecs.length === 0) return bases.includes(current);
    return refspecs.some((refspec) => {
      const target = refspec.replace(/["']/g, '').split(':').pop().replace(/^\+/, '').replace(/^refs\/heads\//, '');
      return bases.includes(target === 'HEAD' ? current : target);
    });
  });
}

const usersDecision = (action) => `Get Ship Done hard limit: ${action} is the user's decision. Approve only if you asked for it in this conversation.`;

function decide(rawCommand, cwd) {
  const command = rawCommand.replace(LINE_CONTINUATION, ' ');
  if (USES_GIT.test(command) && (NO_VERIFY_FLAG.test(command) || NO_VERIFY_ALIAS.test(command))) return ['deny', "Get Ship Done hard limit: --no-verify skips the project's hooks. Fix: make the hook pass, or report the failing hook to the user."];
  if (MERGE.test(command)) return ['ask', usersDecision('merging a pull request')];
  if (READY.test(command)) return ['ask', usersDecision('marking a pull request ready')];
  if (pushesToBase(command, cwd)) return ['ask', usersDecision('pushing to the base branch')];
  return null;
}

function markSession(marker) {
  const sessions = dirname(marker);
  mkdirSync(sessions, { recursive: true });
  for (const name of readdirSync(sessions)) {
    const file = join(sessions, name);
    if (Date.now() - statSync(file).mtimeMs > MARKER_MAX_AGE_MS) rmSync(file, { force: true });
  }
  writeFileSync(marker, '');
}

function guard() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const command = input.tool_input?.command;
    if (typeof command !== 'string' || typeof input.session_id !== 'string') return 0;
    const marker = join(home(), '.sessions', input.session_id.replace(/[^\w.-]/g, '_'));
    if (RUN_COMMAND.test(command)) markSession(marker);
    if (!existsSync(marker)) return 0;
    const decision = decide(command, input.cwd ?? process.cwd());
    if (!decision) return 0;
    const [permissionDecision, permissionDecisionReason] = decision;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } }));
  } catch (error) {
    process.stderr.write(`gsd guard: let the command through after an error: ${error.message}\n`);
  }
  return 0;
}

const DEFAULT_FEATURE_MAP = 'docs/feature-map';
const SOURCE_FILE = new RegExp(`\\.(?:${[...SLASH_COMMENTS, ...HASH_COMMENTS, 'sql'].join('|')})$`, 'i');

function readFeatures(root, mapDir) {
  const listLine = (text, label) => unquote(text.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))?.[1] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return readdirSync(join(root, mapDir))
    .filter((name) => /\.md$/i.test(name) && !KEPT_DOC.test(name))
    .sort()
    .map((name) => {
      const text = readFileSync(join(root, mapDir, name), 'utf8');
      return { file: `${mapDir}/${name}`, paths: listLine(text, 'Paths'), specs: listLine(text, 'Specs') };
    });
}

function features(args) {
  const { range } = branchRange(args);
  const root = repoRoot();
  const settings = readConfig(root)?.values ?? {};
  const mapDir = (settings['feature-map'] ?? DEFAULT_FEATURE_MAP).replace(/\/$/, '');
  if (!existsSync(join(root, mapDir))) fail(`gsd features: no feature map at ${mapDir}. Fix: run /get-ship-done:setup to seed one, or set "- feature-map: <folder>" in the guide's Get Ship Done section.`);
  const map = readFeatures(root, mapDir);
  for (const feature of map) {
    if (feature.paths.length === 0) process.stderr.write(`gsd features: ${feature.file} has no "Paths:" line, so no change can touch it. Fix: add a plain line "Paths: <globs>" under its first paragraph.\n`);
  }
  const changed = readDiff(['--name-only', '--no-renames', range]).split('\n').filter(Boolean);
  const isTest = testFileMatcher(settings);
  const touched = map.filter((feature) => changed.some((path) => matchesAny(path, [...feature.paths, ...feature.specs])));
  const unmapped = changed.filter((path) => SOURCE_FILE.test(path) && !isTest(path) && !map.some((feature) => matchesAny(path, feature.paths)));
  const lines = [...touched.flatMap((feature) => [`feature ${feature.file}`, ...feature.specs.map((spec) => `  spec ${spec}`)]), ...unmapped.map((path) => `unmapped ${path}`)];
  process.stdout.write([...lines, `features: ${touched.length} touched, ${unmapped.length} unmapped`].join('\n') + '\n');
}

const counted = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const lastByKey = (entries, key) => [...new Map(entries.map((entry) => [key(entry), entry])).values()];

function summary([slug]) {
  const entries = slug ? runEntries(runDir(slug)) : [];
  if (entries.length === 0) fail(`gsd summary: no log for run "${slug ?? ''}". Fix: run gsd summary <slug> from the project checkout, with the slug the run logs under.`);
  const last = (phase) => entries.findLast((entry) => entry.phase === phase);
  const logged = (phase) => ofPhase(entries, phase);
  const shown = (entry, read) => (entry ? read(entry) : 'not logged');
  const ship = last('ship');
  const finding = ({ given }) => `${given.at} ${given.rule}`;
  const kept = lastByKey(logged('keep'), finding);
  const accepted = lastByKey(logged('accept'), finding);
  const criteria = lastByKey(logged('criterion'), (entry) => entry.result).sort((a, b) => a.result - b.result);
  const lines = [
    '## Trust record',
    '',
    '| Check | Result |',
    '|---|---|',
    `| Lane | ${shown(last('intake'), (entry) => entry.given.lane)} |`,
    `| Diff-check | ${shown(ship, (entry) => entry.given['diff-check'])}; ${counted(kept.length, 'review finding')} kept, ${counted(accepted.length, 'blocking finding')} accepted by the user |`,
    `| Cold review | ${shown(last('review'), (entry) => entry.result)} |`,
    `| Gate first pass | ${shown(ship, (entry) => entry.given['gate-first-pass'])} |`,
  ];
  if (criteria.length > 0) {
    lines.push('', '| Criterion | Test | Proven by breaking the code |', '|---|---|---|');
    for (const { result, given } of criteria) lines.push(`| ${result} | ${given.test === 'none' ? 'none' : `\`${given.test}\``} | ${given.proven} |`);
  }
  if (kept.length > 0) lines.push('', 'Kept review findings:', ...kept.map(({ given }) => `- \`${given.at}\` ${given.rule}: ${given.why.replace(/-/g, ' ')}`));
  if (accepted.length > 0) lines.push('', 'Blocking findings the user accepted:', ...accepted.map(({ given }) => `- \`${given.at}\` ${given.rule}`));
  process.stdout.write(`${lines.join('\n')}\n`);
}

const AUDIT_LIMIT = 50;

function uiAudit(paths) {
  const where = paths.length > 0 ? paths : ['.'];
  const tracked = git(['ls-files', '-z', '--full-name', '--', ...where]);
  if (tracked === null) fail('gsd ui-audit: git could not list the files. Fix: run it from inside the repository.');
  const root = repoRoot();
  const isTest = testFileMatcher(readConfig(root)?.values ?? {});
  const files = tracked.split('\0').filter((path) => UI_FILE.test(path) && !isTest(path) && existsSync(join(root, path)));
  if (files.length === 0) fail(`gsd ui-audit: no tracked UI file under ${where.join(', ')}. Fix: pass the folder that holds the screens, such as src or app, from inside the repository.`);
  const findings = [];
  const counts = new Map();
  for (const path of files) {
    readFileSync(join(root, path), 'utf8').split(/\r?\n/).forEach((text, index) => {
      for (const { rule, problem, fix } of slopFindings(text)) {
        findings.push(`review ${path}:${index + 1} ${rule}: ${problem}. Fix: ${fix}.`);
        tally(counts, rule);
      }
    });
  }
  process.stdout.write([...capped(findings, AUDIT_LIMIT), `ui-audit rules: ${listed(counts)}`, `ui-audit: ${files.length} files, ${findings.length} findings`].join('\n') + '\n');
  return 0;
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|py|go|rb|rs|java|cs|kt|swift|php|c|h|cpp)$/i;

function changedSourceLines(base, settings) {
  const isTest = testFileMatcher(settings);
  const changed = new Map();
  for (const { added, path, line } of hunkLines(`${base}...HEAD`)) {
    if (added && CODE_FILE.test(path) && !isTest(path)) changed.set(path, [...(changed.get(path) ?? []), line]);
  }
  return changed;
}

function freshReport(command, file, root) {
  const full = resolve(root, file);
  if (!existsSync(full)) fail(`gsd ${command}: no ${command} report at ${file}. Fix: run the project's ${command} command so it writes its report there, or name the file with the flag or the guide key.`);
  const headTime = Number(git(['log', '-1', '--format=%ct', 'HEAD'], root)?.trim()) * 1000;
  if (statSync(full).mtimeMs < headTime) fail(`gsd ${command}: the report ${file} is older than HEAD's commit, so it does not describe this code. Fix: rerun the project's ${command} command, then run this again.`);
  return readFileSync(full, 'utf8');
}

function repoPath(path, root) {
  const slashed = path.trim().replace(/\\/g, '/');
  const prefix = `${root.replace(/\\/g, '/')}/`;
  return (slashed.toLowerCase().startsWith(prefix.toLowerCase()) ? slashed.slice(prefix.length) : slashed).replace(/^\.\//, '');
}

function coverageFindings(base, settings, file = settings.lcov ?? 'coverage/lcov.info') {
  const root = repoRoot();
  const report = freshReport('coverage', file, root);
  const hits = new Map();
  let current = null;
  for (const line of report.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const path = repoPath(line.slice(3), root);
      current = hits.get(path) ?? new Map();
      hits.set(path, current);
    } else if (line.startsWith('DA:') && current) {
      const [number, count] = line.slice(3).split(',');
      current.set(Number(number), Number(count));
    } else if (line === 'end_of_record') current = null;
  }
  const findings = [];
  for (const [path, lines] of changedSourceLines(base, settings)) {
    const counts = hits.get(path);
    if (!counts) findings.push({ where: `${path}:${lines[0]}`, rule: 'not-in-coverage', text: 'a changed source file is missing from the coverage report. Fix: make the coverage run include it (its config, or a test that loads it), or keep it with the reason.' });
    else for (const line of lines.filter((number) => counts.get(number) === 0)) findings.push({ where: `${path}:${line}`, rule: 'uncovered-line', text: 'no test runs this changed line. Fix: add a test that runs it, or keep it with the reason (such as a defensive branch no input reaches).' });
  }
  return findings;
}

function printFindings(command, findings, rules) {
  process.stdout.write([...capped(findings.map((finding) => findingLine('review', finding)), REVIEW_LIMIT), `${command}: ${rules.map((rule) => `${findings.filter((finding) => finding.rule === rule).length} ${rule}`).join(', ')}`].join('\n') + '\n');
  return 0;
}

function coverage(args) {
  const { base, flags } = branchRange(args, ['lcov']);
  return printFindings('coverage', coverageFindings(base, readConfig(repoRoot())?.values ?? {}, flags.lcov), ['uncovered-line', 'not-in-coverage']);
}

function changed(args) {
  const lines = [];
  for (const [path, numbers] of changedSourceLines(branchRange(args).base, readConfig(repoRoot())?.values ?? {})) {
    let start = numbers[0];
    numbers.forEach((number, i) => {
      if (numbers[i + 1] === number + 1) return;
      lines.push(`${path}:${start}-${number}`);
      start = numbers[i + 1];
    });
  }
  process.stdout.write(lines.map((line) => `${line}\n`).join(''));
  return 0;
}

const MUTANT_ESCAPED = { Survived: 'survived: the tests still pass with this change', NoCoverage: 'survived: no test runs it' };

function mutationFindings(base, settings, file = settings['mutation-report'] ?? 'reports/mutation/mutation.json') {
  const root = repoRoot();
  const text = freshReport('mutation', file, root);
  const report = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (!report?.files || typeof report.files !== 'object') fail(`gsd mutation: ${file} is not a mutation-testing-elements JSON report (no "files" object). Fix: have the mutation tool write its JSON report (Stryker: the "json" reporter), then run this again.`);
  const files = new Map(Object.entries(report.files).map(([path, entry]) => [repoPath(path, root), entry.mutants ?? []]));
  const findings = [];
  for (const [path, lines] of changedSourceLines(base, settings)) {
    for (const mutant of files.get(path) ?? []) {
      const line = mutant.location?.start?.line;
      if (!MUTANT_ESCAPED[mutant.status] || !lines.includes(line)) continue;
      findings.push({ where: `${path}:${line}`, rule: 'survived-mutant', text: `${mutant.mutatorName} (${mutant.replacement ?? 'removed'}) ${MUTANT_ESCAPED[mutant.status]}. Fix: add or sharpen a test that fails on this mutant, or keep it with the reason (such as an equivalent mutant).` });
    }
  }
  return findings;
}

function mutation(args) {
  const { base, flags } = branchRange(args, ['report']);
  return printFindings('mutation', mutationFindings(base, readConfig(repoRoot())?.values ?? {}, flags.report), ['survived-mutant']);
}

function deprecatedReport() {
  const root = repoRoot();
  const globs = readConfig(root)?.values.deprecated ?? [];
  if (globs.length === 0) fail('gsd deprecated: the project guide has no deprecated globs. Fix: list the deprecated areas in its "## Get Ship Done" section as "- deprecated: `src/legacy/**`".');
  const tracked = (git(['ls-files', '-z', '--full-name'], root) ?? '').split('\0').filter((path) => path && existsSync(join(root, path)));
  const imports = [];
  for (const path of tracked.filter((path) => SCRIPT_FILE.test(path) || path.endsWith('.py'))) {
    readFileSync(join(root, path), 'utf8').split(/\r?\n/).forEach((text, index) => {
      const targets = importTargets(path, text);
      if (targets.length > 0) imports.push({ where: `${path}:${index + 1}`, path, targets });
    });
  }
  const lines = [];
  let ready = 0;
  let stale = 0;
  for (const glob of globs) {
    const files = tracked.filter((path) => matchesAny(path, [glob]));
    if (files.length === 0) {
      stale++;
      lines.push(`area ${glob} files=0 stale-glob`);
      continue;
    }
    const importers = imports.filter(({ path, targets }) => !matchesAny(path, [glob]) && targets.some((target) => matchesAny(target, [glob])));
    if (importers.length === 0) ready++;
    lines.push(`area ${glob} files=${files.length} importers=${importers.length}${importers.length === 0 ? ' ready-to-delete' : ''}`, ...capped(importers.map(({ where }) => `  importer ${where}`), AUDIT_LIMIT));
  }
  process.stdout.write([...lines, `deprecated: ${globs.length} areas, ${ready} ready-to-delete, ${stale} stale-glob`].join('\n') + '\n');
  return 0;
}

const EXPLORE_SECONDS = 120;
const positiveNumber = (value, flag) => {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) === 0) fail(`gsd explore: --${flag} ${value} is not a positive whole number.`);
  return Number(value);
};

const violationLine = ({ property, where, message, trace }) => `violation ${property} ${where}: ${message}${trace ? ` (trace ${trace})` : ''}`;

async function exploreCommand(args) {
  const shrink = args.includes('--shrink');
  const { flags } = parseFlags(args.filter((arg) => arg !== '--shrink'), ['url', 'time', 'seed', 'start', 'browser', 'out', 'steps', 'replay', 'slug']);
  if (flags.slug && !SLUG.test(flags.slug)) fail('gsd explore: --slug takes the run slug in kebab-case.');
  if (shrink && !flags.replay) fail('gsd explore: --shrink works on a recorded trace. Fix: gsd explore --replay <trace.json> --shrink.');
  const root = repoRoot();
  const settings = readConfig(root)?.values ?? {};
  const { checkHost, explore, readTrace, replay } = await import('./explore.mjs');
  const shared = { browser: flags.browser ?? settings['explore-browser'], root, propertiesFile: settings['explore-properties'], state: settings['explore-state'], fail };
  if (flags.replay) {
    const trace = readTrace(resolve(flags.replay), fail);
    checkHost(trace.url, settings['explore-hosts'] ?? [], fail);
    const { reproduced, violations, shrunk } = await replay({ ...shared, file: resolve(flags.replay), trace, shrink });
    const verdict = reproduced
      ? `replay: reproduced ${trace.violation.property} from ${counted(trace.actions.length, 'action')}`
      : `replay: did not reproduce ${trace.violation.property}; timing or data may differ from the recorded run, so explore again with seed ${trace.seed}`;
    const shrinkLine = shrunk ? [`shrink: ${shrunk.from} to ${shrunk.to} actions, trace ${shrunk.file}`] : [];
    process.stdout.write([...violations.map(violationLine), verdict, ...shrinkLine].join('\n') + '\n');
    return violations.length > 0 ? 1 : 0;
  }
  const url = flags.url ?? settings.explore;
  if (!url) fail('gsd explore: no URL to explore. Fix: pass --url <local app url>, or set "- explore: <url>" in the guide\'s Get Ship Done section.');
  checkHost(url, settings['explore-hosts'] ?? [], fail);
  const seed = flags.seed === undefined ? Math.floor(Math.random() * 1e9) : Number(flags.seed);
  const out = resolve(flags.out ?? (flags.slug ? join(runDir(flags.slug), 'explore') : join(tmpdir(), `gsd-explore-${seed}`)));
  const { steps, violations } = await explore({
    ...shared,
    url,
    seed,
    seconds: positiveNumber(flags.time, 'time') ?? EXPLORE_SECONDS,
    steps: positiveNumber(flags.steps, 'steps') ?? Infinity,
    start: flags.start?.split(',').map((path) => path.trim()).filter(Boolean) ?? [],
    skip: settings['explore-skip'] ?? [],
    out,
  });
  process.stdout.write([...capped(violations.map(violationLine), REVIEW_LIMIT), `explore: ${counted(steps, 'step')}, ${counted(violations.length, 'violation')}, seed ${seed}, out ${out}`].join('\n') + '\n');
  if (flags.slug) {
    mkdirSync(runDir(flags.slug), { recursive: true });
    writeFileSync(join(runDir(flags.slug), EXPLORE_FINDINGS), `${JSON.stringify(violations.map(({ where, property, message }) => ({ where, rule: property, text: message })), null, 2)}\n`);
    log([flags.slug, 'explore', violations.length > 0 ? 'fail' : 'pass', `steps=${steps}`, `violations=${violations.length}`, `seed=${seed}`, `head=${git(['rev-parse', 'HEAD']).trim()}`]);
  }
  return violations.length > 0 ? 1 : 0;
}

const COMMANDS = { log, config, lint, 'diff-check': diffCheck, stats, guard, features, 'ui-audit': uiAudit, summary, deprecated: deprecatedReport, coverage, changed, mutation, explore: exploreCommand };
export const COMMAND_NAMES = Object.keys(COMMANDS);
const RUN_COMMAND = new RegExp(`gsd\\.mjs["']?\\s+(?:${COMMAND_NAMES.filter((name) => name !== 'guard').join('|')})\\b`);

function main(argv) {
  const [name, ...args] = argv;
  const command = COMMANDS[name];
  if (!command) fail(`gsd: unknown command "${name ?? ''}". Fix: use one of ${Object.keys(COMMANDS).join(', ')}.`);
  return command(args);
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ?? 0;
  } catch (error) {
    if (!(error instanceof Fail)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
