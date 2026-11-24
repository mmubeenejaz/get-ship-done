# Get Ship Done by Mubeen

A Claude Code plugin that takes one requirement to a draft pull request. It picks a lane by size and risk (Direct, Standard, Risky), writes one brief or a spec and plan ending in task cards, builds test-first, runs the project's gate, reviews every Standard and Risky change cold, and ships only once `gsd` has verified the ship record itself. It hands work to fresh sessions at checkpoints so long runs stay cheap.

Overview with diagrams: https://mmubeenejaz.github.io/get-ship-done/

## How a run flows

```mermaid
flowchart TD
  I[Intake: lane and model] --> D[Direct: under 50 lines]
  I --> S[Standard: one brief, one gate]
  I --> R[Risky: spec and plan, two gates]
  D --> B[Build by task cards: test first, cheapest builder]
  S --> B
  R --> B
  B --> G[Gate and review: prove tests, cold review]
  G --> X[Ship: PR is the record]
  C[Checkpoints: hand off above about 200k tokens] -.-> G
```

## Where instructions live

```mermaid
flowchart LR
  subgraph Plugin["This plugin (same everywhere)"]
    K[skills/ship: lanes, cards, sessions, lessons]
    V[agents/reviewer: cold, read-only]
    G[scripts/gsd and hook: the checks a machine can decide]
  end
  subgraph Project["Each project repo"]
    A["AGENTS.md: ## Get Ship Done (gate, selector, checks)"]
    T[Project tools: test selector, PR facts, tidy]
  end
  subgraph Run["Each run"]
    F["~/.get-ship-done/repo/slug: brief, cards, log"]
    P[Draft PR: the lasting record]
  end
  K --> A
  K --> F
  F --> P
```

## Install

```
claude plugin marketplace add mmubeenejaz/get-ship-done
claude plugin install get-ship-done@get-ship-done
```

Run it with `/get-ship-done:ship <requirement>`; resume with `/get-ship-done:ship resume <slug>`. Update with `claude plugin marketplace update get-ship-done`.

Requires Node 18 or later and git 2.31 or later on the PATH (the checks and the hook are one script with no dependencies).

## What is enforced, not asked

Rules a machine can decide are checked by `scripts/gsd.mjs`, and every error names its fix. Prose in the skill is kept for judgment.

| Command | Checks |
|---|---|
| `gsd log` | a run log line has its phase's required keys; writes `log.md` and a per-repo `history.log`. A `ship` line is refused until gsd's own evidence agrees: the diff check re-run against the intake base with each blocking finding fixed or accepted by the user and each review finding fixed or kept with a reason; the PR open at HEAD; every workflow run on HEAD green and `gate-first-pass` matching the first runs (read through `gh`); and, for Standard and Risky runs, a criterion line per built criterion, one tested criterion proven by breaking the code, and a cold review line |
| `gsd summary <slug>` | prints the trust record for the PR body: lane, diff-check with kept and accepted findings, cold review, gate first pass, and the criteria with their tests and proof |
| `gsd lint <brief or plan>` | cards are complete, paths and patterns exist, no pattern is deprecated, every acceptance criterion is covered, no question is open |
| `gsd diff-check --base <ref>` | no skipped, focused or deleted test; no new suppression or workaround comment; no planning file, stray file or Markdown outside the living docs. Other new comments and docs, unchanged comments next to changed code, and generic UI tokens on new UI lines, are listed for review |
| `gsd features --base <ref>` | prints the features a branch touches and their specs, from the project's feature map; lists source files no feature claims |
| `gsd ui-audit [path ...]` | lists generic UI tokens (decorative gradients, glass, emoji, one-off values, removed focus rings, hype copy) in tracked screens, with a tally per rule, as the audit before an unslop |
| `gsd config` | prints the project section as JSON |
| `gsd stats` | card first-pass rate by level and builder, gate first-pass rate, outcomes, and escaped bugs per layer (deploy, release, post-release) with the checks they added |

A PreToolUse hook (`hooks/hooks.json`) watches Bash and PowerShell commands. In a session that has run `gsd`, a PR merge, a ready mark or a push to the base branch prompts you for approval, and `--no-verify` is denied. Other sessions are untouched.

## Set up a project

Run `/get-ship-done:setup` in the project. It drafts the section below, reports what the project lacks for safe agent work (gate, strict types, lint boundaries, a suppression baseline, rules nothing enforces), and seeds a feature map: one file per user-facing feature with its code paths, its specs and how to drive it in the running app, plus one verification recipe. It asks before writing.

Or write the `## Get Ship Done` section by hand in the project's `AGENTS.md` (or `CLAUDE.md`) as `- key: value` lines. The skill and the script read the same lines:

```markdown
## Get Ship Done

- gate: the `ci` workflow on the draft PR
- precheck: `npm run precheck`
- selector: `node scripts/select-tests.mjs`
- tests: `e2e/**`, `**/*.test.ts`
- deprecated: `src/legacy/**`
- docs: `docs/modules/**`, `docs/rules/**`
```

Keys: `gate`, `gate-backup`, `preflight`, `precheck`, `selector`, `migration`, `pr-facts`, `tidy`, `subagent-text`, `tests`, `deprecated`, `docs`, `feature-map`, `verify`. `tests` adds to the built-in test file patterns. `deprecated` lists code no card may copy as its pattern. `docs` lists where a new Markdown file may be added; anywhere else it fails the diff check.

Without the section the skill finds the gate in the CI config and offers the setup skill.

## Run state

`~/.get-ship-done/<repo>/<slug>/` holds `brief.md` or `spec.md` and `plan.md`, and `log.md`. The draft PR body keeps the criteria, the decisions and the `gsd summary` trust record, so the folder is disposable after merge. `~/.get-ship-done/<repo>/history.log` keeps every log line for `gsd stats` and outlives the run folders.

## Changing it

Edit, bump `version` in `.claude-plugin/plugin.json`, push, and update the marketplace on each machine. The gate for this repo is the script's tests, on Windows and on Linux:

```
node --test scripts/gsd.test.mjs
docker run --rm -v "${PWD}:/repo:ro" -w /repo node:18 node --test scripts/gsd.test.mjs
```

A review finding a machine can detect becomes a check here or a lint rule or test in the project; only judgment calls are added to the skill's Lessons. The comment and verification ideas are adapted from Lauren Tan's pstack (cursor/plugins).

## License

MIT
