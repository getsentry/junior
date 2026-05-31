## ADDED Requirements

### Requirement: Credential broker lease contract

Junior SHALL represent provider credentials as short-lived host-managed leases.

#### Scenario: Lease is issued

- **WHEN** a credential broker issues credentials
- **THEN** the lease SHALL include an id, provider, expiry, non-secret command env values, optional header transforms, and optional non-secret metadata

#### Scenario: Credentials are unavailable

- **WHEN** a provider broker cannot issue usable credentials
- **THEN** it SHALL throw `CredentialUnavailableError` with the provider identity and a display-safe message

#### Scenario: Lease expiry exceeds provider or global cap

- **WHEN** a provider returns an expiry later than Junior's maximum lease duration
- **THEN** Junior SHALL cap the lease expiry to the maximum lease duration

#### Scenario: Header transforms overlap

- **WHEN** multiple header transforms target the same domain and header name
- **THEN** later transforms SHALL override earlier header values for that domain

### Requirement: Non-secret sandbox command environment

Junior SHALL expose only non-secret provider compatibility values inside sandbox command environments.

#### Scenario: Provider declares command env

- **WHEN** a plugin manifest declares non-secret command env values
- **THEN** Junior SHALL include those values in sandbox command environment setup

#### Scenario: Provider declares token-backed credentials

- **WHEN** a plugin declares an auth token env name
- **THEN** Junior SHALL set that env name to a provider placeholder value, not to a real token

#### Scenario: Host env binding is non-secret and allowed

- **WHEN** a command env value references an allowed non-secret host env binding
- **THEN** Junior MAY resolve that binding into the sandbox command environment

#### Scenario: Credential env vars are secret-bearing

- **WHEN** a manifest value would expose OAuth, API header, token, or private key env vars through command env
- **THEN** manifest validation SHALL reject that configuration before runtime

### Requirement: Sandbox egress forwarding policy

Junior SHALL configure sandbox network policy to forward registered credential provider domains to Junior's internal egress proxy.

#### Scenario: No registered provider domains exist

- **WHEN** no plugin provider declares credential or API header domains
- **THEN** Junior SHALL build a deny-by-default policy with no provider forward rules

#### Scenario: Provider domains exist

- **WHEN** plugin providers declare credential or API header domains
- **THEN** Junior SHALL add one forwarding rule per declared domain using the sandbox egress proxy URL

#### Scenario: Requester token is available

- **WHEN** a sandbox is created for a requester-bound turn
- **THEN** Junior SHALL include a signed requester context token in the provider forwarding URL

#### Scenario: Public base URL is unavailable

- **WHEN** Junior cannot resolve a public base URL for the forwarding endpoint
- **THEN** sandbox egress policy construction SHALL fail

### Requirement: Signed requester egress context

Junior SHALL bind lazy sandbox credential issuance to a signed requester/sandbox context.

#### Scenario: Requester context token is created

- **WHEN** Junior creates a requester context token
- **THEN** it SHALL include requester id, egress id, expiry, and a unique context id
- **AND** it SHALL sign the payload with Junior's sandbox egress secret

#### Scenario: Sandbox egress secret is missing

- **WHEN** Junior cannot resolve the sandbox egress secret
- **THEN** token creation or verification SHALL fail closed

#### Scenario: Requester context token is expired, malformed, or tampered

- **WHEN** the egress proxy parses an invalid requester token
- **THEN** it SHALL reject credential issuance

#### Scenario: Requester context belongs to another sandbox

- **WHEN** the requester context egress id does not match the verified Vercel sandbox id
- **THEN** the egress proxy SHALL reject credential issuance

### Requirement: Vercel Sandbox egress request verification

Junior SHALL verify forwarded sandbox requests before reconstructing or proxying upstream traffic.

#### Scenario: OIDC token is missing

- **WHEN** a forwarded request lacks the Vercel Sandbox OIDC token header
- **THEN** Junior SHALL reject the request before reading forwarded routing headers

#### Scenario: OIDC token is invalid

- **WHEN** Vercel Sandbox OIDC verification fails
- **THEN** Junior SHALL reject the request

#### Scenario: OIDC token lacks sandbox id

- **WHEN** the verified OIDC payload lacks a sandbox id
- **THEN** Junior SHALL reject the request

#### Scenario: Forwarded host, scheme, port, or path is invalid

- **WHEN** forwarded routing headers are missing or invalid
- **THEN** Junior SHALL reject the request before credential issuance

#### Scenario: Forwarded scheme is not HTTPS

- **WHEN** the forwarded scheme is not HTTPS
- **THEN** Junior SHALL reject the request before credential issuance

### Requirement: Provider-domain resolution

Junior SHALL resolve credential provider ownership from the forwarded upstream host.

#### Scenario: Forwarded host matches a registered provider domain

- **WHEN** the forwarded host exactly matches a registered provider domain
- **THEN** Junior SHALL resolve that provider for credential issuance

#### Scenario: Forwarded host is not registered

- **WHEN** no provider owns the forwarded host
- **THEN** Junior SHALL reject the request without issuing credentials

#### Scenario: Credential lease does not cover forwarded host

- **WHEN** the issued or cached lease lacks a header transform for the forwarded host
- **THEN** Junior SHALL reject the request before forwarding upstream

### Requirement: Lazy sandbox credential issuance and caching

Junior SHALL issue and cache sandbox egress leases only after request verification and provider resolution.

#### Scenario: Valid forwarded request has no cached lease

- **WHEN** a verified requester/sandbox context contacts a registered provider domain with no cached lease
- **THEN** Junior SHALL issue a provider credential lease with reason `sandbox-egress:<provider>` and the requester id

#### Scenario: Cached lease exists

- **WHEN** a valid cached lease exists for the same provider, requester id, egress id, and context id
- **THEN** Junior SHALL reuse the cached header transforms until lease or requester context expiry

#### Scenario: Different requester contacts same provider

- **WHEN** a different requester context contacts the same provider domain
- **THEN** Junior SHALL NOT reuse another requester's cached lease

#### Scenario: Same requester renews egress context

- **WHEN** a new requester context id is created for the same requester and sandbox
- **THEN** Junior SHALL NOT reuse leases cached under the prior context id

#### Scenario: Lease has no header transforms

- **WHEN** a broker lease lacks header transforms for sandbox egress
- **THEN** Junior SHALL fail rather than forwarding without credentials

### Requirement: Sandbox egress proxy forwarding

Junior SHALL apply credential headers host-side and forward only sanitized requests and responses.

#### Scenario: Request is forwarded upstream

- **WHEN** a verified forwarded request has a valid provider lease
- **THEN** Junior SHALL reconstruct the upstream URL from Vercel forwarded host, scheme, port, and path headers
- **AND** Junior SHALL NOT use the proxy route URL as the upstream path

#### Scenario: Sandbox request headers are forwarded

- **WHEN** forwarding sandbox headers upstream
- **THEN** Junior SHALL strip hop-by-hop and proxy-only headers
- **AND** Junior SHALL apply matching provider credential header transforms on the host

#### Scenario: Request has no body

- **WHEN** the forwarded method/body combination is bodyless
- **THEN** Junior SHALL NOT synthesize an empty upstream body

#### Scenario: Upstream response is returned

- **WHEN** the provider returns a response
- **THEN** Junior SHALL return upstream status, status text, response body, and allowed response headers to the sandbox

#### Scenario: Host fetch decodes response body

- **WHEN** returning an upstream response body through host fetch
- **THEN** Junior SHALL remove decoded content encoding and content length headers

#### Scenario: Upstream rejects auth

- **WHEN** upstream returns 401 or 403
- **THEN** Junior SHALL clear the cached credential lease for that provider/requester context

### Requirement: Auth-required proxy response

Junior SHALL make missing requester credentials readable by the sandbox command failure path without exposing authorization URLs or secrets.

#### Scenario: Broker reports unavailable credentials

- **WHEN** a sandbox egress broker throws `CredentialUnavailableError`
- **THEN** the egress proxy SHALL return HTTP 401 text containing `junior-auth-required provider=<provider>`

#### Scenario: Auth-required response is returned

- **WHEN** the proxy returns an auth-required marker
- **THEN** the response SHALL NOT include provider tokens, OAuth authorization URLs, OAuth codes, or refresh tokens

### Requirement: OAuth bearer credential profile

Junior SHALL issue OAuth bearer leases from requester-bound stored tokens when OAuth is configured.

#### Scenario: Stored requester token is valid

- **WHEN** a requester has a stored token for the provider and required scope
- **THEN** Junior SHALL issue bearer authorization header transforms for each credential domain

#### Scenario: Stored requester token is near expiry

- **WHEN** a stored requester token is near expiry and has a refresh token
- **THEN** Junior SHALL refresh it server-side, store refreshed tokens, and issue a lease from the refreshed access token

#### Scenario: Stored scope is insufficient

- **WHEN** stored OAuth scope does not satisfy the provider's required scope
- **THEN** Junior SHALL report credentials unavailable so reauthorization can occur

#### Scenario: No requester token exists

- **WHEN** OAuth is configured and requester-bound tokens are missing
- **THEN** Junior SHALL report credentials unavailable unless a permitted static fallback path applies

### Requirement: GitHub App credential profile

Junior SHALL issue GitHub App installation leases from host-side app credentials.

#### Scenario: GitHub App lease is issued

- **WHEN** GitHub App env configuration is valid
- **THEN** Junior SHALL sign an app JWT, request an installation access token, and issue a lease capped by provider expiry and Junior's max lease duration

#### Scenario: Manifest declares GitHub capabilities

- **WHEN** a GitHub plugin manifest declares capability permissions
- **THEN** Junior SHALL translate them into GitHub installation token permissions for the access-token request

#### Scenario: GitHub REST API domain is configured

- **WHEN** GitHub credentials declare domains
- **THEN** Junior SHALL resolve the REST API domain independent of manifest order

#### Scenario: Git smart HTTP domain is configured

- **WHEN** a GitHub credential domain represents git smart HTTP
- **THEN** Junior SHALL use Basic auth with `x-access-token` for that domain

#### Scenario: Non-git GitHub service domain is configured

- **WHEN** a GitHub credential domain is not the git smart HTTP host
- **THEN** Junior SHALL use bearer authorization for that domain

### Requirement: Credential-injection verification taxonomy

Credential-injection verification SHALL separate deterministic broker/proxy behavior, integration wiring, and model-facing auth continuation.

#### Scenario: Local broker and proxy logic are verified

- **WHEN** verifying lease shape, token refresh, scope checks, GitHub token exchange, placeholders, requester token parsing, egress header validation, cache scoping, and upstream forwarding
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Plugin-to-proxy wiring is verified

- **WHEN** verifying real plugin manifest loading, broker selection, network policy, and proxy injection together
- **THEN** the primary coverage SHALL be integration tests

#### Scenario: User-facing auth continuation is verified

- **WHEN** verifying that missing credentials start private auth, resume the blocked turn, and continue provider commands
- **THEN** the primary coverage SHALL be evals or Slack/runtime integration tests owned with `oauth-flows` and `agent-session-resumability`
