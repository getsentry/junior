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
The `ui/` files join classes with the merging `cn` from
`src/client/lib/utils.ts`, so a caller's `className` wins over a base class.

The shadcn color tokens in `src/tailwind.css` use the dashboard tokens in both
themes. The `dark:` variant follows `data-theme`. Keep the existing Tailwind
radius scale. Do not apply the CLI's global border or body resets. Check each
added component against the rules below before use.

Each `ui/` file is shadcn source that uses dashboard tokens. Remove exports
that no app code uses. Use `ui/` components directly. Do not add an app
component that only renames a `ui/` component or its props. Change the `ui/`
file when every caller needs the same style or variant. App components compose
`ui/` source only when they add structure or behavior:

| App component                  | shadcn source     |
| ------------------------------ | ----------------- |
| `Drawer`, `BottomSheet`        | `ui/sheet`        |
| `layout/DashboardHeader` (nav) | `ui/sheet`        |
| `ProfileMenu` (desktop)        | `ui/popover`      |
| `TimeRangeSelector`            | `ui/toggle-group` |
| `ThemeSwitcher`                | `ui/toggle-group` |
| `TranscriptViewToggle`         | `ui/toggle-group` |
| `FilterTabList`                | `ui/tabs`         |
| `charts/ActivityChartTooltip`  | `ui/tooltip`      |
| `conversations/ToolFrame`      | `ui/trace`        |
| `TranscriptReasoningView`      | `ui/trace`        |
| `ImageAttachment` (preview)    | `ui/dialog`       |
| `Notice`, `InlineError`        | `ui/alert`        |
| App banners                    | `ui/alert`        |
| Recharts activity charts       | `ui/chart`        |

Rules for adopted components:

- Use `ui/trace` for transcript activity rows. It composes `ui/collapsible`.
  A closed tool row unmounts its panel, so it does not run Shiki. Reasoning
  sets `hiddenUntilFound`, so browser find reaches closed text. Transcript
  search holds rows open and turns off the row button. Put only inline
  elements, such as `span`, inside the row button.
- Use `ui/alert-dialog` for every confirmation. Do not use `window.confirm`.
  Keep the confirmed item in state after close, so the closing dialog keeps its
  text.
- Use `useSheet` for each app `ui/dialog`, as for sheets. It shares the
  document scroll lock. Only the front modal closes on Escape or a backdrop
  tap. Mount the dialog only while it is open.
- `ui/alert` sets `role="alert"`. Pass `role="status"` for a message that is
  not an error.
- `ui/toast` has no global notification manager. Features call
  `useToastManager` inside the mounted `Toaster` provider.
- Put a checkbox or radio inside its `<label>`. Give each `RadioGroup` an
  `aria-label`.
- Give an icon-only control its label with `TooltipContent size="compact"`.
  Do not use the native `title` attribute. Tooltips open on mouse hover and
  keyboard focus only, so a tap still runs the control.
- When a `ui/button` tooltip trigger can be disabled, set
  `focusableWhenDisabled`. A native disabled button can drop hover and focus,
  so Firefox closes the tooltip and hides pending or result labels.
  `ui/button` styles `data-disabled`, so both disabled modes look the same.
- Build a form field from `ui/field`. Give `FieldError` the id
  `<control id>-error` and `FieldDescription` the id `<control id>-help`. The
  control sets `aria-invalid` and `aria-describedby`.
- Use `Button size="menu"` for a full-width icon and label row in a mobile
  overflow menu. A pressed row adds `bg-dashboard-fill-strong`.
- For a link that looks like a button, put `buttonVariants()` on the router
  `Link`. A form page has one `Button variant="primary"` for its main save
  action.

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
- **Charts.** Use `var(--color-*)` for series colors, not hex values, so they
  follow the theme. Name series colors in the `ChartContainer` config and fill
  each series with `var(--color-<key>)`.
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

Shared class strings live in `src/client/styles.ts`.

## App components

- **Status.** Use `StatusDot` for dense table or list markers. Use `StatusChip`
  when the label must stay visible. `StatusChip` is not a control.
- **Messages.** Use `Notice` for compact transient messages and `FormNotice`
  for wrapping form recovery text.
- **Disclosure.** Use `ui/collapsible` for one show-or-hide section. Put a
  `ChevronRight` with `dashboardDisclosureChevronClass` in a `group` trigger.
  Set `hiddenUntilFound` on the content when browser find must reach closed
  text. Closed content then keeps its box, so put margins and padding on a
  child. Use `ui/accordion` for a set of sections with headings.
- **Details.** `DetailsPanel` docks an aside at 1280px and above, and uses a
  `BottomSheet` below that width. It owns Escape and the scroll frame for
  docked panels.
- **Identity.** `ObjectIcon` owns the native Ticket, Code change, Automation,
  Deployment, and Item icons. Do not replace it with a provider logo or a
  status-only icon.
- **Loading.** Use `ui/skeleton` for placeholder leaves and `PageContentSkeleton`
  variants for page bodies. Use `PageRouteLoading` when a page keeps its real
  header above a body skeleton. Use a feature-owned loading component for
  distinct geometry, such as conversations.

## Navigation

The dashboard has three navigation levels. Each has its own look, so the
levels stay distinct.

- **App navigation** in `layout/DashboardHeader` uses pills.
- **Page links** use `SegmentedNav`, through `layout/SecondaryNavigation`. They
  are underline tabs that sit on the header border.
- **Panel switches** use `ui/tabs`. Give `TabsList` an `aria-label`. Set
  `activateOnFocus` so arrow keys select the tab.

Keep collection filters in `FilterTabList`. It uses `TabsList variant="line"`
and adds the count badges.

## Patterns

- **Layout.** `layout/` holds the shell chrome, page headers, cards, and
  section titles. `DashboardChrome` owns the sticky header block and its one
  bottom border.
- **Charts.** Put `role="img"` and the chart `aria-label` on the Recharts
  chart, so the tooltip live region stays outside the image. Day and hour
  charts compose the `charts/ActivityChart` axis, average line, and tooltip
  helpers. They do not format UTC bucket keys inline.
- **Conversation mobile geometry** is a hard ownership edge:
  - `layout/VisualViewportShell` owns the fixed shell, visualViewport CSS
    variables, and body lock.
  - `conversations/ChatLayout` owns the scroll-above-dock frame for reply
    threads.
  - `conversations/ComposerDock` owns the reply bottom pad and dock chrome.

  Pages pass children only. Home and create are one landing surface, not a
  dock, and must not use `ComposerDock`. Do not add viewport height, offset, or
  bottom safe-area math in page modules.

Feature surfaces stay under `conversations/` or `pages/` until two real callers
share them. See [Transcript components](../conversations/README.md) for
transcript ownership.

## Rules

- Prefer a named component on the second real use.
- Keep Tailwind classes on the owning component.
- Check new or changed shared components on a real page with mock data and in
  the dashboard E2E screenshots.
- One-off page glue may stay inline when extraction only adds indirection.
