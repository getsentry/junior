# Provider Boundaries

## Intent

Keep each provider SDK and its data inside the module that owns the provider.
Shared Junior code must use small Junior-owned types. It must not depend on
Slack, Vercel, GitHub, or another provider SDK.

## Policy

- Keep SDK clients, response types, errors, webhook data, and formatting rules
  in the module or feature that owns the provider.
- Shared code must use Junior-owned types. Examples include `Destination`,
  `Source`, actor identity, a local interface, or a feature-owned view.
- Put provider actions behind a small local interface or a provider-owned
  service. Do not import a provider client into shared runtime, service, state,
  reporting, or tool code.
- Tests for one provider may use its SDK types. Tests outside that provider
  must use its public adapter or a Junior runtime interface.
- When provider behavior must enter shared code, name the interface for its
  product role. Keep the SDK type private to the provider module.

## Exceptions

- Provider modules, provider tools, and inbound adapters may read raw provider
  data and call provider SDKs.
- App setup code may connect a provider implementation to a Junior interface.
  It must not perform the provider action itself.
- Existing runtime code may keep old provider imports while maintainers remove
  them. New code must not add more provider SDK types there.
