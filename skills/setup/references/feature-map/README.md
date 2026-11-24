# Feature map

The maintained source for what this app does from a user's point of view, which code and specs belong to each feature, and how to prove a feature works. Read this page, then the file of the feature you are changing.

## Verification recipe

- **Launch:** `<the command that starts the app for verification>`, with a disposable data folder and seed data. Ready means usable: `<the log line or page that shows it>`.
- **Doctor:** `<one read-only command>` that confirms the instance is ours: right URL, right build, right data folder. Run it first, and again after any surprise.
- **Drive:** `<the harness: existing e2e specs first, then a browser, a terminal or plain HTTP>`. Start every feature from the seeded state.
- **Evidence:** the action and the resulting state, not only the last screen. For a change that writes, a second read-only view of the stored value. Save it under `<folder>`.
- **Cleanup:** stop only what this run started. Evidence stays.

Never drive an instance this run did not start. Report a path you could not reach with the command you tried and what was missing; do not count it as verified through another path.

## Feature file shape

Each file starts with the feature name, one paragraph on what the user can do, then the lines the tooling reads:

- `Paths:` globs for the code that implements the feature.
- `Routes:` (optional, for a feature with screens) the app paths that show it, which `gsd features` prints for `gsd explore --start`.
- `Specs:` the specs that prove it.

Then four sections, in this order: `Sub-features` (short ids, one line each), `How to reach it` (every entry point a user has), `Driving it` (each user action with its exact command and the result to observe), `Gotchas` (traps that waste or invalidate a run).

## Features

- [Search](./example-feature.md): find a note from the toolbar or the keyboard.
