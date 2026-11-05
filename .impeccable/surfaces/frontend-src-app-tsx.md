---
version: 1
slug: "frontend-src-app-tsx"
primary_target: "frontend/src/App.tsx"
related_targets: []
---

# Surface: officev2 app shell (Merge, Extract pages, Activity)

Mode: Operate. Assumptions (user said "proceed", no interview): product truth inferred from README; direction taken unattended from the roll.

## Direction contract

THESIS: officev2 is a drawing office for files: every operation is a numbered revision on a sheet, and nothing is erased, only withdrawn. It refuses the category-default dark-gray utility panel with one blue accent.

OWN-WORLD: Technical drawing sheet (ISO drafting). Ground is cool drafting-film grey-green (#e8eae3) with lighter film panels, ink-black rail and 1px ink rules. One signal colour, drafting-pencil orange-red (#d4472b), marks the active item and revisions; state colours (done green, failed crimson) appear only on status text. Type is Bahnschrift (DIN-like technical lettering, Windows system face) with Cascadia Mono for paths and numerals, tabular figures. Density is tight: 13px base, 28px rows, hairline rules instead of cards.

STORY: The user sees at once which tool is open, that the engine is running, and what the last revision was. They run an operation, and it appears as the next revision letter in Activity. They can withdraw a revision, which strikes it through but keeps it in the table.

FIRST VIEWPORT: Left rail (200px, ink black) with the officev2 name, grouped tool list with line icons (Combine, Scissors, History), active item marked by a signal-colour bar. Main area is a film panel inside a thin inner frame line (sheet border). Merge: title and one-line instruction, a ruled table (No. / File / Location / row actions as icon buttons), then Add files and Merge to buttons. Bottom edge: a title-block strip of ruled cells (TOOL, ENGINE, LAST REV, SHEET n/3). Primary action is the ink-filled button right of the file table.

FORM: Engineering drawing sheet with revision block, position 7 of 7, seed:25418258d0787cc4. Signature move: the title-block status strip plus Activity rendered as a revision table (REV A, B, C...; withdrawn revisions struck through, never removed).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
