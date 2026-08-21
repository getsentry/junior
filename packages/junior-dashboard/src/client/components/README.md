# Dashboard UI kit

Shared dashboard components live here. Feature pages compose these surfaces
instead of copying Tailwind blocks.

## Layers

1. **Primitives** — `Button` / `ToggleButton`, `Field`, `TextInput`,
   `StatusChip`, `Notice`, `Drawer`, `Tooltip`, and other small reusable
   controls. Prefer `ToggleButton` variants (`pill`, `segment`, `text`) over
   one-off pressed styles. Prefer `Field` sizes (`default`, `compact`) over
   handwritten labels. Structural colors live as slim `dashboard-*` tokens in
   `src/tailwind.css` (canvas, surface, text, border, fill, overlay, focus).
   Prefer those roles over `white/*`, `black/*`, or hex literals. Status accents
   stay as Tailwind palette utilities.
2. **Patterns** — layout, filters, directory tables, charts, metrics.
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
   shared by two real callers.

## Rules

- Prefer a named component on the second real use.
- Keep Tailwind classes on the owning component.
- Add gallery fixtures under `/dev/<section>` for new or changed shared
  components. Keep the `/dev` index as the catalog only.
- One-off page glue may stay inline when extraction only adds indirection.

See `policies/frontend-components.md`.
