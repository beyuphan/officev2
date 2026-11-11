# officev2 design system

World: technical drawing sheet (ISO drafting). Mode: Operate. Source of truth is `frontend/src/App.css` (the colors, type and spacing are variables at the top of that file).

## Idea

Every operation is a numbered revision on a sheet. Nothing is erased: undoing a revision withdraws it (struck through, kept in the table). The world lends type, palette, density and one signature move; navigation and controls are standard web components.

## Color

| Role | Token | Value |
|---|---|---|
| Ground (drafting film) | `--film` | `#e8eae3` |
| Panel (sheet) | `--panel` | `#f3f4ef` |
| Ink / rules | `--ink`, `--rule` | `#1b1f24` |
| Secondary text | `--ink-2` | `#565c63` |
| Soft rule | `--rule-soft` | `#c4c8bd` |
| Signal (pencil orange-red) | `--signal`, `--signal-fill` | `#c23d22`, `#d4472b` |
| Done | `--done` | `#2b6b47` |
| Failed | `--bad` | `#a3231c` |
| Rail | `--rail`, `--rail-text`, `--rail-dim` | `#1b1f24`, `#e8eae3`, `#9aa19c` |

Signal marks the active tool icon, withdrawn revisions and the Undo action. State colors appear on status text and message borders only. Light ground chosen because the app sits beside white PDF pages in daylight use.

## Type

- UI: Bahnschrift (DIN-like technical lettering, ships with Windows), fallbacks Segoe UI Variable, system-ui. Base 14px.
- Data: Cascadia Mono / Consolas with tabular numerals for paths, dates, revision letters.
- Scale: 20px title, 14px body, 12px data, 11px uppercase tracked column labels, 10px title-block labels.

## Components

- Rail: 200px, ink black, grouped tool list with 16px line icons (lucide, 1.5 stroke). Active item: lighter fill, white text, signal icon.
- Sheet: film-colored panel inside a 1px ink frame inset 12px from the window.
- Table: real `<table>`, 32px rows, 1px ink header rule, soft row rules, uppercase column labels. No cards.
- Buttons: 2px radius, 1px ink border; primary is ink-filled. Icon buttons are borderless, always with `aria-label`.
- Title-block strip (signature): ruled cells at the bottom edge: TOOL, ENGINE, LAST REV, SHEET n/3.
- Revision table (signature): Activity lists jobs as REV A, B, C…; withdrawn rows are struck through in signal color and keep their status.

## Rules

- No emoji or glyph icons; icons come from lucide.
- No colored side borders, gradients, glass, or hard offset shadows.
- Focus ring 2px signal; selection signal on white.
- New tools reuse the Title + table/field + actions pattern and register one rail item and one sheet number.
