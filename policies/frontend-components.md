# Frontend Components

## Intent

Frontend code should make layout and styling ownership obvious at the component
that renders the UI, instead of hiding product-specific presentation in large
stylesheets or semantic class contracts.

## Policy

- Prefer component-owned Tailwind utility classes over dashboard or feature
  stylesheets.
- Prefer small named components for repeated UI surfaces, such as `Field`,
  `Section`, `Toolbar`, `EmptyState`, or `StatusIndicator`, instead of repeated
  `<div className="field">` style hooks.
- Keep Tailwind classes colocated with the component or component-local helper
  that owns the markup.
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
