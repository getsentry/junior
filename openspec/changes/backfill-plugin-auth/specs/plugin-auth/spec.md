## ADDED Requirements

### Requirement: Credential lease secrecy and shape

Plugin auth brokers SHALL issue host-managed credential leases without exposing real provider secrets through sandbox command env.

#### Scenario: Broker issues a lease

- **WHEN** a plugin auth broker successfully issues credentials
- **THEN** the lease SHALL include provider id, unique lease id, expiry, reason metadata, optional domain header transforms, and command env values

#### Scenario: Token-backed broker sets command env

- **WHEN** a token-backed broker issues a lease
- **THEN** the sandbox command env SHALL contain a non-secret auth-token placeholder, not the real token

#### Scenario: Command env is declared

- **WHEN** a manifest declares plugin command env
- **THEN** the broker SHALL include resolved command env values in the lease subject to the plugin manifest secret boundary

#### Scenario: Lease expiry exceeds broker maximum

- **WHEN** provider credentials are valid for longer than the broker maximum
- **THEN** the lease expiry SHALL be capped at the broker maximum

### Requirement: API header broker

Junior SHALL issue deployment-env-backed API header transforms for plugins that declare top-level API headers.

#### Scenario: API header env var is present

- **WHEN** an API header value references a host env var and the env var is set
- **THEN** the broker SHALL resolve the env value into header transforms for each manifest domain

#### Scenario: API header env var is missing

- **WHEN** an API header value references a missing or empty env var
- **THEN** broker issuance SHALL fail

#### Scenario: Static API header value is declared

- **WHEN** an API header value contains no env placeholder
- **THEN** the broker SHALL pass the static value through as a header value

#### Scenario: API header broker has no transforms

- **WHEN** API header broker issuance finds no manifest domains and headers
- **THEN** issuance SHALL fail

### Requirement: OAuth bearer broker

Junior SHALL issue bearer-token header transforms from requester-scoped OAuth tokens or allowed static tokens.

#### Scenario: Requester token exists and is valid

- **WHEN** a requester id is present and the user token store has an unexpired token satisfying provider scope
- **THEN** the broker SHALL issue Bearer authorization headers for each credential domain using that token

#### Scenario: Requester token is missing

- **WHEN** a requester id is present, provider OAuth is configured, and no requester token exists
- **THEN** the broker SHALL fail with `CredentialUnavailableError`

#### Scenario: Stored token is expired

- **WHEN** a stored requester token is expired and cannot be refreshed
- **THEN** the broker SHALL fail with `CredentialUnavailableError`

#### Scenario: Stored token lacks required scope

- **WHEN** the stored token scope does not include every manifest-required scope
- **THEN** the broker SHALL fail with `CredentialUnavailableError`

#### Scenario: Provider has no OAuth config and static token exists

- **WHEN** the provider has token-backed credentials without OAuth config and the configured auth-token env var is set
- **THEN** the broker MAY issue a lease using the static env token

#### Scenario: Non-requester-bound issuance has static token

- **WHEN** no requester id is provided and the configured auth-token env var is set
- **THEN** the broker MAY issue a lease using the static env token

#### Scenario: No token source is available

- **WHEN** no requester token or allowed static env token is available
- **THEN** the broker SHALL fail with `CredentialUnavailableError`

### Requirement: OAuth token refresh

Junior SHALL refresh near-expiry OAuth bearer tokens before issuing leases when possible.

#### Scenario: Stored token is near expiry

- **WHEN** a stored token expires within the refresh buffer
- **THEN** the broker SHALL call the OAuth token endpoint with a refresh-token grant

#### Scenario: Refresh succeeds

- **WHEN** refresh returns a valid access token, refresh token, optional expiry, and sufficient scope
- **THEN** Junior SHALL persist the refreshed tokens and issue the lease from the new access token

#### Scenario: Refresh response lacks scope

- **WHEN** refresh succeeds but omits scope
- **THEN** Junior SHALL treat the previous stored scope or configured provider scope as the fallback grant scope

#### Scenario: Refresh fails but old token remains valid

- **WHEN** refresh fails and the previous access token has not expired
- **THEN** the broker MAY issue a lease from the old access token

#### Scenario: Refresh fails and old token is expired

- **WHEN** refresh fails and the previous access token is expired
- **THEN** the broker SHALL fail with `CredentialUnavailableError`

### Requirement: OAuth token request and response handling

Junior SHALL construct token requests and parse token responses according to the provider OAuth config.

#### Scenario: Body auth method is used

- **WHEN** token auth method is absent or `body`
- **THEN** Junior SHALL send `client_id` and `client_secret` in the token request payload

#### Scenario: Basic auth method is used

- **WHEN** token auth method is `basic`
- **THEN** Junior SHALL send client credentials in the HTTP Basic Authorization header and omit them from the payload

#### Scenario: Token content type is JSON

- **WHEN** token extra headers set a JSON content type
- **THEN** Junior SHALL serialize the token payload as JSON

#### Scenario: Token content type is unsupported

- **WHEN** token extra headers set an unsupported content type
- **THEN** token request construction SHALL fail

#### Scenario: Token response is incomplete

- **WHEN** a token response lacks non-empty `access_token` or `refresh_token`
- **THEN** token parsing SHALL fail

#### Scenario: Token response expiry is invalid

- **WHEN** `expires_in` is present but not a positive finite number
- **THEN** token parsing SHALL fail

### Requirement: OAuth scope comparison

Junior SHALL normalize and compare OAuth scopes as unordered whitespace-delimited sets.

#### Scenario: Stored scope contains required scopes

- **WHEN** every required scope is present in stored scope
- **THEN** the grant SHALL satisfy the provider scope contract

#### Scenario: Required scope is empty

- **WHEN** the provider declares no required OAuth scope
- **THEN** any stored scope SHALL satisfy the provider scope contract

#### Scenario: Stored scope is empty but required scope exists

- **WHEN** stored scope is empty and provider scope is required
- **THEN** the grant SHALL NOT satisfy the provider scope contract

### Requirement: GitHub App broker

Junior SHALL issue GitHub App installation-token leases from host app credentials.

#### Scenario: GitHub App env is present

- **WHEN** app id, RSA private key, and installation id env vars are present and valid
- **THEN** the broker SHALL sign a GitHub App JWT and request an installation access token

#### Scenario: Private key is encoded

- **WHEN** the private key env value is raw PEM, quoted PEM, escaped-newline PEM, or base64-encoded PEM
- **THEN** Junior SHALL normalize it before signing

#### Scenario: Private key is missing or invalid

- **WHEN** the private key env value is missing, not PEM, or not RSA
- **THEN** issuance SHALL fail

#### Scenario: Installation id is invalid

- **WHEN** the installation id env var is missing or not numeric
- **THEN** issuance SHALL fail

#### Scenario: API domain is missing

- **WHEN** GitHub App credential domains do not include an API domain
- **THEN** broker creation or issuance SHALL fail

#### Scenario: Installation token is issued

- **WHEN** GitHub returns an installation access token and expiry
- **THEN** the broker SHALL issue header transforms for each configured domain and cap lease expiry at the broker maximum

#### Scenario: Git smart HTTP domain is configured

- **WHEN** the configured domain is the GitHub web/git domain for the API domain
- **THEN** the broker SHALL use Basic auth with `x-access-token:<token>`

#### Scenario: Non-git GitHub service domain is configured

- **WHEN** the configured domain is a GitHub service domain other than the git smart-HTTP domain
- **THEN** the broker SHALL use Bearer auth

### Requirement: GitHub App permission derivation

Junior SHALL derive optional GitHub installation-token permissions from manifest capabilities.

#### Scenario: No capabilities are declared

- **WHEN** a GitHub App manifest has no capabilities
- **THEN** the installation-token request SHALL omit explicit permissions

#### Scenario: Read and write capability share a scope

- **WHEN** capabilities include both read and write for the same known GitHub permission scope
- **THEN** the token request SHALL request write permission for that scope

#### Scenario: Capability has unsupported shape

- **WHEN** a GitHub App capability does not match the provider-qualified `<scope>.<read|write>` shape or names an unknown scope
- **THEN** broker issuance SHALL fail

### Requirement: Plugin auth failure semantics

Junior SHALL distinguish unavailable credentials from malformed host configuration.

#### Scenario: User authorization is needed

- **WHEN** credentials are absent, expired, or insufficient for a requester-bound OAuth provider
- **THEN** the broker SHALL throw `CredentialUnavailableError` with the provider name so auth orchestration can start or reuse authorization

#### Scenario: Host configuration is malformed

- **WHEN** required deployment env vars, private keys, token endpoint responses, or provider API responses are malformed
- **THEN** the broker SHALL throw an ordinary error and SHALL NOT fabricate a credential lease

### Requirement: Plugin auth verification taxonomy

Junior SHALL verify plugin auth behavior at broker and consuming-boundary layers.

#### Scenario: Broker issuance logic changes

- **WHEN** lease shape, header transforms, env placeholders, refresh, scope checks, or GitHub token issuance changes
- **THEN** unit tests SHALL cover the broker behavior

#### Scenario: Broker is consumed by sandbox egress or provider runtime

- **WHEN** credential leases are applied to outbound provider requests
- **THEN** integration tests SHALL cover the egress/injection boundary

#### Scenario: User-visible authorization behavior changes

- **WHEN** broker failures cause auth prompts, reauthorization, or resumed provider workflows
- **THEN** evals or Slack integration tests SHALL cover the user-visible behavior through OAuth and turn-resume specs
