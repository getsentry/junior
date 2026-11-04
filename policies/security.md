# Security

## Intent

Keep credentials out of the sandbox and the model, and bind every credential
to verified context. This applies to host runtime code, sandbox execution,
provider credentials, plugins, skills, and telemetry. Egress and credential
code: `packages/junior/src/chat/sandbox/egress/`,
`packages/junior/src/chat/credentials/`.

## Policy

### Defaults

- Run user-influenced commands in an isolated sandbox. Treat its files and
  processes as short-lived and untrusted.
- Keep long-lived secrets in host-managed storage. Prefer short-lived,
  least-privilege credentials.
- Never put real credentials in repo files, skills, prompts, tool arguments,
  sandbox env vars or files, command arguments, logs, or traces.

### Sandbox egress

- Credential-capable provider traffic goes through the host egress proxy.
- Verify the Vercel Sandbox OIDC token before returning provider, session, or
  credential data.
- Bind credentials and cached leases to the verified sandbox session,
  credential context, actor or delegated subject, operation scope, and expiry.
- Resolve providers from registered plugin domains and verified forwarded
  routing metadata.
- Duplicate HTTP requests are valid retries. Request deduplication is not a
  security edge.
- Tool-native auth env vars hold placeholders only. The proxy adds real
  headers after verification.

### Context-bound tools

- The harness owns the active actor, destination, conversation, and sandbox
  target. Model schemas do not accept target overrides.
- Follow `context-bound-systems.md` and `tool-design.md`. Missing context
  fails with a structured error. Never fall back to a private destination,
  another actor, or a bot-owned artifact.

### Provider credentials

- Plugin registration authorizes declared domains. It does not mint
  credentials.
- Issue credentials lazily when a verified request reaches a declared domain.
- User-owned access needs the current actor or an explicitly delegated
  subject.
- Installation and service-principal credentials stay scoped to the resource
  and operation family that justified them.
- OAuth links are private, short-lived, single-use, and bound to the actor and
  conversation.

### Plugins and skills

- Load plugins only from explicit app config, never by scanning dependencies
  or paths.
- Skills describe how to use capabilities. They do not own credential setup,
  package installs, bootstrap, or secret repair.
- Host-executed plugins are trusted app code under normal review. Add
  isolation only at a concrete external, model-visible, credential, lifecycle,
  or migration edge.

### Telemetry and incidents

- Follow `data-redaction.md` and `observability.md`. Capture security
  failures with stable classifications and safe ids.
- After an incident: rotate exposed credentials, remove leaked material, check
  logs for more exposure, and document the preventive change.

## Exceptions

- Model-facing schemas may accept a target override only when the operation
  is designed for cross-context access.
