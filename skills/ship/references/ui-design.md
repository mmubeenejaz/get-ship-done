# UI design: direction before pixels

Load this for any brief or spec with a Screens section, and for a requirement to unslop existing screens. The aim is a screen that could only belong to this product. `gsd diff-check` and `gsd ui-audit` flag the known generic tokens (gradients, glass, emoji, one-off values, removed focus rings, hype copy and the rest); everything below needs judgment.

## 1. Direction

Write five lines at the top of the Screens section, before any code:

- **Product:** what it is and who uses it, in one sentence.
- **Character:** two or three concrete words a user would recognize, such as "ledger-precise, calm, unhurried". Never clean, modern, sleek, premium, beautiful or intuitive: they fit every product, so they decide nothing.
- **World:** the setting the product borrows from (a clinic chart, a printed timetable, a workshop bench). It supplies the type, color and texture.
- **Moments:** one or two points where the user should feel something (the first useful result, a finished task) and what the screen does there.
- **Signature:** one specific detail that carries the character, in one place.

Anti-template test: put a competitor's name on the screen. If it still fits, the direction is too weak; sharpen it before building.

Tokens: use the project's tokens and shared components (the guide's `design` key). A value the design needs and the tokens lack is added to the tokens, never written inline.

## 2. Existing screens (unslop)

1. **Audit.** Run `gsd ui-audit <folder of the screens>` for the tally, and take one screenshot of each screen through `run`. Read each screen against the rules below for what a pattern cannot catch.
2. **Triage** each screen and say which in the brief:
   - Heavy: generic layout and decoration throughout. Redesign from a new direction.
   - Light: sound layout, generic details. Polish passes only; the direction is written down, not reinvented.
   - Clean: leave it alone, and say so.
3. The brief's Screens section holds the audit summary, the triage and the direction. Approval of the brief is the stop before any edit.
4. An unslop changes look and copy, not flows, data or permissions. Existing e2e specs pass unchanged, apart from copy assertions the brief names.
5. Removed decoration is not replaced with new decoration (glass swapped for grain, neon or noise). The removal is the change.

## 3. Rules

**Chrome and color**
- Chrome stays quiet: surfaces, borders and text come from one neutral ramp, tinted slightly toward the brand hue.
- One accent, for the primary action and for state. One bright element per screen.
- Spend boldness in one place (the signature) rather than spreading it thin.
- Borders do most of the separating; shadows stay small and neutral.

**Layout and components**
- Hierarchy comes from size, weight and space, not from boxes. No card inside a card; no row of identical feature cards with an icon tile above each heading.
- Equal things get equal sizes, and unequal things do not pretend to be equal.
- Icons, labels and numbers line up in columns.
- Nested corners: the inner radius is the outer radius minus the padding between them.

**Spacing**
- One spacing scale on a 4px grid.
- Space inside a group is smaller than space between groups.

**Type and numbers**
- Two weights, regular and medium, with semibold at most; hierarchy from size and color.
- Sentence case for headings, labels and buttons.
- `tabular-nums` for figures that align or change; one number and date format per screen.
- No negative letter-spacing on small text.

**Copy**
- Name the thing plainly. Labels are short, with no trailing period.
- Buttons name the action and its object ("Save changes", "Send invite"), never "Submit" or "OK".
- No exclamation marks or greeting headlines. An empty state says what is missing and the one action that fixes it.
- No invented figures or claims (user counts, uptime, ratings). Keep one only when the user confirms it.
- Sample data looks real and is synthetic: plausible names, uneven numbers, no `[X]` or `123,456`, never real client data.

**Data and charts**
- One main chart per screen, with one accent color; the rest stays neutral.
- A stat shows its number and its comparison (last period, a target), or it is not a stat.
- No decorative sparklines or charts that answer no question.

**Motion**
- Motion explains a change: hover changes color, press scales down slightly, at most one entrance on load.
- Animate color, opacity and transform only, about 200ms or less for feedback.
- Honor `prefers-reduced-motion`.

**Accessibility floor**
- Visible focus on every interactive element.
- Text contrast at least 4.5:1; large text and UI shapes at least 3:1.
- Every input has a label; every icon-only button has an accessible name.
- Targets at least 24px; color is never the only signal.

## 4. Pass order

For a redesign or polish, the cards follow this order, each pass finished across the whole screen before the next starts:

1. spacing and alignment, 2. color, 3. icons, 4. copy, 5. type, 6. layout, 7. details (radius, borders, shadows), 8. visuals and data, 9. motion.

Adjacent passes share a card when the screen is small. A Light triage usually needs passes 1, 2, 4 and 5 only. Visual passes have no unit test: their card's test is the area's e2e specs staying green, and their proof is the finish below.

## 5. Finish

1. Every `ui-*` review line from `gsd diff-check` is fixed, or justified against the direction in a `gsd log` note (a gradient the direction names is fine).
2. `gsd ui-audit` on the changed screens' folder: the tally falls, or the brief says why not.
3. A screenshot of each changed screen, compared against the direction and the Screens section. Run the anti-template test again and tab through the screen once to see focus.

## Sources

Written for this plugin. The direction step, triage and pass order are adapted and reworded from [unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Also informed by [anti-ui-slop](https://github.com/github/awesome-copilot/blob/main/skills/anti-ui-slop/SKILL.md), the pattern catalog in [zero-slop](https://github.com/Eid0lon/zero-slop) and Anthropic's [frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) skill.
