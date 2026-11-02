# Plugin API

## Intent

- This package is the public contract between Junior and code plugins.
  Exported types and runtime validators are authoritative.
- Keep it provider-neutral. Follow `policies/provider-boundaries.md`.
- Add the smallest contract that a plugin needs. Core keeps ownership of the
  runtime behind it.

## Registration

- A plugin name is a unique lowercase identifier in the app plugin set.
- A package with JavaScript registration exports one factory named
  `<domain>Plugin`. Do not export `create<Domain>Plugin` or a prebuilt
  registration.
- A package with no host hooks may use `plugin.yaml` instead. Never define
  one plugin both inline and in YAML.
- The `junior` plugin name is reserved for native events.

## Hooks

- Hook context carries only the host capabilities that the hook needs.
- Source `kind` never names a provider. Actor and Destination use `platform`.
- Prompt hooks return bounded messages. They never change the core prompt.
- `formatMarkdown` is a pure text rewrite.
- `conversationTitleContext` reads through `ctx.egress` with the system
  identity and never starts authorization.
- Plugins never get provider credentials for host model or embedding calls.
- Core owns sandbox lifecycle, cancellation, egress, and authorization
  recovery.
- User page readers return limited data. Plugins never mount page routes or
  browser code.
- Admin-only API routes must check `context.auth.user.isAdmin` on the server.
  A hidden link does not protect a route.

## Durable work

- Heartbeat hooks and migrations must be safe to run again.
- `ctx.agent.dispatch` needs an explicit actor, destination, source, and
  idempotency identity.
- Scheduler task credential subjects come only from the scheduler plugin and
  bind to the exact task id.
- Keep earlier versions of a conversation event registered. Versions share one
  idempotency identity.

## Database

- Generate migrations from the package schema. Do not keep a second schema.
- Migrations are expand-first and ordered by plugin name. A failure blocks the
  upgrade.
- Access to core or other plugin tables is a review boundary.

## CLI and annotations

- CLI actions never get model, Slack, sandbox, or provider credential context.
- Object annotations hold only facts that the provider returned and that the
  current Conversation may see. They never grant provider access.
