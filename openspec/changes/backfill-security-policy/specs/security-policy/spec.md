## ADDED Requirements

### Requirement: Global Security Ownership

The security-policy capability SHALL define cross-cutting security invariants for Junior runtime behavior while narrower capability specs own detailed protocol mechanics.

#### Scenario: A provider-specific auth rule conflicts with this policy

- **WHEN** a provider-specific spec or implementation would expose long-lived secrets, bypass requester binding, make authorization URLs public, or log sensitive values
- **THEN** the security-policy invariant SHALL take precedence until an explicit security-reviewed OpenSpec change narrows or changes the invariant

#### Scenario: A narrower spec owns implementation details

- **WHEN** OAuth callback mechanics, provider token refresh, sandbox command behavior, Slack message delivery, or telemetry schema details are needed
- **THEN** the implementation SHALL follow the narrower capability spec without weakening the global security invariants

### Requirement: Secret Custody

Junior SHALL keep long-lived provider secrets, OAuth client secrets, private keys, refresh tokens, and real provider access tokens under host-managed custody.

#### Scenario: Sandbox command environment is built

- **WHEN** the runtime prepares environment variables for a sandbox command
- **THEN** auth env vars exposed to the sandbox SHALL contain only non-secret placeholders or approved non-secret command values
- **AND** real provider credentials SHALL NOT be written to sandbox env vars, files, command arguments, skill directories, or repository files

#### Scenario: Provider credential is required by a sandboxed tool

- **WHEN** a sandboxed tool needs provider authentication
- **THEN** the host SHALL authenticate matching outbound provider requests through credential header transforms instead of exposing the secret value to the sandbox process

### Requirement: Sandboxed Execution Boundary

User-influenced command execution SHALL run in isolated sandbox/container environments whose filesystem state is treated as ephemeral and untrusted.

#### Scenario: User request triggers command execution

- **WHEN** the agent needs to execute user-influenced shell, package-manager, CLI, or skill code
- **THEN** the runtime SHALL execute that code through the sandbox boundary rather than directly in the host runtime

#### Scenario: Sandbox output returns to the host

- **WHEN** files, stdout, stderr, or generated artifacts return from the sandbox
- **THEN** the host SHALL treat them as untrusted outputs and apply the relevant attachment, delivery, and credential redaction rules before exposing them outside the runtime

### Requirement: Explicit Sandbox Network Policy

Production sandbox network access SHALL use explicit allowlists and route credential-capable provider domains through Junior's host-controlled sandbox egress proxy.

#### Scenario: Provider domains are registered

- **WHEN** a registered plugin declares credential-capable provider domains
- **THEN** the sandbox network policy SHALL forward matching HTTPS requests for those domains to the Junior egress proxy
- **AND** the policy SHALL NOT mint provider credentials merely because the plugin is loaded or the domain is registered

#### Scenario: Outbound host is not owned by a registered provider

- **WHEN** a forwarded sandbox egress request targets a host not declared by any registered credential provider
- **THEN** the egress proxy SHALL reject the request before issuing credentials or forwarding upstream

### Requirement: Authenticated Sandbox Egress

The sandbox egress proxy SHALL authenticate forwarded sandbox requests before trusting routing headers, resolving providers, or issuing credentials.

#### Scenario: Forwarded request lacks valid sandbox identity

- **WHEN** a forwarded egress request lacks a Vercel Sandbox OIDC token, has an invalid OIDC token, or has a verified token without a sandbox id
- **THEN** the egress proxy SHALL reject the request before provider resolution and credential issuance

#### Scenario: Forwarded routing headers are unsafe

- **WHEN** forwarded host, scheme, port, or path headers are missing or unsafe
- **THEN** the egress proxy SHALL reject the request before provider credential issuance
- **AND** only HTTPS forwarded schemes SHALL be accepted for credential-capable upstream requests

### Requirement: Requester-Bound Credential Issuance

Junior SHALL issue user-owned provider credentials only in a requester-bound context and SHALL scope cached credential leases to one provider, requester, sandbox session, context token, and expiry window.

#### Scenario: Requester context is missing or mismatched

- **WHEN** a sandbox egress request reaches a provider domain without a valid signed requester context or with a context whose sandbox id does not match the verified OIDC sandbox id
- **THEN** the egress proxy SHALL reject the request without issuing a credential lease

#### Scenario: Repeated sandbox request uses the same requester context

- **WHEN** duplicate or repeated method/URL/body request shapes arrive within the same valid requester and sandbox context
- **THEN** the egress proxy MAY reuse the cached provider lease until expiry
- **AND** it SHALL NOT reject the request as a replay solely because the request shape repeats

#### Scenario: Upstream rejects injected credentials

- **WHEN** the upstream provider responds with an authentication rejection
- **THEN** Junior SHALL clear the cached lease for that provider/requester/sandbox context so a later request can obtain fresh credentials or trigger authorization recovery

### Requirement: Provider Declaration Boundaries

Provider credential issuance SHALL be controlled by explicit plugin/provider declarations and host-side brokers.

#### Scenario: Plugin declares credential domains

- **WHEN** a plugin declares provider credential domains
- **THEN** those declarations SHALL authorize lazy egress injection only for matching forwarded hosts
- **AND** header transforms SHALL apply only to the domains covered by the issued credential lease

#### Scenario: Runtime path lacks requester context for user-owned access

- **WHEN** user-owned OAuth or account credentials are required but no requester id is available
- **THEN** the runtime SHALL fail with an authorization-required or credential-unavailable result instead of issuing reusable user credentials

### Requirement: OAuth Authorization Link Privacy

Authorization URLs SHALL be visible only to the requesting user and SHALL NOT be exposed to the agent model or to public Slack conversations.

#### Scenario: Authorization is needed in a Slack channel or group

- **WHEN** the runtime needs a user to authorize a provider from a non-private request surface
- **THEN** it SHALL send the authorization URL through a private delivery path such as Slack ephemeral delivery or DM fallback
- **AND** any visible thread acknowledgement SHALL omit the URL

#### Scenario: Private authorization delivery fails

- **WHEN** the runtime cannot deliver the authorization URL privately
- **THEN** it SHALL fail with user guidance to retry from a direct message or another private path
- **AND** it SHALL NOT post the raw authorization URL visibly in the original channel or group

#### Scenario: Authorization completes

- **WHEN** OAuth or MCP authorization completes
- **THEN** the runtime SHALL record completion as a chronological host/runtime event and project only a minimal host-authored observation into the agent context
- **AND** it SHALL NOT inject raw URLs, codes, tokens, or hidden prompt flags into resumed agent prompts

### Requirement: Provider Authentication Baselines

First-party provider authentication SHALL use short-lived host-issued credentials and provider-appropriate least-privilege mechanisms.

#### Scenario: GitHub App credentials are issued

- **WHEN** Junior authenticates GitHub provider traffic
- **THEN** the host SHALL keep the GitHub App id/private key under host custody, sign the App JWT on host, exchange it for a short-lived installation token, and inject REST/git HTTPS auth through host-side header transforms

#### Scenario: OAuth bearer credentials are issued

- **WHEN** Junior authenticates OAuth-backed provider traffic for a requester
- **THEN** the host SHALL load, validate, refresh, and store requester-bound tokens server-side and inject only short-lived access through host-side header transforms

### Requirement: Context-Bound Tool Target Safety

For context-bound tools, destination and target resolution SHALL be owned by the runtime harness rather than model-supplied override arguments.

#### Scenario: Context-bound target is missing

- **WHEN** a context-bound tool requires a Slack channel, thread, canvas, list, file, provider target, or other runtime target that is unavailable
- **THEN** the tool SHALL fail safely with a structured error
- **AND** it SHALL NOT silently choose an alternate private scope or bot-owned destination

#### Scenario: Tool schema is exposed to the model

- **WHEN** a context-bound tool schema is made available to the model
- **THEN** the schema SHALL NOT expose destination override fields unless a capability spec explicitly approves that override

### Requirement: Security Logging Redaction

Logs, spans, status messages, prompts, and model-visible observations SHALL exclude secret values and raw credential-bearing headers.

#### Scenario: Privileged operation is logged

- **WHEN** Junior logs sandbox egress, credential issuance, OAuth, plugin auth, or provider dispatch activity
- **THEN** log attributes SHALL use safe metadata such as provider, host, path, target, outcome, status, and expiry
- **AND** they SHALL NOT include token values, refresh tokens, OAuth codes, private keys, raw Authorization headers, or raw authorization URLs

#### Scenario: A path contains a signed requester token

- **WHEN** a proxy route or callback path containing secret or bearer-like state is logged
- **THEN** the logged path SHALL redact or omit the sensitive token component

### Requirement: Privileged Change Verification

Changes that affect credential issuance, sandbox egress, OAuth delivery, provider auth, or security-sensitive logging SHALL include verification for success, failure, expiry or refresh, and redaction behavior.

#### Scenario: New privileged path is added

- **WHEN** a change adds a new provider credential type, sandbox egress path, auth callback, token store, or secret-bearing log event
- **THEN** the change SHALL identify unit, integration, eval, or manual verification for successful use, failed issuance, lease/token expiry or refresh, and absence of secret leakage

#### Scenario: Security behavior cannot be fully verified locally

- **WHEN** a security invariant depends on external platform behavior that cannot be deterministically verified in local tests
- **THEN** the verification map SHALL record the unverified portion and the required manual or deployed check before the behavior is considered fully accepted

### Requirement: Incident Response

Junior SHALL maintain an incident response path for suspected credential leakage or authorization exposure.

#### Scenario: Credential leakage is suspected

- **WHEN** long-lived secrets, provider tokens, authorization URLs, OAuth codes, or raw authorization headers may have leaked
- **THEN** maintainers SHALL rotate affected long-lived secrets, revoke active short-lived tokens where possible, audit logs/traces for the impact window, patch the leak path, and re-verify the affected security invariant
