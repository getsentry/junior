# Security

Security rules apply to host runtime code, sandbox execution, provider
credentials, plugins, skills, and operational telemetry.

## Defaults

- Run user-influenced commands in an isolated sandbox.
- Treat sandbox filesystems and process state as ephemeral and untrusted.
- Keep long-lived secrets in host-managed storage.
- Prefer short-lived, least-privilege credentials.
- Never place real credentials in repository files, skills, prompts, model tool
  arguments, sandbox environment variables, files, command arguments, logs, or
  traces.

## Sandbox Egress

- Credential-capable provider traffic goes through the host egress proxy.
- Verify the Vercel Sandbox OIDC token before returning provider, session, or
  credential-specific information.
- Bind credential issuance and cached leases to the verified sandbox session,
  credential context, actor or delegated subject, operation scope, and expiry.
- Resolve providers from registered plugin domains and verified forwarded
  routing metadata.
- Duplicate HTTP requests are valid retries; request-shape deduplication is not
  a security boundary.
- Tool-native auth environment variables may contain non-secret placeholders
  only. The proxy applies real authorization headers after verification.

The implementation lives in
`packages/junior/src/chat/sandbox/egress/` and
`packages/junior/src/chat/credentials/`.

## Context-Bound Tools

- The harness owns the active actor, destination, conversation, and sandbox
  target for context-bound operations.
- Model-facing schemas must not accept target overrides unless the operation is
  explicitly designed for cross-context access.
- Missing context fails with a structured error. Do not silently choose a
  private destination, alternate actor, or bot-owned artifact.

Follow `context-bound-systems.md`, `provider-boundaries.md`, and
`tool-design.md`.

## Provider Credentials

- Plugin registration authorizes declared provider domains; registration does
  not mint credentials.
- Issue credentials lazily when a verified request reaches a declared domain.
- User-owned access requires the current user actor or an explicitly delegated
  credential subject.
- Installation or service-principal credentials must remain scoped to the
  provider resource and operation family that justified issuance.
- OAuth authorization links are private, short-lived, single-use, and bound to
  the initiating actor and conversation.

## Plugins And Skills

- Load plugins only from explicit app configuration.
- Do not discover executable plugins by scanning dependencies or arbitrary
  filesystem paths.
- Skills describe how to use capabilities; they do not own credential setup,
  package installation, runtime bootstrap, or secret repair.
- Host-executed code plugins are trusted app code and require normal code review.
  Add isolation only at a concrete external, model-visible, credential,
  lifecycle, or migration boundary.

## Telemetry And Incidents

- Apply `data-redaction.md` and `observability.md` to all logs and traces.
- Capture security failures with stable classifications and safe identifiers,
  never secret material or unrestricted private content.
- Rotate exposed credentials, remove leaked material, review logs for secondary
  exposure, and document the preventive change after an incident.
