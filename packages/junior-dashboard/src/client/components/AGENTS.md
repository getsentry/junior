# Dashboard UI kit

Feature pages compose these components instead of copying Tailwind blocks.
`pnpm dashboard-style:check` enforces the token rules.

## shadcn/ui

- Add components with
  `pnpm --filter @sentry/junior-dashboard exec shadcn add <component>`. They go
  to `ui/`.
- `ui/` files are shadcn source on dashboard tokens. Remove unused exports.
  Change a `ui/` file only when every caller needs the same style.
- Use `ui/` components directly. Add an app component only for new structure
  or behavior, not to rename a `ui/` component or its props.
- Do not apply the CLI's global border or body resets. Keep the Tailwind
  radius scale.

## Component rules

- Confirmations use `ui/alert-dialog`, not `window.confirm`.
- Short task forms use `ui/dialog`, never a `Drawer` or `DetailsPanel`. Use
  `useSheet` for each dialog and mount it only while open.
- Transcript activity rows use `ui/trace`. Put only inline elements in the
  row button.
- Label icon-only controls with `TooltipContent size="compact"`, not the
  native `title` attribute.
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
- Chart series use `var(--color-*)`, not hex values.
- No `white/*` or `black/*` fills, borders, or rings, and no hex surface
  colors. Shadows may use black.
- Use `outline-dashboard-focus` for keyboard focus only.
- Use the named type scale. Keep `text-2xs` for compact badges and chart
  annotations.
- Labels use sentence case, with no uppercase or letter spacing.

## Navigation

- App navigation uses pills, page links use `SegmentedNav`, and panel
  switches use `ui/tabs`. Keep the three levels distinct.

## Ownership

- `layout/VisualViewportShell`, `conversations/ChatLayout`, and
  `conversations/ComposerDock` own conversation mobile geometry. Pages pass
  children only, with no viewport, offset, or safe-area math.
- Home and create do not use `ComposerDock`.
- Feature surfaces stay under `conversations/` or `pages/` until a second
  real caller needs them.
- Keep Tailwind classes on the owning component.
