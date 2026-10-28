# Dashboard UI kit

Shared dashboard components live here. Feature pages compose these surfaces
instead of copying Tailwind blocks. See `policies/frontend-components.md` for
the policy. `pnpm dashboard-style:check` enforces the token rules below.

## shadcn/ui

`packages/junior-dashboard/components.json` configures shadcn/ui for this package.
It uses Base UI (`base-nova`), Tailwind 4, and Lucide. Add components from the
repository root:

```sh
pnpm --filter @sentry/junior-dashboard exec shadcn add <component>
```

The CLI writes components to `src/client/components/ui/`. Its `@dashboard/*`
alias points to `src/client/*`. The existing `@/*` alias still points to core.
`src/client/lib/utils.ts` provides the shadcn `cn` helper. Existing components
keep the class join helper in `src/client/styles.ts` until they are migrated.

The shadcn color tokens in `src/tailwind.css` use the dashboard tokens in both
themes. Primary actions use `text-solid` with inverse text. Danger uses the
same theme-aware rose shade as existing danger controls. The `dark:` variant
follows `data-theme`. Keep the existing Tailwind radius scale. Do not apply the CLI's global border or body resets to existing
components. Check each added component against the rules below and add its
gallery fixture before use.

`ui/sheet.tsx` is the shadcn Base UI Dialog Sheet. It supports all four edges,
uses the dashboard overlay and close button, and stops motion when reduced
motion is set. The copied source license is in `ui/sheet.LICENSE`.
`Drawer` and `BottomSheet` compose this component for app details.
`ui/useSheet.ts` owns their close lifecycle, shared document scroll lock, and
focus rules when a resize puts one modal below another. Conversation browser
scenarios cover dismissal, nested focus, and layout changes.

## Foundations

Tokens live in the `@theme` block of `src/tailwind.css`. Keep every color in a
token so each theme can redefine it.

- **Themes.** Dark is the default. The light theme redefines every token under
  `:root[data-theme="light"]`. It also mirrors the light status and chart
  shades (50-400) to their dark pair, so `text-rose-300` stays readable on the
  light canvas. The head script in `src/theme.ts` sets `data-theme` before first
  paint from the saved choice or the system color scheme. `ThemeSwitcher` saves
  the choice for this browser. Use the `light:` variant only for one-off values
  that no token covers, such as provider brand colors.
- **Charts.** Use `var(--color-*)` for series colors in SVG attributes, not hex
  values, so they follow the theme.

- **Surfaces.** Use the surface ladder, darkest to lightest: `bg`,
  `bg-elevated` (drawers), `surface-panel` (sidebar, cards, bubbles),
  `surface-raised` (buttons, tooltips), `control`, `surface-hover`,
  `surface-active` (selected rows). Use `fill-*` for translucent fills and
  `overlay-*` for scrims. Do not use `white/*` or `black/*` fills, borders, or
  rings, or hex surface colors. Shadows may use black.
- **Borders.** Use `border-subtle` for hairlines inside a surface,
  `border` for card edges, `border-strong` for shell edges, and
  `border-emphasis` or `border-interactive` for controls and hover.
- **Text.** Brightest to dimmest: `text-solid`, `text`, `text-subtle`,
  `text-muted`, `text-faint`.
- **Accent.** Lavender is the one brand accent. Use `accent` for icons,
  active markers, and tinted fills, such as `bg-dashboard-accent/10`. Use
  `accent-text` for links and accent text. Keep Tailwind palette colors for
  status (info, success, warning, error) and for categorical chart, event, and
  subagent colors.
- **Focus.** Use `outline-dashboard-focus` for keyboard focus. Do not use other
  colors for focus rings.
- **Type faces.** `font-sans` is the UI face for prose, controls, navigation,
  labels, and names. `font-display` is for headings, record titles, and large
  metric values. `font-mono` is for machine values: code, ids, paths, file
  names, tool names, and raw payloads. Show counts, times, and prices in
  `font-sans tabular-nums`.
- **Type scale.** Use the named steps `text-2xs` through `text-4xl`. Keep
  `text-2xs` for compact badges and chart annotations.
- **Labels.** Section, card, field, and column labels use
  `font-sans text-xs font-medium text-dashboard-text-muted` in sentence case.
  Do not use uppercase or letter spacing for labels.
- **Radius.** Controls and chips use `rounded-md`. Cards, list rows, and panels
  use `rounded-lg`. The composer, menus, and transcript object cards use
  `rounded-xl`. Avatars and count badges use `rounded-full`.

## Shared class helpers

`src/client/styles.ts` holds the few class strings that many components share.

- `cn` joins class names.
- `dashboardContainerClass` sets the page width.
- `dashboardInlineLinkClass` styles a neutral underlined link inside prose.
- `dashboardInteractiveTextClass` styles muted text that brightens on hover.
- `dashboardComposerSurfaceClass` styles the composer surface.

## Components

### Primitives

- **Actions.** `Button` (`default`, `primary`, `danger`, and `size="icon"`) and
  `ButtonLink`. Form pages use `Button tone="primary"` for their one main save
  action. Use `ToggleButton` variants (`pill`, `segment`, `text`) for pressed
  states, not one-off styles.
- **Forms.** `Field` (`default`, `compact`), `TextInput`, `TextArea`, `Select`,
  and `SearchInput`. Use `TextInput size="comfortable"` for larger mobile
  controls. Use `TextArea prose` for instructions, not code. `Field error`
  renders an error at `<htmlFor>-error`. The owning control must set
  `aria-invalid` and `aria-describedby`. `Select` owns the native control and its
  inset arrow. Use its `filter` and `sort` variants for compact controls.
- **Status.** Use `StatusDot` for dense table or list markers. Use `StatusChip`
  when the label must stay visible. `StatusChip` is a small dot and
  sentence-case text, with no border or fill. It is not a control.
- **Messages.** Use `Notice` for compact transient messages and `FormNotice`
  for wrapping form recovery text.
- **Overlays.** `ui/sheet.tsx` is the shadcn/ui Base UI Sheet. It uses Base UI
  Dialog for focus and dismissal. `Drawer` adds a visible header and close
  control. `BottomSheet` puts details below a title and close control. Both use
  the app's shared scroll lock, skip motion when reduced motion is set, and
  close with the close button, backdrop, or Escape. Docked conversation details
  use a non-modal aside so the chat stays usable. `Tooltip` and
  `IconButtonTooltip` own hover text.
- **Identity.** `ActorAvatar`, `ParticipantAvatarStack`, and `ObjectIcon`.
  `ObjectIcon` owns native Ticket, Code change, Automation, Deployment, and
  Item icons. It uses the shared type and status mapping and the original
  Octicons paths. Do not replace it with a provider logo or a status-only icon.
- **Loading.** Use `Skeleton` for placeholder leaves and `PageContentSkeleton`
  variants for page bodies. Use `PageRouteLoading` when a page keeps its real
  header above a body skeleton. Use a feature-owned loading component for
  distinct geometry, such as conversations.

### Navigation

The dashboard has three navigation levels. Each has its own look, so the
levels stay distinct.

- **App navigation** in `layout/DashboardHeader` uses pills.
- **Page links** use `SegmentedNav`, through `layout/SecondaryNavigation`. They
  are underline tabs that sit on the header border. With `fill`, links share
  the row width while their labels fit. Rows that do not fit scroll sideways.
- **Panel switches** use `SegmentedTabs`, which draws a pill track. Pass the
  selected value, items, change handler, and panel content. It owns tab and
  panel labels and keyboard focus. Pass `scroll` to keep the tabs fixed while
  the panel content scrolls. That mode fills its frame and owns the content
  padding, so its scrollbar stays at the frame edge. `BottomSheet` content owns
  its own padding.

Keep collection filters in `FilterTabList`.

### Patterns

- **Layout.** `layout/` holds the shell chrome, page headers, cards, and
  section titles. `DashboardChrome` owns the sticky header block and its one
  bottom border.
- **Directory tables and metrics.** `directory/` and `metrics/`.
- **Charts.** Activity time-series charts own bucket labels in
  `charts/ActivityChart` (`formatActivityDate` for axes,
  `ActivityChartTooltip` and `formatActivityTooltipDate` for hover labels). New
  day or hour charts compose those helpers. They do not format UTC bucket keys
  inline.
- **Conversation mobile geometry** is a hard ownership edge:
  - `layout/VisualViewportShell` owns the fixed shell, visualViewport CSS
    variables, and body lock.
  - `conversations/ChatLayout` owns the scroll-above-dock frame for reply
    threads.
  - `conversations/ComposerDock` owns the reply bottom pad and dock chrome.

  Pages pass children only. Home and create are one landing surface, not a
  dock, and must not use `ComposerDock`. Do not add viewport height, offset, or
  bottom safe-area math in page modules.

### Features

Feature surfaces stay under `conversations/` or `pages/` until two real callers
share them. Transcript layout stays in `conversations/`. See
[Transcript components](../conversations/README.md) for ownership.

## Rules

- Prefer a named component on the second real use.
- Keep Tailwind classes on the owning component.
- Add gallery fixtures under `/dev/<section>` for new or changed shared
  components. Keep the `/dev` index as the catalog only.
- One-off page glue may stay inline when extraction only adds indirection.
