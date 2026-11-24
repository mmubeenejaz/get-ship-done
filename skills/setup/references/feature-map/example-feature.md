# Search

A user finds a note by words in its title or body, opens it from the results, and can tell "no matches" apart from "search is unavailable".

Paths: `src/search/**`, `server/routes/search.ts`
Specs: `e2e/search.spec.ts`

## Sub-features

- `search-open`: search opens from the toolbar and from the keyboard.
- `search-match`: title and body matches are listed; nothing is changed.
- `search-empty`: a query with no matches shows a complete empty state.

## How to reach it

- The `Search` button in the toolbar.
- The `/` key while focus is outside a text field.

## Driving it

Preconditions: the app is launched as the README says, and the seed data holds a note titled `Quarterly plan`.

- **Open from the toolbar.** Click the button with the accessible name `Search`. A dialog named `Search notes` appears with focus in its search box.
- **Match a title.** Type `quarterly`. The results list contains `Quarterly plan` and no other seeded note.
- **Empty state.** Type `volcano`. A status reading `No matching notes` appears once the search completes.
- **Proof.** Run `npx playwright test e2e/search.spec.ts`, and save a screenshot of the populated results.

## Gotchas

- `/` typed inside the editor inserts a slash; it does not open search.
- Results update after a short debounce. Wait for the list or the empty status, never a fixed delay.
