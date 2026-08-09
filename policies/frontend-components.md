# Frontend Components

## Intent

Frontend code should make layout and styling ownership obvious at the component
that renders the UI. Do not hide product-specific presentation in large
stylesheets or semantic class contracts. Repeated product surfaces should share
named components so pages stay thin and taste stays consistent.

## Policy

- Prefer component-owned Tailwind utility classes over dashboard or feature
  stylesheets.
- Prefer small named components for repeated UI surfaces, such as `Field`,
  `Section`, `Toolbar`, `EmptyState`, or `StatusIndicator`, instead of repeated
  `<div className="field">` style hooks.
- Put repeated semantic surfaces in shared client components outside the route
  or page module. Charts, drawers, tables, secondary nav, and page time-range
  controls belong under a shared client area such as `components/`, not as
  copy-pasted route markup.
- Keep page modules thin. Compose shared components and wire data. Do not grow
  large one-off Tailwind blocks inside a page when the same surface already has,
  or should have, a named component.
- Do not add filler eyebrows or section labels that only restate the page title,
  chart purpose, or an obvious section role. If the page or chart title already
  names the content, skip decorative headers such as `Automation`,
  `Memory system`, or `Your trail`.
- Do not duplicate status or kind text when an icon, title, or other primary
  chrome already carries that fact. If a row shows a kind or status icon, do not
  also render labels such as `Event`/`Scheduled` or `Ready`/`Active` as
  secondary text for the same fact.
- Own page-level filters and secondary nav in one shared layout control. Charts
  and sections consume that control. They must not each own a duplicate
  time-range selector, secondary nav, or equivalent page chrome.
- Keep Tailwind classes colocated with the component or component-local helper
  that owns the markup.
- Use the named type scale from the dashboard Tailwind theme
  (`text-2xs` through `text-4xl`). Reserve `text-2xs` for compact badges and
  chart annotations. Use `text-xs` or larger for body copy, controls, subtext,
  and standalone metadata. Do not use arbitrary `text-[Nrem]` sizes.
- Use stylesheets only for Tailwind entry files, minimal global resets, vendor
  integration constraints, or selectors that cannot reasonably be represented
  with utilities.
- Avoid visual gradients by default in product UI. Use solid surfaces, borders,
  spacing, and status accents unless a gradient carries specific product meaning.
- Do not create broad semantic CSS class APIs for one-off feature UI.

## Exceptions

- Shared design-system packages may expose components whose internals are styled
  elsewhere.
- Third-party rendered markup may need narrow wrapper selectors when utilities
  cannot reach the generated DOM safely.
- A page may keep truly one-off layout glue inline when it is not a repeated
  product surface and extracting it would only add indirection.
