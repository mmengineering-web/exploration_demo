# Design system (v1.1)

The UI is rebuilt on a small design system. It uses shadcn/ui **Nova (neutral)** tokens and names, written as plain CSS. The app has no build step and must run offline, so React, Tailwind and the shadcn CLI are not used. Because token names match shadcn, a later React port can copy the tokens as they are.

Live reference: open `styleguide.html` on the deployed site. It measures every color pair against WCAG and updates when you switch theme.

## Layers (Atomic Design)

| Layer | Files | Holds |
|---|---|---|
| Tokens | `css/ds/tokens.css` | Color roles, status colors, chart colors, radius, shadow, type, 4px spacing, control heights, z-index scale. Light is `:root`, dark is `[data-theme="dark"]`. |
| Atoms | `css/ds/base.css` | Reset, type scale, field (label + input/select/textarea), checkbox, radio, date field, icons. |
| Molecules and organisms | `css/ds/components.css` | Button, badge (`.chip`), alert (`.msg`), card, segmented control (`.subnav`), list row, table (`.grid`, `.rec`), toast, dialog, bottom sheet, skeleton, empty state. |
| Templates | `css/ds/shell.css` | Shell: sidebar (at 1024 px and wider), top bar, bottom tab bar, login. |
| Screens | `css/screens.css`, `css/dash.css` | Rules for one screen only: data pages, map and layer panel, dashboard, Data QC. |
| Runtime | `js/ui.js`, `js/icons.js` | Theme, toast, `ui.confirm()`, `ui.sheet()`, empty state, skeleton; Lucide icons. |

Rule: a component reads tokens only. No raw hex and no raw `z-index` outside the token scale. Old class names (`.btn`, `.card`, `.chip`, `.msg`, `.grid`) are kept, so screens did not need new markup.

## Decisions

- **Neutral base, status colors added.** Pass, warning, info and danger each have text, background and border tokens. Status always carries an icon or a label, never color alone.
- **Dark mode.** Follows the phone setting; the toggle in the top bar overrides it per device (`localStorage` key `exp_theme`). A small inline script in `index.html` sets the theme before first paint. Charts read `--chart-N`, so they re-color on toggle.
- **Controls.** One height scale for inputs and buttons: 32, 40 and 44 px; 44 px is the default on touch screens. Inputs use 16 px text on phones so iOS does not zoom.
- **Navigation.** Same tab list on every screen size (`tabsFor()`). Desktop: sidebar grouped Input, Analisis, Data, Sistem. Phone: bottom bar with the first four tabs, plus a "Lainnya" sheet with the rest and logout.
- **Dialogs.** `window.confirm` is replaced by `ui.confirm()`: focus is trapped, Esc and backdrop cancel, delete uses a red button.
- **Fonts and icons.** Geist and Geist Mono (SIL OFL), self-hosted in `fonts/`. Lucide icons (ISC), inlined in `js/icons.js`. Both work offline. Licenses are in `licenses/`.

## Chart colors

Fixed order, never cycled: blue, amber, teal, purple, pink, lime (`--chart-1` to `--chart-6`). Plan series use the neutral `--chart-plan`. Color follows the entity, not its rank.

## Adding a component

1. Use an existing token. If none fits, add a token first.
2. Put the CSS in the right layer file. Add the component to `styleguide.html`.
3. Check light and dark, at 390 px and 1360 px, with no horizontal overflow.
4. Add the file to `SHELL` in `sw.js` if it is new, and bump the cache name.

## Moving to shadcn/ui later

Copy `tokens.css` variables into the shadcn `globals.css`; names match (`--background`, `--primary`, `--muted-foreground`, `--radius`, ...). Status and chart tokens are additions. Each `.btn`, `.chip`, `.msg`, `.card` maps to shadcn `Button`, `Badge`, `Alert`, `Card`.
