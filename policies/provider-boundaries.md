# Provider Boundaries

## Intent

Provider integrations should keep platform SDKs, payload shapes, formatting
rules, and transport details inside the provider-owned module. Cross-provider
runtime, service, state, plugin, and reporting code should depend on small
Junior contracts instead of Slack, Vercel, GitHub, or other provider primitives.

## Policy

- Provider SDK clients, SDK response types, SDK errors, raw webhook payloads,
  and provider-specific formatting primitives belong in the provider-owned
  module or feature folder.
- Cross-provider code should accept Junior-owned contracts such as
  `Destination`, `Source`, requester identity, local ports, or feature-owned
  projections instead of provider SDK types.
- Provider-specific side effects must be exposed through narrow capability
  ports or provider-owned services. Do not import provider infrastructure to
  "just call the client" from runtime, service, state, reporting, or generic
  tool code.
- Provider-owned tests and fixtures may use provider primitives directly.
  Product behavior tests outside the provider should exercise provider behavior
  through the public adapter or runtime boundary.
- If provider-specific behavior must cross a boundary, name the boundary by the
  product role and keep the provider type private to the implementation.

## Exceptions

- Provider modules, provider feature tools, and ingress adapters may parse raw
  provider payloads and call provider SDKs.
- Composition roots may wire provider implementations to provider-neutral
  interfaces, but they should not perform provider behavior themselves.
- Existing legacy runtime code may keep provider imports while it is being
  simplified, but new code should not add more provider primitives there.
