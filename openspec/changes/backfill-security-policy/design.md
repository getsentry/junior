## Context

Junior's security policy spans several feature boundaries:

- Sandbox execution and outbound provider traffic.
- Provider credential brokers and header transforms.
- OAuth and MCP authorization flows.
- Plugin manifests and command environments.
- Slack delivery privacy.
- Logging, tracing, and operational response.

The current canonical policy is intentionally global. The OpenSpec capability should preserve that shape while avoiding duplicate ownership of provider-specific protocols. The baseline therefore specifies invariants that every owning implementation must satisfy and references narrower specs for mechanics.

## Prior Art

- Vercel Sandbox firewall request proxying supports forwarding matching HTTPS requests to a controlled proxy and sends original-request headers plus a Vercel-issued Sandbox OIDC token for request identity: https://vercel.com/changelog/vercel-sandbox-firewall-now-supports-request-proxying-and-filtering
- Vercel Sandbox authentication recommends OIDC tokens for authenticating SDK access: https://vercel.com/docs/vercel-sandbox/concepts/authentication
- OAuth 2.0 Security Best Current Practice emphasizes CSRF/state integrity and confidential-client authentication around authorization-code exchange: https://www.rfc-editor.org/rfc/rfc9700
- Slack `chat.postEphemeral` sends a message visible only to the assigned user in a conversation, but delivery is not guaranteed and requires channel membership/activity: https://docs.slack.dev/reference/methods/chat.postEphemeral
- GitHub App installation access tokens are minted by exchanging an App JWT for an installation token, can be permission-reduced, and expire after one hour: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app

## Local Evidence

- `specs/security-policy.md`
- `specs/credential-injection.md`
- `specs/oauth-flows.md`
- `specs/plugin.md`
- `specs/plugin-runtime.md`
- `specs/plugin-manifest.md`
- `specs/slack-agent-delivery.md`
- `specs/slack-outbound-contract.md`
- `packages/junior/src/chat/sandbox/egress-policy.ts`
- `packages/junior/src/chat/sandbox/egress-proxy.ts`
- `packages/junior/src/chat/sandbox/egress-oidc.ts`
- `packages/junior/src/chat/sandbox/egress-session.ts`
- `packages/junior/src/chat/credentials/broker.ts`
- `packages/junior/src/chat/credentials/header-transforms.ts`
- `packages/junior/src/chat/plugins/auth/api-headers-broker.ts`
- `packages/junior/src/chat/plugins/auth/github-app-broker.ts`
- `packages/junior/src/chat/plugins/auth/oauth-bearer-broker.ts`
- `packages/junior/src/chat/oauth-flow.ts`
- `packages/junior/src/chat/services/plugin-auth-orchestration.ts`
- `packages/junior/src/chat/services/mcp-auth-orchestration.ts`
- `packages/junior/src/chat/state/session-log.ts`
- `packages/junior/tests/unit/handlers/sandbox-egress-proxy.test.ts`
- `packages/junior/tests/integration/sandbox-egress-proxy.test.ts`
- `packages/junior/tests/unit/plugins/github-app-broker.test.ts`
- `packages/junior/tests/unit/plugins/sentry-broker.test.ts`
- `packages/junior/tests/unit/plugins/api-headers-broker.test.ts`
- `packages/junior/tests/unit/handlers/oauth-callback.test.ts`
- `packages/junior/tests/integration/oauth-resume-slack.test.ts`
- `packages/junior/tests/integration/mcp-oauth-callback-slack.test.ts`
- `packages/junior/tests/unit/state/session-log.test.ts`

## Behavior Extraction

- Sandbox network policy is generated from registered plugin provider domains and forwards matching domains to Junior's internal egress proxy.
- The egress proxy verifies a Vercel Sandbox OIDC token before trusting forwarded routing headers or issuing credentials.
- The requester context is a signed token embedded in the proxy route; it must match the verified sandbox id and have a non-expired requester-bound context.
- Provider resolution is based on forwarded host and registered provider domains, not model arguments.
- Provider leases are cached by provider, requester id, sandbox id, and context id, and are cleared after upstream auth rejection.
- Header transforms inject real provider credentials only at the host proxy boundary. Sandbox env receives placeholders for auth env vars.
- OAuth bearer brokers prefer requester-bound stored tokens, refresh near-expiry tokens on host, enforce required scopes, and fall back to static env tokens only when no requester-bound OAuth path is used.
- GitHub App broker signs host-only App JWTs, exchanges them for installation access tokens, and maps REST versus git HTTPS domains to Bearer or Basic header transforms.
- OAuth and MCP authorization links are privately delivered through ephemeral/channel-private or DM paths; visible acknowledgements omit URLs.
- Authorization completion is modeled as a session-log event and projected as a host-authored observation instead of prompt-level hidden state.
- Logs use metadata attributes for provider, host, path, outcome, and expiry; policy forbids token/private-key/raw Authorization values.

## Open Questions / Undefined Behavior

| Question                                                                                           | Current Evidence                                                                                                                | Candidate Decision                                                                                          | Status   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| What is the approved exception process for temporary network egress or secret exposure exceptions? | Policy says minimal allowlists and no real sandbox secrets, but no waiver path exists.                                          | Require a spec change with owner, expiry, verification, and rollback before any exception.                  | open     |
| Should production reject all non-proxied outbound sandbox domains by default?                      | `buildSandboxEgressNetworkPolicy()` returns `{"*": []}` plus provider domains; enforcement depends on Vercel Sandbox semantics. | Keep explicit allowlist invariant; add deployment verification if semantics change.                         | open     |
| Should automated secret-scanning assertions be required for logs?                                  | Policy requires no secrets in logs; tests cover some header stripping but not broad log scanning.                               | Add targeted redaction tests only when adding new privileged log events.                                    | open     |
| What is the exact boundary for static env-token fallback in OAuth brokers?                         | Code allows env fallback when no requester token is present; policy says local/dev/test outside requester turn execution.       | Keep as global invariant and let `plugin-auth`/configuration decide mode-specific enforcement.              | open     |
| How long should requester context tokens and leases live?                                          | Current egress token default is 30 minutes; credential leases cap at one hour.                                                  | Avoid freezing exact durations here; require bounded expiry and provider-specific specs own numbers.        | deferred |
| Should OAuth links include PKCE for all providers?                                                 | OAuth BCP recommends PKCE broadly, but current implementation relies on confidential client secret plus state.                  | Track in `oauth-flows`; do not make a security-policy requirement until provider compatibility is reviewed. | deferred |

## Decisions

### Decision: Represent security as an OpenSpec capability

Security is not only policy prose in this repo. It is a behavior contract enforced by proxy routing, credential brokers, Slack delivery paths, and session-log projection. Backfilling it into OpenSpec makes those invariants discoverable and testable.

### Decision: Keep mechanics in narrower specs

`security-policy` defines cross-cutting invariants. Provider-specific auth, OAuth callback details, sandbox tool behavior, Slack delivery details, and telemetry schemas remain owned by their narrower capability specs.

### Decision: Authorization state belongs to session history

The recent auth-resume boundary change is consistent with prior art: authorization is a runtime interrupt and resume event, not prompt state. The security baseline requires no raw URLs or secrets in model-visible context and requires completed auth to be represented as host-authored chronological session history.

## Verification Strategy

- Unit tests cover egress token parsing, OIDC discovery/JWKS validation, forwarded routing rejection, lease scoping, header stripping, placeholder env, GitHub broker leases, OAuth bearer refresh/scope handling, and OAuth callback validation.
- Integration tests cover plugin-backed egress wiring and intercepted credential-injected traffic.
- Eval coverage belongs to OAuth/private-link behavior and resumed provider command success, not raw security primitives.
- Manual/security review remains required for new secret custody paths, new provider credential types, new sandbox network policy behavior, and logging/tracing additions that may include sensitive attributes.
