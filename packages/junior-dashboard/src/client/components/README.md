# Dashboard UI kit

Shared dashboard components live here. Feature pages compose these surfaces
instead of copying Tailwind blocks.

## Layers

1. **Primitives** — `Button` / `ToggleButton`, `Field`, `TextInput`,
   `StatusChip`, `StatusDot`, `Notice`, `FormNotice`, `Select`, `Drawer`, `Tooltip`, `Skeleton`,
   `PageContentSkeleton`, `SegmentedTabs`, `SegmentedNav`, and other small reusable controls.
   Use the segmented pill track to pick one of a few siblings. Use
   `SegmentedTabs` to switch panels in place. Pass the selected value, items,
   change handler, and selected panel content. It owns tab/panel labels and
   keyboard focus. It draws the pill track. Use `SegmentedNav` for links
   between sibling pages. It draws underline tabs, not pills, so app nav
   (pills), page links (underlines), and panel switches (track) stay distinct. With
   `fill`, links share the row width equally while their labels fit. Otherwise
   each link keeps its label width. Rows that do not fit scroll sideways. Keep
   collection filters in `FilterTabList`. Prefer
   `ToggleButton` variants (`pill`, `segment`, `text`) over one-off pressed
   styles. Prefer `Field` sizes (`default`, `compact`) over handwritten labels.
   Prefer `StatusDot` for dense table or list status markers and `StatusChip`
   when the label itself must stay visible. `StatusChip` uses a small dot and
   sentence-case text, without a border, fill, or all-caps styling. It is not
   an interactive control. Prefer `PageContentSkeleton`
   variants over ad-hoc pulse blocks in route modules. Use `PageRouteLoading`
   when a standard page must keep its real header above a body skeleton. Use a
   feature-owned loading component for distinct geometry, such as conversations.
   `ObjectIcon` owns native Ticket, Code change, Automation, Deployment, and
   Item icons. It uses the shared type/status mapping and original Octicons
   paths. Do not replace it with a provider logo or a status-only icon.
   Structural colors live
   as slim `dashboard-*` tokens in `src/tailwind.css` (canvas, surface, text,
   border, fill, overlay, accent, focus). Prefer those roles over `white/*`, `black/*`,
   or hex literals. Status accents stay as Tailwind palette utilities.
2. **Patterns** — layout, filters, directory tables, charts, metrics.
   Activity time-series charts own bucket labels in
   `charts/ActivityChart` (`formatActivityDate` for axes,
   `ActivityChartTooltip` / `formatActivityTooltipDate` for hover labels).
   New day/hour charts should compose those helpers instead of formatting
   UTC bucket keys inline.
   Conversation mobile geometry is a hard ownership edge (see
   `policies/frontend-components.md`):
   - `layout/VisualViewportShell` — fixed shell, visualViewport CSS vars, body lock
   - `conversations/ChatLayout` — scroll-above-dock frame for reply threads
   - `conversations/ComposerDock` — reply bottom pad / dock chrome only
     Pages pass children only. Home and create are one landing surface, not a dock,
     and must
     not reuse `ComposerDock`. Do not invent viewport height, offset, or bottom
     safe-area math in page modules.
3. **Features** — stay under `conversations/` or `pages/` until a surface is
   shared by two real callers. Transcript layout stays in `conversations/`;
   see [Transcript components](../conversations/README.md) for ownership.
   Context panels use the shared `Drawer`, not a separate modal implementation.

## Foundations

- **Type.** `font-sans` is the UI face for prose, controls, navigation, and
  names. `font-display` is for page and conversation titles only. `font-mono`
  is for machine values: code, ids, paths, file names, and raw payloads. Show
  counts, times, and prices in `font-sans tabular-nums`.
- **Radius.** Controls and chips inside rows use `rounded-md`. Cards, list
  rows, and panels use `rounded-lg`. The composer, menus, and transcript
  cards use `rounded-xl`. Avatars and count badges use `rounded-full`.
- **Accent.** Lavender is the one brand accent. Use `dashboard-accent` for
  icons, active markers, and tinted fills, such as `bg-dashboard-accent/10`.
  Use `dashboard-accent-text` for links and accent text. Keep Tailwind palette
  colors for status (info, success, warning, error) and for categorical chart
  or event colors.
- **Focus.** Use `outline-dashboard-focus` for keyboard focus. Do not use
  other colors for focus rings.
- **Labels.** Section, card, field, and column labels use
  `font-sans text-xs font-medium text-dashboard-text-muted` in sentence case.
  Do not use uppercase or letter spacing for labels.
- **Surfaces.** Use the surface ladder in `src/tailwind.css`. Do not add
  `white/*` or `black/*` fills or borders.

## Rules

- Prefer a named component on the second real use.
- Keep Tailwind classes on the owning component.
- Add gallery fixtures under `/dev/<section>` for new or changed shared
  components. Keep the `/dev` index as the catalog only.
- One-off page glue may stay inline when extraction only adds indirection.

See `policies/frontend-components.md`.

Use `TextInput size="comfortable"` for larger mobile form controls.
Form pages use `Button tone="primary"` for their one main save action. Use
`TextArea prose` for instructions rather than code. `Field error` renders an
error at `<htmlFor>-error`; the owning control must set `aria-invalid` and
`aria-describedby`. `Select` matches native text controls. Use `FormNotice` for
wrapping form recovery text; use `Notice` for compact transient messages.
