# Dashboard UI rules

These apply to all dashboard UI. `pnpm dashboard-style:check` enforces the
token rules.

- Add shadcn components with
  `pnpm --filter @sentry/junior-dashboard exec shadcn add <component>`.
- Change a `ui/` file only when every caller needs the same style. Do not
  wrap a `ui/` component just to rename it or its props.
- Do not apply the shadcn CLI's global border or body resets. Keep the
  Tailwind radius scale.
- Confirmations use `ui/alert-dialog`, not `window.confirm`.
- Short task forms use `ui/dialog`, never a `Drawer` or `DetailsPanel`. Mount
  each dialog through `useSheet`, only while open.
- Put only inline elements in a `ui/trace` row button.
- Label icon-only controls with `TooltipContent size="compact"`, not the
  native `title` attribute.
- Set `focusableWhenDisabled` on a tooltip trigger `ui/button` that can be
  disabled.
- Field ids are `<control id>-error` and `<control id>-help`.
- Put a checkbox or radio inside its `<label>`. Give each `RadioGroup` an
  `aria-label`.
- A form page has one `Button variant="primary"`.
- Do not replace `ObjectIcon` with a provider logo.
- Use `light:` only for values that no token covers. Chart series use
  `var(--color-*)`, not hex.
- Use `outline-dashboard-focus` for keyboard focus only.
- Labels use sentence case, with no uppercase or letter spacing.
- App navigation uses pills, page links use `SegmentedNav`, and panel
  switches use `ui/tabs`.
- Do not add viewport, offset, or safe-area math in pages.
  `layout/VisualViewportShell`, `conversations/ChatLayout`, and
  `conversations/ComposerDock` own it. Home and create do not use
  `ComposerDock`.
- Keep a feature component under `conversations/` or `pages/` until a second
  real caller needs it.
