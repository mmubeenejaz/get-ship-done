---
name: setup
description: Get Ship Done project setup. Writes the project's Get Ship Done section, reports what the project lacks for safe agent work, and seeds a feature map with a verification recipe. Run once per project, and again when its gate or layout changes.
disable-model-invocation: true
argument-hint: [section | audit | map]
---

# Get Ship Done: set up a project

You prepare one project so that `/get-ship-done:ship` can rely on checks, not on memory. With no argument do all three parts in order; with `section`, `audit` or `map` do that part only. `gsd` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/gsd.mjs"`, run from the project checkout.

Interview the repository, not the user: read the CI config, the package scripts or Makefile, the lint and type config, the test layout and the docs folders. Ask the user only what the code cannot answer, with AskUserQuestion, recommended option first. Work on a branch, never the base branch, and write nothing before the user has seen it.

## 1. The section

Draft a `## Get Ship Done` section for the project guide (AGENTS.md, or CLAUDE.md where that is the guide) as `- key: value` lines. The skill and the script read the same lines, so keep prose out of it. Use only the keys the project needs:

```markdown
## Get Ship Done

- gate: <the CI run or local command that must pass, and how to start it>
- gate-backup: <a second gate, if the project has one>
- preflight: <command to run before a gate on a self-hosted runner>
- precheck: <typecheck and lint command>
- selector: <command that turns changed files into the tests to run>
- migration: <command a schema migration needs, such as regenerating types>
- pr-facts: <command that prints facts every PR body must carry>
- tidy: <command that cleans up after a merged or closed PR>
- subagent-text: <text every subagent prompt must start with>
- tests: <globs for test files the built-in patterns miss>
- deprecated: <globs for code that must not be copied as a pattern>
- docs: <globs where a new Markdown file may be added>
- feature-map: <folder of the feature map, default docs/feature-map>
- verify: <the project's verification skill or command>
```

Show the draft and ask before writing. Then run `gsd config`: it must print the keys with no warning.

## 2. The readiness report

Change nothing in this part. Report what you found and what is missing:

| Item | What to look for |
|---|---|
| Gate | one named run or command that decides pass or fail |
| Types | strict mode on; count of `any` escapes |
| Lint | present, and whether it enforces boundaries (which module may import which) |
| Suppressions | count of lint and type suppressions today; this is the baseline |
| Deprecated code | old ways still in the tree that a builder would copy |
| Tests | a selector, or a feature map that can stand in for one |
| Docs | where living docs sit; planning files, logs or backups tracked in git |
| Rules without an enforcer | lines in the guide that nothing checks |

For each gap recommend the highest level that removes it: architecture that makes the mistake impossible, then a type, then a lint rule whose error names the fix, then a test, and a line in the guide only for a judgment call. Offer each as its own requirement for `/get-ship-done:ship`; do not fix them here.

## 3. The feature map

A feature map tells a builder which user-facing feature a file belongs to, which specs prove it and how to drive it in the running app. `gsd features --base <ref>` reads it to route checks.

1. Pick three to five features a user would name, from the routes, commands, menus or docs. Add the rest later, as they are touched.
2. Write `<feature-map>/README.md` and one file per feature in the shape of [references/feature-map](references/feature-map/). The README holds the verification recipe once: Launch, Doctor, Drive, Evidence, Cleanup. Each feature file starts with its name, one paragraph from the user's point of view, a `Paths:` line and a `Specs:` line, then four sections: Sub-features, How to reach it, Driving it, Gotchas.
3. Use real commands, selectors and spec files from this repo. Prefer stable handles (roles, labels, route paths) over positions. Keep implementation detail out of the map.
4. Make sure the section's `docs` globs cover the map folder, or the diff check will reject new feature files.
5. Prove it: follow the recipe once for one feature (launch, doctor, drive, capture evidence, clean up) and confirm the evidence is still there after cleanup. Then run `gsd features --base origin/<base>` on a branch that touches a mapped path and confirm the feature is listed. A recipe that was never run is a draft: say so if the app cannot be launched, and say what blocked it.

When driving the app keeps needing throwaway scripts, propose a small control command for the project as its own requirement: a few composable subcommands, a dry run on anything destructive, errors that say what to do, `--help`, and JSON output.

## Finish

Commit on the branch, open a draft PR and report: the section as written, the gaps by level, the features mapped, and what was proven by running it. Never merge, never push to the base branch.
