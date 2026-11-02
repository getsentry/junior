# Plugin API

- Keep the package provider-neutral. Add the smallest contract that a plugin
  needs. Core keeps ownership of the runtime behind it.
- Export one factory named `<domain>Plugin`, not `create<Domain>Plugin` or a
  prebuilt registration. Do not define one plugin both inline and in YAML.
- Source `kind` never names a provider. Actor and Destination use `platform`.
- Prompt hooks return bounded messages and never change the core prompt.
- `conversationTitleContext` reads through `ctx.egress` with the system
  identity and never starts authorization.
- Scheduler task credential subjects come only from the scheduler plugin and
  bind to the exact task id.
- Plugins never get provider credentials for host model or embedding calls.
- Plugins never mount page routes or browser code.
- Admin-only API routes check `context.auth.user.isAdmin` on the server.
- Heartbeat hooks and migrations must be safe to run again.
- Keep earlier versions of a conversation event registered. Versions share one
  idempotency identity.
- Migrations are expand-first. Access to core or other plugin tables is a
  review boundary.
- CLI actions never get model, Slack, sandbox, or provider credential context.
- Object annotations hold only facts that the provider returned and that the
  current Conversation may see. They never grant provider access.
