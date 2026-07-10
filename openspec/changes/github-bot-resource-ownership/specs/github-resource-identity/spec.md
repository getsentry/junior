# GitHub Resource Identity

## ADDED Requirements

### Requirement: Junior-Owned Resources Use Junior Identity

GitHub resources that Junior creates and operates as part of an approved
Junior-owned workflow SHALL use the GitHub App installation identity rather
than a requesting or delegated user's OAuth identity.

#### Scenario: Typed issue creation

- **WHEN** Junior executes the typed GitHub issue creation operation
- **THEN** the issue is created with a GitHub App installation credential
- **AND** GitHub records Junior's App identity as the creator
- **AND** no user OAuth token is requested or injected.

#### Scenario: Typed pull request creation

- **WHEN** Junior executes the typed GitHub pull request creation operation
- **THEN** the pull request is created with a GitHub App installation
  credential
- **AND** GitHub records Junior's App identity as the creator
- **AND** no user OAuth token is requested or injected.

### Requirement: Bot Writes Are Explicitly Allowlisted

Junior SHALL issue installation write credentials only for explicitly
classified GitHub operation families. A generic installation write grant SHALL
NOT exist.

#### Scenario: Approved issue lifecycle operation

- **WHEN** a request unambiguously matches an allowlisted issue create, update,
  comment, label, assignment, close, or reopen operation
- **THEN** Junior may select the scoped issue installation grant
- **AND** the grant authorizes only the approved issue operation family.

#### Scenario: Approved pull request lifecycle operation

- **WHEN** a request unambiguously matches an allowlisted pull request create,
  PR-native metadata update, ready-for-review, requested-reviewer, or close
  operation
- **THEN** Junior may select the scoped pull request installation grant
- **AND** the grant does not authorize reviews, approvals, merge, branch
  deletion, or repository administration.

#### Scenario: Issue-backed pull request lifecycle operation

- **WHEN** a pull request comment, label, or assignee mutation uses GitHub's
  issue endpoint
- **THEN** Junior selects the scoped issue installation grant
- **AND** the operation remains attributed to Junior's installation identity.

#### Scenario: Unknown GitHub write

- **WHEN** a REST write, GraphQL mutation, or Git smart HTTP write cannot be
  proven to match an approved bot-owned operation
- **THEN** Junior denies the request before credential issuance
- **AND** Junior does not fall back to a generic bot token or user OAuth token.

### Requirement: Bot Write Leases Are Resource Scoped

Every GitHub installation write lease SHALL be isolated by operation family and
target repository and SHALL request only the GitHub App permissions required by
that operation.

#### Scenario: Issue token issuance

- **WHEN** Junior issues an installation credential for an approved issue
  operation in `owner/repo`
- **THEN** the token is restricted to `owner/repo`
- **AND** it requests issue write permission plus only provider-required read
  permissions
- **AND** its cache identity cannot collide with a pull request or another
  repository's lease.

#### Scenario: Pull request token issuance

- **WHEN** Junior issues an installation credential for an approved pull
  request operation in `owner/repo`
- **THEN** the token is restricted to `owner/repo`
- **AND** it requests pull request write permission plus only permissions
  required by the approved operation
- **AND** its cache identity cannot collide with an issue or another
  repository's lease.

#### Scenario: Provider rejects scoped credential

- **WHEN** GitHub rejects a scoped installation write credential with `403`
- **THEN** Junior reports a permission denial for the selected scoped grant
- **AND** it does not retry under a human credential.

### Requirement: Human-Identity Operations Remain Explicit

GitHub operations whose provider meaning inherently represents personal human
judgment or user-private access SHALL use an explicitly delegated human
credential and SHALL NOT use Junior's installation write grants.

#### Scenario: Pull request review

- **WHEN** Junior is asked to approve, request changes on, or submit a human
  review for a pull request
- **THEN** the operation requires an explicit human credential subject
- **AND** the resulting review is not attributed to Junior's installation
  identity.

#### Scenario: Human credential unavailable

- **WHEN** a human-identity operation lacks a valid delegated credential
- **THEN** Junior follows the existing private authorization flow or reports
  that authorization is required
- **AND** it does not substitute the installation identity.

### Requirement: High-Impact Operations Are Separately Gated

Bot ownership of issues and pull requests SHALL NOT implicitly authorize merge,
REST ref mutation, workflow administration, repository administration, or
other high-impact API operations.

#### Scenario: Pull request merge

- **WHEN** a request attempts to merge a pull request
- **THEN** the issue and pull request installation grants do not authorize it
- **AND** Junior requires a separately specified policy and grant.

### Requirement: Git Pushes Use A Repository-Scoped Installation Grant

Junior SHALL classify Git smart-HTTP `git-receive-pack` traffic into a distinct
installation grant scoped to the target repository. The grant SHALL NOT
authorize REST contents writes, merge, or unknown GitHub API mutations.

#### Scenario: Git smart-HTTP push

- **WHEN** Junior sends `git-receive-pack` traffic to a GitHub repository
- **THEN** Junior issues an `installation-pr-branch-write` credential scoped to
  that repository
- **AND** a lease for another repository cannot be reused.

#### Scenario: Branch-level policy limitation

- **WHEN** the repository-scoped credential is used for Git smart HTTP
- **THEN** Junior does not claim to independently distinguish branch ownership,
  force updates, or ref deletion
- **AND** operator guidance requires GitHub branch protection, rulesets, and
  constrained App installation scope for those controls.

#### Scenario: Workflow-changing push

- **WHEN** the configured App permission envelope includes `workflows: write`
- **THEN** Junior includes that permission in the repository-scoped branch
  token so workflow-file pushes can succeed
- **AND** otherwise requests only `contents: write` and `metadata: read`.

#### Scenario: Headless subscribed pull request follow-up

- **WHEN** a subscribed pull request event starts a headless resource-event
  turn and Junior needs to commit and push a fix
- **THEN** the turn uses the `resource-event` system actor without a user
  credential subject
- **AND** Git smart-HTTP push receives the repository-scoped
  `installation-pr-branch-write` credential
- **AND** timeout or yield continuation preserves the `resource-event` system
  actor without requiring a Slack user actor
- **AND** human reviews or other user-owned operations still require explicit
  delegated authorization.

### Requirement: Human Attribution Is Explicit Metadata

Junior-owned GitHub resources SHALL credit human contributors through
runtime-owned attribution metadata that does not affect credential selection.

#### Scenario: Junior-managed commit

- **WHEN** Junior creates a commit for a Junior-managed pull request branch
- **THEN** the configured Junior bot identity is the Git author and committer
- **AND** every resolvable human run actor, including the primary actor, appears
  once in a `Co-Authored-By` trailer
- **AND** system actors and incomplete human profiles are not fabricated into
  trailers.

#### Scenario: User-requested issue or pull request

- **WHEN** a verified human actor requests issue or pull request creation
- **THEN** Junior adds runtime-owned `Requested by` attribution to the body
- **AND** the existing conversation footer remains deterministic
- **AND** the attribution does not invent a GitHub handle or become an
  authorization input.

#### Scenario: System-originated resource

- **WHEN** a system actor creates a GitHub resource without explicit creator
  audit metadata at the tool boundary
- **THEN** Junior attributes the system actor only when that actor is present
- **AND** it does not infer a human requester from prior messages or durable
  object ownership.

### Requirement: Service Principal Preference Is Documented

Junior's canonical identity and credential specifications SHALL state that
service-principal identity is preferred for Junior-owned provider operations
and delegated user credentials are explicit exceptions.

#### Scenario: Identity documentation

- **WHEN** maintainers inspect the identity and credential specifications
- **THEN** they can determine when Junior acts as itself
- **AND** they can distinguish execution identity from actor, creator,
  requester, author, and credential-subject attribution.
