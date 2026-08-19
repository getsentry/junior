# Dashboard UI kit

Shared dashboard components live here. Feature pages compose these surfaces
instead of copying Tailwind blocks.

## Layers

1. **Primitives** — `Button`, `Field`, `TextInput`, `StatusChip`, `Notice`,
   `Drawer`, `Tooltip`, and other small reusable controls.
2. **Patterns** — layout, filters, directory tables, charts, metrics.
3. **Features** — stay under `conversations/` or `pages/` until a surface is
   shared by two real callers.

## Rules

- Prefer a named component on the second real use.
- Keep Tailwind classes on the owning component.
- Add gallery fixtures under `/dev/<section>` for new or changed shared
  components. Keep the `/dev` index as the catalog only.
- One-off page glue may stay inline when extraction only adds indirection.

See `policies/frontend-components.md`.
