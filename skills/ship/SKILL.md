---
name: ship
description: Get Ship Done by Mubeen: run a requirement (intake and lane, brief or spec and plan, build test-first, gate and review, ship) as a draft PR. Picks a lane by size and risk, so a small change gets a direct edit, a standard change one approved brief, and a risky or large change a separate spec and plan plus one cold review on the session's model (also for Standard work in a session below Opus). Use whenever the user brings a new requirement for code in a git repo (a feature, a behavior change, a bug fix), or asks for Get Ship Done or the factory. Not for questions, reviews or investigations.
argument-hint: <requirement text, issue link or file path>
---

# Get Ship Done by Mubeen

You take one requirement to a draft PR yourself, in this session. Quality comes from an approved brief, test-first building, the project's deterministic gate and a disciplined self-review; a cold review on the same model is added for risky changes, and for Standard changes in a session below Opus. Tokens are spent once: explore the code once, keep what you learn in context, never re-read what you already have, and do only the ceremony the lane needs.

Requirement: $ARGUMENTS
(If that is empty, the requirement is in the user's latest message; ask if there is none.)

## The gsd script

`gsd` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/gsd.mjs"` (Node 18 or later), run from the project checkout. It keeps the record and runs every check a machine can decide. Each error names its fix: do what it says, never route around the check.

| Command | Use |
|---|---|
| `gsd config` | the project guide's `## Get Ship Done` section as JSON |
| `gsd log <slug> <phase> <result> [key=value ...]` | the only way a line enters `log.md`; `note` and `next` take free text |
| `gsd lint <brief.md or plan.md>` | the card check, before an approval gate |
| `gsd diff-check --base <ref>` | test integrity, escape hatches and doc clutter on the branch diff |
| `gsd features --base <ref>` | the features the branch touches, with their specs, from the project's feature map |
| `gsd stats` | first-pass, gate and outcome rates for this repo |

The plugin's hook treats a session as a run from its first `gsd` command. From then on a merge, a ready mark or a push to the base branch prompts the user, and `--no-verify` is denied.

## Lanes (decided at intake, stated to the user in one line)

| Lane | When | Documents | Approval gates | Review |
|---|---|---|---|---|
| Direct | under about 50 changed lines, no open decision, no risky trigger | none (log.md only) | the diff in the draft PR | self-review |
| Standard | one PR, no risky trigger | `brief.md` (spec and plan in one) | 1: the brief | self-review; plus one cold `get-ship-done:reviewer` when the session runs on a model below Opus |
| Risky | any risky trigger, over about 400 changed lines, or several PRs | `spec.md`, then `plan.md` | 2: spec, then plan | self-review plus one cold `get-ship-done:reviewer` |

Risky triggers: authentication, permissions or roles, tenant isolation, a schema migration, money or billing, personal or patient data handling, secrets or security controls, or the user asks. When the work turns out bigger or riskier than its lane, stop, say so, and move it up a lane (write the missing documents and ask for their approval). Never move a change down a lane without the user.

Ask the user every decision and every approval gate with AskUserQuestion, recommended option first. A user who says to go ahead with named work has not approved a brief: the brief or spec gate still applies in Standard and Risky.

## Token discipline

- Explore with targeted Grep/Glob and partial Reads. No repo dumps, no rereading files already in context, no speculative exploration.
- Documents are short: a brief at most about 80 lines and a plan at most about 120, each plus its task cards (about 8 lines a card). List paths, interfaces and test seams; never paste code or restate the spec in the plan.
- Run the smallest meaningful check (see Check routing); never the full suite until the gate.
- Bound command output (`| tail -40`, `--reporter=dot`, `-q`). On failure read only the failing test's lines.
- Long work items go in the run folder, not in chat. Messages to the user are short.
- A subagent or new session pays a fixed start-up of roughly 65k tokens (system prompt, tools, skills, memory; measured 22 Nov 2026) before it does any work, and one on another model cannot reuse the session's prompt cache. So a subagent is used only when one of these holds: (a) read-heavy work with a short answer (a sweep across many files where only the conclusion matters); (b) independence is the point (the cold review); (c) large, truly independent work that runs in parallel. Never for a build card, never on another model, no multi-agent workflows unless the user asks. `get-ship-done:reviewer` inherits the session's model.
- Resume from the record, not from memory: after each card log its line with `gsd log` (see Task cards). After a context compaction or in a new session, reread `log.md` and the brief or plan instead of trusting a summary.

## Check routing (pick checks from the change, not from habit)

1. Where the project has a test selector, use it on the branch's changed files and run only what it prints (named in the project guide's Get Ship Done section). Where it has a feature map, run `gsd features --base origin/<base>` as well: run the specs it prints for each touched feature, and settle in the brief which feature owns any file it prints as `unmapped`.
2. By nature of the change:
   - UI only: the area's e2e specs plus one screenshot through the `run` skill; no server suite.
   - Server logic or API: the touched modules' tests; e2e only for a changed user flow.
   - Migration: the migration's test, regenerate types (the project's command), and the change is Risky.
   - Bug: load `mattpocock-skills:diagnosing-bugs` and reproduce with a failing test before any fix.
   - CI, scripts or tooling: unit tests of the script; the pipeline itself is checked by the gate run.
   - Docs or Markdown only: lint and links; this is not factory work, offer it as a direct change.
3. Always on the final HEAD: typecheck and lint (the project's pre-check command).

## Task cards (the build contract)

Every Standard brief and Risky plan ends in `## Tasks`: one card per slice, in build order. A card is written so a builder that has read nothing else can do it right; if it cannot be written that way, the design is not finished.

```
### T<n>  <goal in one line>        level: mechanical | standard | judgment   after: T<m>
Files:      <exact paths, (new) or (modify)>
Pattern:    <existing code to copy, path:line>
Interface:  <signatures, types, routes or events this card adds or changes>
Covers:     <numbers of the acceptance criteria this card's test proves, or none>
Test first: <test file and name>; given <state>, when <action>, expect <assertion>
Done when:  <exact command> -> <expected result>
Don't:      <nearby things to leave alone>
Stop if:    <conditions that mean the card is wrong: report, do not improvise>
```

- Levels pick the builder: `mechanical` (follow a named pattern, add a field through layers, rename, wire config): Haiku can build it; `standard` (new logic inside a settled design): Sonnet; `judgment` (design choices, debugging, authorization, tenant isolation, migrations, security): the orchestrator builds it itself.
- Before the approval gate, run `gsd lint <file>` and fix every problem it prints: a missing field, a path or pattern that does not exist, a pattern the guide lists as deprecated, a criterion no card covers, an open `[NEEDS CLARIFICATION]` marker. Then check what it cannot: no card leans on knowledge outside itself and the brief; nothing breaks a rule in the project's AGENTS.md or CLAUDE.md.
- Log each finished card: `gsd log <slug> card T<n> level=<level> builder=<model> first-pass=pass|fail commit=<sha>`. `gsd stats` shows over time which levels a cheaper builder gets right; before trusting Haiku with a project's cards, compare it with Sonnet on a few past cards.

## Session management

The orchestrator keeps its own context small and hands work on before it degrades.

- **Measure** at each checkpoint with the app's usage tool (`get_usage`: tokens used and window). Fixed start-up is about 65k tokens, so a new session pays off only for work left in a context well above that.
- **Checkpoints** (the only points to hand off): brief or plan approved; a PR shipped; a gate run started. Never inside a card. At a checkpoint everything is committed and pushed and the log ends with `gsd log <slug> next "<what comes next>"`, so a session that has read nothing else resumes from the run folder, git and the PR.
- **Hand off** at a checkpoint when the context is above about 200k tokens, a compaction has happened (the orchestrator has lost detail it may need), or the conversation has moved to unrelated work. Start a fresh session (`start_session`, context "fresh", its own worktree on the branch) whose brief is `/get-ship-done:ship resume <slug>` plus the run folder path, log it (`gsd log <slug> handoff started session=<name>`), and tell the user in one line. The app may show the user a card to click: that is a safeguard, not an obstacle. Below the threshold, carry on here.
- **Build sessions** (Risky lane, or several PRs): the orchestrator does Clarify, Design, the cards, the judgment cards, self-review, cold review and ship; each PR's `mechanical` and `standard` cards go to one fresh build session per PR (not per card), on the cheapest model its cards allow (all mechanical: a Haiku model; otherwise Sonnet), with the brief `/get-ship-done:ship build <slug> T<a>-T<b>`. That session builds only those cards test-first, logs each card, stops on any `Stop if`, and ends at the gate start. The orchestrator then reads the diff, proves the tests and reviews as in phase 4. A single-PR Standard change stays in one session: two sessions cost at least twice the start-up.

## Docs discipline

Docs stay lean in every project, and `gsd diff-check` holds the line: it fails a branch that adds a planning or notes file, a stray log or backup file, or (where the guide's section has a `docs` key) a Markdown file outside those globs, and it lists every other new or rewritten Markdown file for you to justify or remove.

A project names its living docs with the `docs` key of its Get Ship Done section. Without the key, follow the project's own docs rules and keep its existing documents untouched.

- Read docs targeted: the area's rules page and module page, the decision log by ID only. Never scan all docs; start from the changed files. Code and tests win over any doc, and archived or point-in-time records never describe current behaviour.
- Briefs, specs and plans stay in the run folder, the issue and the PR description; never add a Markdown file per feature.
- Update only the living-doc sections this change makes untrue, in the same PR. Edit the section, never rewrite a whole doc. Reference a requirement ID, test or source file instead of restating a rule.
- `none` with a one-line reason is a valid docs outcome.

## 0. Intake

1. Confirm a git repo with a clean state you understand. Find the base branch (`git symbolic-ref refs/remotes/origin/HEAD`); ask if unclear. Read the repo's AGENTS.md or CLAUDE.md: a stricter project rule (required checks, review rules, PR rules, a deploy skill) wins.
2. Find the project's gate: the CI the project guide names as its gate (and its backup, if any), or the documented local gate command where none runs. Run `gsd config` for the guide's `## Get Ship Done` section (gate, test selector, checks, PR facts, housekeeping, deprecated patterns, living docs); if it reports none, find the gate in the CI config and offer `/get-ship-done:setup`, which writes the section and seeds a feature map.
3. Pick the lane from the table and tell the user in one line, with the trigger. Choose the model by lane, not by phase: Risky work is best done in an Opus session; Standard and Direct work suit a Sonnet session. If the session's model does not fit the lane, say so in the same line and recommend switching before Clarify; never dispatch a subagent on another model to make up for it. Direct: log intake (step 6) so the hook covers the session, then skip to Build; no run folder documents.
4. Pick a short kebab-case slug. The run folder is `~/.get-ship-done/<repo-name>/<slug>/` (outside the repo) and holds `brief.md` (Standard) or `spec.md` and `plan.md` (Risky), plus `log.md`.
5. If the run folder exists (or the argument is `resume <slug>`), this is a resume: read `log.md` and the brief or plan, check git for the branch, commits and PR, and continue at its last `next` line or the first phase without a done line. With `build <slug> T<a>-T<b>` you are a build session: read the brief or plan, build only those cards (phase 3), log each, push, and stop.
6. Log one line per phase event with `gsd log <slug> <phase> <result> [key=value ...]`, starting with `gsd log <slug> intake ok lane=<lane> base=<branch>@<sha>`. Never write `log.md` by hand.

## 1. Clarify (and design, in the Standard lane)

1. Read the requirement in full (`gh issue view` for an issue link). Read GLOSSARY.md, the area's docs (where the project opts in) and the code the requirement touches, once, keeping enough to design from. Never ask what the code, history or docs answer.
2. Ask only decisions that change behavior, scope, data, permissions or risk, in rounds of at most 4 questions. Challenge a needlessly complex or unsound requirement with a simpler alternative. Settle authorization, tenant isolation and data boundaries explicitly when data or access is touched. Breaking API or data contracts, new dependencies or services and destructive migrations are the user's decisions. Never bend the requirement to make it easier.
3. Standard: write `brief.md`, mark anything still open `[NEEDS CLARIFICATION: <question>]` and resolve every marker before the gate, then check the cards (Task cards). **Gate:** Approve brief / Request changes, pointing out anything under Data and contracts and any new dependency.

```markdown
# <title>
Requirement: <link or quoted text>   Base: <branch @ sha>   Lane: Standard
## Problem and outcome   (two to four sentences)
## Acceptance criteria   (numbered; Given/When/Then only where it adds clarity; include error and permission cases)
## Scope                 (In / Out)
## Decisions             (each with its source)
## Approach              (3 to 6 lines; rejected alternative and why)
## Changes               (paths and what changes; size in LOC)
## Screens                (UI changes only: per screen, the stock components or blocks used, layout, states; a reference screenshot where one exists. Never "make it better")
## Test seams and checks (seam -> criteria; manual checks with id; the routed checks)
## Data and contracts    (or "None")
## Docs                  (sections this makes untrue, or "none: <reason>")
## Tasks                 (task cards, in build order)
```

4. Risky: write `spec.md` (Problem, Outcome, Acceptance criteria, Scope, Constraints, Decisions, Risks). **Gate:** Approve spec. Then go to Design.

## 2. Design (Risky lane only)

Use what Clarify already read; read only the extra code the plan needs.

1. Reuse existing patterns first (never one the guide lists as deprecated), then the smallest complete change that meets every criterion. Delete what the change supersedes (the old path, dead code, the doc section it makes untrue) in the same PR, so the next reader finds one way to copy. Weigh one alternative. Priorities: correctness and data integrity, then simplicity, speed, a small diff. YAGNI.
2. Over about 400 changed lines (excluding tests and generated files), split into one PR per part.
3. Write `plan.md`: Approach, Changes, Test seams, Data and contracts, Docs, Checks, Risk trigger, and Tasks (task cards, grouped by PR), with no `[NEEDS CLARIFICATION]` left and the cards checked. **Gate:** Approve plan / Request changes. At this checkpoint, apply Session management (hand off, and plan the build sessions).

When the work splits into several PRs, run phases 3 to 5 once per PR, each branch cut from the previous PR's head.

## 3. Build (TDD)

1. Branch from the latest base (`git fetch`, branch from `origin/<base>` or the previous PR's head). If another session or someone else's uncommitted work is in the checkout, use a git worktree.
2. Load `mattpocock-skills:tdd` for behavior changes. The approved cards are not asked again. Direct lane: a test only where behavior changes.
3. Per card, in order: red (the card's test, failing for the right reason), green (the smallest code that passes), refactor while green. Run its `Done when` command and the routed checks. Format with the project's formatter. Commit each card with what and why, and log its line. A card's `Stop if` met, or a card that cannot be done as written, stops the build: report it; the orchestrator fixes the card, never the builder.
4. Apply the Docs items in the same change, as section edits. Where the project has a feature map, prove the change in the running app: for each feature `gsd features` lists, follow its "Driving it" steps with the map's recipe (server and API changes included, not only UI), log where the evidence is with `gsd log <slug> note`, and fix any map entry this change makes untrue. Run the manual checks (load `run` to launch the app) and record each result with `gsd log <slug> note`. A UI change ends with a screenshot of each changed screen, compared against the brief's Screens section.
5. Stop and ask when the brief or plan proves wrong, the work needs something not approved, or a failure resists two attempts. Do not improvise architecture.

Build rules: fix root causes; never hide or swallow errors, leave stubs or placeholders, or skip, weaken or delete a valid test; keep server-side authorization, tenant isolation and data boundaries; validate external input at boundaries without excess defense; names follow the domain; no new comments (see Comments); never edit an applied migration; no secrets or real personal data in code, logs or fixtures; no AI attribution; no em dashes in written text; stop every server or watcher you start.

Comments: write none by default. A comment stays only when it is a license header, a doc comment on a public API, behavior forced by an external dependency, platform or protocol we cannot reshape, or an issue link for a constraint code cannot express. A surprise in our own code is removed, not explained: rename, extract or type it until the code says it. A claim such as "do not remove" becomes a type, a test or a lint rule. Never add a suppression (`eslint-disable`, `@ts-ignore` and the like) or a comment that defers or defends a workaround: fix the cause, or stop and report.

## 4. Gate, self-review, cold review

0. **Simplify first.** Run `/simplify` on the branch diff and keep only the fixes that remove duplication or needless code the project already has a home for; rerun the routed checks if it changed anything.
1. **Start the gate.** Before a run on a self-hosted runner, run the project's preflight if its guide names one. Remote CI: push the branch and open a draft PR (`gh pr create --draft`, short body); bind it with the app's PR tools where offered. No remote CI: run the local gate command with `run_in_background` and continue.
2. **Self-review** while the gate runs. First run `gsd diff-check --base origin/<base>`. Fix every `block` line at its cause; one you believe is right for this change goes to the user, and only their yes makes it `diff-check=accepted` on the ship line. Judge every `review` line against Comments and Docs discipline and remove what does not qualify. Then read `git diff <base>...HEAD` once, as a reviewer who did not write it, and check: every criterion has a test that would fail if it broke (or mark it uncovered); logic errors, edge cases, hidden errors; authorization on every changed entry point, tenant isolation, input validation; transactions, migrations, races, idempotency; N+1 queries and unbounded work; weakened assertions (diff-check catches a skipped, focused or deleted test, not a weaker expectation); scope (files outside the brief or plan, debug code, secrets, lockfile churn, duplicated logic); and every item under Lessons below. Then **prove the tests**: for the one or two most important criteria, break the code they cover (invert a condition, drop a guard), run the test, see it fail, and restore the code; a test that stays green is rewritten. Fix what you find test-first and commit. Record the criteria table as `gsd log <slug> note` lines, marking which criteria were proven this way.
3. **Cold review, where the lane calls for it.** Dispatch one fresh `get-ship-done:reviewer` (it runs on the session's model, with read-only tools) with only: the brief or spec path, checkout path, base ref and the trigger (the risky trigger, or "Standard lane on a model below Opus"). Never pass your own view or the build history. Where the project guide requires text in every subagent prompt, put it word for word at the top. CLEAN: done. CHANGES: fix each BLOCKING finding test-first, or put a disputed finding to the user with both sides. One round only. Each BLOCKING finding that would recur is encoded at the highest level that works: a type that makes it impossible to write, else a lint rule or test in the project whose error names the fix, else (when it holds across projects) a `gsd diff-check` rule proposed to the user. Do it in this PR when it is small, otherwise name it in the PR as a follow-up, and prove the new check by seeing it fail on the finding. Only a finding that needs judgment becomes a line under Lessons (generic, no project names).
4. **Gate result.** Watch the run in the background where the project guide says how. A failure the branch caused: fix and rerun (at most 3 rounds). A failure in a file the branch does not touch is retried once; if it then passes, record it as flaky in the PR. A machine cause (runner offline, Docker down) is fixed with the preflight and does not count as a round.

## 5. Ship

1. Complete the draft PR body (`gh pr edit`). Load `mattpocock-skills:pr` for the Summary format. Cover what changes, why (link the requirement), the project's required facts (its facts command, if the guide names one), a `Docs:` line, the acceptance criteria and decisions (the run folder is deleted after merge, so nothing may live only there), how to verify (the gate run, the criteria table, the review result or "self-reviewed"), and open questions (flaky tests, uncovered criteria, risks). No AI attribution.
2. Log it with `gsd log <slug> ship done pr=<number> gate-first-pass=pass|fail diff-check=pass|accepted` and a `next` line, then apply Session management (this is a checkpoint) (the project's tidy command deletes the run folder once that PR is merged or closed). Report outcome first: PR link, gate result on HEAD (green, failed, pending), lane and review result, what is not verified, and what is the user's: read the diff, merge, deploy. When the user later says the PR was merged, closed or reverted, record it: `gsd log <slug> outcome merged|closed|reverted pr=<number>`.

## Rules and what enforces them

| Rule | Enforced by |
|---|---|
| Never merge, mark a PR ready or push to the base branch | hook: the user is asked |
| Never skip the project's hooks with `--no-verify` | hook: denied |
| Every log line carries its required keys | `gsd log` |
| Cards are complete, their paths and patterns exist, no pattern is deprecated, every criterion is covered, no question is open | `gsd lint` |
| No skipped, focused or deleted test | `gsd diff-check` |
| No new suppression or workaround comment | `gsd diff-check` |
| No planning artifact, stray file or Markdown outside the living docs | `gsd diff-check` |
| Typecheck, lint and tests pass on HEAD | the project's gate |
| Approval gates, the lane, weakened assertions, authorization and tenant isolation, scope, secrets and real data, deploys and hosted changes | judgment: you, the self-review and the cold review |

A rule with a machine enforcer is not restated as advice: when it fails, do what its message says. When the user corrects the same thing twice, give it a row here with an enforcer (phase 4, step 3).

## Lessons (judgment only; checked in every self-review)

- A failed lookup (network, auth, rate limit) is "unknown", never "gone" or "done": code that deletes, removes or skips on a negative answer acts only on a confirmed one.
- Parse structured records the code itself wrote (`key=value` lines, JSON), never prose that may mention other things.
- A destructive command defaults to a dry run and refuses unknown arguments.

## Hard limits

- Never merge, mark the PR ready, push to the base branch, deploy, run a hosted migration or change hosted settings. Use a project's deploy skill only when the user says to deploy.
- The lane's approval gates are never skipped; a lane is never lowered without the user.
- Loop caps are hard. When one is hit, stop with the open problems and your recommendation.
- A denied permission or blocked command is reported to the user, never routed around.
- Secrets and real client, patient or customer data stay out of the reviewer prompt, log.md and the PR body.
