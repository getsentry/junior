# Security Policy Backfill Worksheet

## Canonical Spec

- New spec: `security-policy`
- Existing source: `specs/security-policy.md`

## Local Artifacts Reviewed

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
- `packages/junior/src/chat/plugins/auth/oauth-request.ts`
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

## External Sources

- Vercel Sandbox firewall proxying changelog: https://vercel.com/changelog/vercel-sandbox-firewall-now-supports-request-proxying-and-filtering
- Vercel Sandbox authentication docs: https://vercel.com/docs/vercel-sandbox/concepts/authentication
- OAuth 2.0 Security Best Current Practice, RFC 9700: https://www.rfc-editor.org/rfc/rfc9700
- Slack `chat.postEphemeral` docs: https://docs.slack.dev/reference/methods/chat.postEphemeral
- GitHub App installation token docs: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app

## Current Behavior Summary

- User-influenced command execution is intended to run in sandboxed environments with ephemeral/untrusted filesystems.
- Provider-capable sandbox egress uses Vercel network policy forwarding for registered plugin domains.
- Forwarded sandbox requests must carry a Vercel Sandbox OIDC token and Vercel forwarded routing headers.
- Junior verifies OIDC before routing, requires a signed requester context token, and requires the signed requester context's sandbox id to match the verified sandbox id.
- Provider leases are requester-, sandbox-, provider-, and context-scoped. Duplicate request shapes are allowed and may reuse a lease until expiry or upstream auth rejection.
- Host-managed header transforms carry real credentials; sandbox command env receives placeholders and non-secret command values.
- OAuth bearer credentials are requester-bound when a requester exists and refresh on the host.
- OAuth authorization links are privately delivered and never made model-visible or visibly posted in a channel.
- Authorization resume state is represented in the session log as runtime authorization events and projected into Pi as host-authored observations.

## Intended Behavior

- Global security policy sets invariants across narrower specs.
- Provider registrations authorize lazy egress injection only for declared domains; registration alone must not mint credentials.
- Runtime paths without requester context must fail for user-owned provider access instead of issuing reusable credentials.
- Agent-visible prompts/history must not contain raw auth URLs, access tokens, refresh tokens, OAuth codes, private keys, or provider secret headers.
- New privileged behavior must include verification for success, failure, expiry/refresh, and redaction.

## Undefined Behavior

| Question                           | Current Evidence                                                                                     | Candidate Decision                                                           | Status   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| Security exception process         | No waiver template or owner/expiry rule.                                                             | Require a follow-up OpenSpec change for any exception.                       | open     |
| Production network deny semantics  | Code builds Vercel policy; exact platform enforcement belongs to Vercel.                             | Keep explicit allowlist requirement and verify deployed behavior separately. | open     |
| Automated log secret scanning      | Policy is clear; broad tests are absent.                                                             | Add targeted tests when adding privileged log events.                        | open     |
| Static token fallback environments | Code allows fallback without requester; policy narrows it to local/dev/test outside requester turns. | Track enforcement in plugin-auth/config specs.                               | open     |
| Exact lease/token TTLs             | Existing defaults/caps are implementation details.                                                   | Require bounded expiry here; exact durations owned by auth specs.            | deferred |

## Migration Notes

- Keep `specs/security-policy.md` as canonical prose until this OpenSpec baseline is accepted.
- On acceptance, update `specs/index.md` and known-spec pointers to identify OpenSpec `security-policy` as the behavioral baseline.
- Do not archive provider-specific sections until `credential-injection`, `oauth-flows`, and `plugin-auth` are consolidated with this global invariant spec.

## Validation

- `openspec validate backfill-security-policy --strict` passed.
