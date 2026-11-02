# Dashboard UI kit

Shared dashboard components live here. Feature pages compose them instead of
copying Tailwind blocks. Follow `policies/frontend-components.md`.
`pnpm dashboard-style:check` enforces the token rules.

## shadcn/ui

- Add components with
  `pnpm --filter @sentry/junior-dashboard exec shadcn add <component>`. They go
  to `ui/`.
- `ui/` files are shadcn source on dashboard tokens. Remove unused exports.
  Change a `ui/` file when every caller needs the same style.
- Use `ui/` components directly. Add an app component only when it adds
  structure or behavior, not to rename a `ui/` component or its props.
- Do not apply the CLI's global border or body resets. Keep the Tailwind
  radius scale.

## Component rules

- Use `ui/alert-dialog` for every confirmation. Never use `window.confirm`.
- Use `ui/dialog` for a short task form. Never put a form in a `Drawer` or
  `DetailsPanel`. Use `useSheet` for each dialog and mount it only while open.
- Use `ui/trace` for transcript activity rows. Put only inline elements in
  the row button.
- Give an icon-only control a label with `TooltipContent size="compact"`.
  Never use the native `title` attribute.
- Set `focusableWhenDisabled` on a `ui/button` tooltip trigger that can be
  disabled.
- Build form fields from `ui/field`. Use the ids `<control id>-error` and
  `<control id>-help`.
- Put a checkbox or radio inside its `<label>`. Give each `RadioGroup` an
  `aria-label`.
- `ui/alert` sets `role="alert"`. Pass `role="status"` for a message that is
  not an error.
- A form page has one `Button variant="primary"`.
- `ObjectIcon` owns native object icons. Do not replace it with a provider
  logo.

## Tokens

- Keep every color in a token in `src/tailwind.css`, so each theme can
  redefine it. Use `light:` only for values that no token covers.
- Use `var(--color-*)` for chart series. Never use hex values.
- Do not use `white/*` or `black/*` fills, borders, or rings, or hex surface
  colors. Shadows may use black.
- Use `outline-dashboard-focus` for keyboard focus only.
- Use the named type scale. Keep `text-2xs` for compact badges and chart
  annotations.
- Labels use sentence case. Do not use uppercase or letter spacing.

## Navigation

- App navigation uses pills, page links use `SegmentedNav`, and panel
  switches use `ui/tabs`. Keep the three levels distinct.

## Ownership

- Conversation mobile geometry has hard owners: `layout/VisualViewportShell`,
  `conversations/ChatLayout`, and `conversations/ComposerDock`. Pages pass
  children only. Do not add viewport, offset, or safe-area math in pages.
- Home and create must not use `ComposerDock`.
- Feature surfaces stay under `conversations/` or `pages/` until two real
  callers share them. Add a named component on the second real use.
- Keep Tailwind classes on the owning component.
