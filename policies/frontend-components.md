# Frontend Components

## Intent

The component that renders UI owns its layout and styling. Repeated product
surfaces share named components, so pages stay thin and the look stays
consistent.

## Policy

### Components

- Put repeated surfaces (charts, drawers, tables, secondary nav, time-range
  controls, `Field`, `Input`, `StatusChip`, `Section`, `Toolbar`,
  `EmptyState`) in shared components. Dashboard home:
  `packages/junior-dashboard/src/client/components/`. See its `AGENTS.md`.
- Extract on the second real use, or when a third use is certain. Not on taste.
- Keep pages thin: compose shared components and wire data.
- Own page filters and secondary nav in one shared layout control. Sections
  must not each own a copy.
- Check a changed shared component on a real page with
  `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true pnpm dev` and the dashboard E2E
  screenshots.

### Styling

- Use Tailwind utilities colocated with the component that owns the markup.
- Use stylesheets only for Tailwind entry files, minimal resets, vendor
  constraints, or selectors utilities cannot express. No semantic CSS class
  APIs for one-off UI.
- Use the theme type scale (`text-2xs` to `text-4xl`). `text-2xs` is only for
  compact badges and chart notes; body copy, controls, and metadata use
  `text-xs` or larger. No arbitrary `text-[Nrem]`.
- No gradients unless they carry product meaning.
- Data tables: `table-fixed`, equal fixed widths for metric and status
  columns, only the label column flexes, a minimum width, and horizontal
  scroll on narrow screens.

### Loading

- Keep page chrome (title, nav, filters, actions, split panes) visible while
  data loads.
- A loading region uses a named loading component beside the finished one. It
  matches structure, spacing, row count, media size, and text height.
- Replace only the pending region. Keep existing results during refresh,
  filter, and sort, and show pending feedback.
- Use `Skeleton` for leaves and `PageContentSkeleton` for page bodies. Hide
  leaves from assistive technology. Give the region one status label.
- Stop skeleton motion for reduced motion. No centered progress card when the
  page structure is known.

### Content

- No filler eyebrows or labels that restate the page or chart title.
- Do not repeat a status or kind in text when an icon or title already shows
  it.

### Conversation mobile geometry

- `layout/VisualViewportShell` owns the fixed shell, visualViewport CSS
  variables, and body scroll lock.
- `conversations/ChatLayout` owns the scroll-above-dock frame.
- `conversations/ComposerDock` owns the bottom pad and dock chrome.
- Pages pass children only. They must not compute viewport height, offsets,
  bottom pad, or `env(safe-area-inset-bottom)` for the composer.
- Home and create are one landing surface, not a dock. `/conversations/new`
  redirects to `/`.

## Exceptions

- No published design-system package unless a second product shares the
  components.
- Third-party markup may need narrow wrapper selectors.
- A page may keep one-off layout glue inline when it is not a repeated surface.
