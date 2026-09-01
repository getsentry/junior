# Provider Boundaries

## Intent

Keep domain-specific behavior in the plugin that owns the domain. Core owns the
runtime and the provider-neutral contracts that plugins use.

## Policy

- Put all behavior for a provider in its plugin package. This includes API
  routes, request and response rules, permissions, errors, webhooks, formatting,
  and provider-specific policy.
- Core must not import a plugin package. The dependency check enforces this for
  `@sentry/junior-*` plugin imports from `packages/junior/src`.
- Core may expose a small provider-neutral contract when a plugin needs a new
  runtime capability. The plugin supplies the provider-specific data and
  decisions through that contract.
- Do not add a provider name, host, route, API field, permission, or error rule
  to core when a plugin can own it. Static checks cannot find every case, so
  reviewers must apply this rule to values and control flow as well as imports.
- Shared code must use Junior-owned types. Examples include `Destination`,
  `Source`, actor identity, a local interface, or a feature-owned view.
- A Junior-owned runtime contract may carry provider fields in Source, Actor,
  or Location when the agent or its tools need them. Their presence must not
  select another runtime or grant provider delivery. Keep provider decisions
  with the provider owner.
- Tests for one provider may use its SDK types. Tests outside that provider
  must use its public adapter or a Junior runtime contract.

## Exceptions

- Core may own provider-neutral dispatch, plugin registration, credential
  transport, and egress transport.
- App setup code may connect a plugin implementation to a Junior contract. It
  must not perform the provider action itself.
- Slack runtime and delivery code remains in core until Slack is a plugin. Keep
  Slack behavior in Slack-owned modules and out of shared services.
- Existing domain-specific core behavior is debt, not a pattern for new code.
  Move it to the owning plugin when the touched contract makes that practical.
