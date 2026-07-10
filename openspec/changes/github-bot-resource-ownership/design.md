# Design: GitHub Bot Resource Ownership

## Current State

The GitHub plugin has three credential grants:

- `installation-read` mints a GitHub App installation token explicitly scoped
  down to read-capable permissions.
- `user-read` uses the current or delegated user's GitHub App OAuth token for
  user-identity reads such as `GET /user`.
- `user-write` uses the current or delegated user's OAuth token for every
  classified write, including issue and pull request creation, comments,
  metadata changes, GraphQL mutations, and Git pushes.

Credential leases are cached by provider, signed egress context, and grant
name. The cache does not distinguish repositories or individual write
operations. The credential issuance hook receives the selected grant but not
the outbound request, so it cannot currently mint a repository-scoped token
from the request target.

Typed `github_createIssue` and `github_createPullRequest` tools already issue
host-owned requests with trusted operation names, deterministic idempotency,
and runtime-owned conversation footers. Raw issue and pull request creation is
denied.

Git commits currently use the run actor as author, Junior as committer, and
Junior as a co-author. Additional run actors are credited as co-authors.

## Invariants

1. Junior-owned GitHub resources execute under Junior's installation identity.
2. Human attribution never selects or expands a bot credential.
3. No generic installation write lease exists.
4. Every bot write is classified into an explicit operation family before
   credential issuance.
5. Bot write leases are isolated by operation family and target repository.
6. Unknown, ambiguous, or unsupported writes fail closed; they do not silently
   borrow a user token.
7. Human-judgment operations remain human-authenticated.
8. High-impact repository operations require separate policy.

## Grant Model

Retain `installation-read` and `user-read`. Replace ordinary GitHub resource
writes with the following installation grant families:

- `installation-issues-write`
- `installation-pull-requests-write`
- `installation-pr-branch-write`

Keep `user-write` only for explicitly enumerated operations whose provider
meaning requires a human identity. It is not the fallback for an unknown write.

Each plugin-selected grant gains an optional opaque lease scope. For GitHub bot
writes, the plugin sets the scope to the canonical repository identity plus any
narrower operation discriminator required to prevent unsafe reuse. The host
includes that scope in the lease cache key while continuing to use the stable
grant name for logs and auth/permission signals.

The GitHub plugin derives and validates the provider-specific repository target
while classifying the request, stores the canonical target in the grant's
plugin-owned lease scope, and uses that trusted scope during credential
issuance. This keeps provider request parsing inside the GitHub plugin and
avoids widening the generic credential hook with provider request details.

## Operation Classification

### Issues

The issue grant covers only explicitly supported issue-resource routes:

- Typed issue creation
- Issue title/body/state updates
- Issue comments
- Labels and assignees
- Close and reopen through the issue state contract

The classifier must distinguish issue resources from pull requests where
GitHub shares the issues API. Unsupported issue mutations remain denied until
they are added to the allowlist with tests.

### Pull Requests

The pull request grant covers only explicitly supported pull-request resource
routes:

- Typed pull request creation
- Pull request title/body/base/draft metadata updates
- Ready-for-review and requested-reviewer changes
- Pull request close

Pull request comments, labels, and assignees use GitHub's issue endpoints and
therefore select the issue installation grant while retaining Junior's
installation identity.

Reviews, approvals, change requests, merge, branch deletion, and administrative
operations are separate operation families and do not use this grant.

### Raw REST And GraphQL

Trusted typed host/plugin operations may select a bot grant directly after the
plugin verifies their method and endpoint. Raw sandbox traffic may receive a
bot grant only when the method, endpoint, and target repository unambiguously
match an approved allowlist entry.

Unknown REST writes, unknown GraphQL mutations, oversized GraphQL bodies, and
generic non-read fallbacks are denied before credential issuance. They do not
receive `installation-*-write` or `user-write` automatically.

## Pull Request Branch Writes

`git-receive-pack` proves that a Git push is occurring and identifies the
target repository. That is sufficient for the intended operation boundary:
Git pushes select `installation-pr-branch-write`, while REST contents writes,
merges, and unknown API writes remain denied.

The installation token is repository-scoped and requests `contents: write`.
When the configured GitHub App permission envelope includes `workflows: write`,
the token includes it so workflow-file pushes can succeed.

This grant is actor-independent service-principal authority. A headless
resource-event turn runs as the `resource-event` system actor with no user
credential subject, but it can still receive the repository-scoped
installation token. That lets a conversation subscribed to a Junior-owned pull
request react to CI or review events, create a follow-up commit as Junior, and
push the fix. Human-identity operations such as reviews remain on `user-write`
and still require explicit delegated authorization.

This classifier intentionally does not add a separate branch-ownership or
force-update or ref-deletion engine. A repository-scoped token can be used by Git smart HTTP
for any ref GitHub permits within that repository. Deployments rely on GitHub
branch protection, rulesets, and App installation scope for those controls.

## Attribution

Junior-managed commits use the configured Junior bot identity as both Git
author and committer. Every resolvable human in the run's attribution set,
including the primary run actor, is appended once as `Co-Authored-By`. System
actors and human actors without a valid name and email are omitted rather than
guessed.

Typed issue and pull request bodies receive a runtime-owned `Requested by`
attribution adjacent to the existing Junior conversation footer. Attribution
uses verified runtime actor display data and the conversation link when
available. It must not invent a GitHub handle or use attribution as an
authorization input.

For system-originated runs, the body names the system actor only when the
runtime exposes that actor to the tool boundary. Creator metadata may be shown
only when it is explicitly carried as audit metadata; it must not be inferred
from conversation history.

## Failure Behavior

- Missing installation configuration or unsupported App permissions produce a
  credential-unavailable or permission-denied result, never an OAuth prompt.
- Unsupported bot writes fail with an actionable policy-denied message.
- A provider `403` reports the selected scoped grant and GitHub permission
  headers without retrying under a user's identity.
- Human-only operations may request delegated OAuth through the existing
  private authorization flow.
- Cached leases are never reused across repository or operation scopes.

## Compatibility And Rollout

1. Introduce scoped lease-cache support and request-aware credential issuance
   without changing existing grants.
2. Cut typed issue and pull request creation to installation grants.
3. Add explicitly tested issue and pull request lifecycle routes.
4. Invert commit attribution to Junior-as-author with all humans as co-authors.
5. Cut Git smart-HTTP pushes to the repository-scoped branch-write grant.
6. Remove ordinary resource mutations from `user-write`; leave only enumerated
   human-identity operations.

There is no compatibility fallback from bot identity to user identity. A route
remains on its prior explicit identity until cut over, then follows the new
policy exclusively.

## Verification

- Focused GitHub plugin tests for every grant classification and permission
  body.
- Sandbox egress integration tests proving repository/operation lease isolation
  and fail-closed unknown writes.
- Typed issue and pull request integration tests proving installation
  credentials and requester attribution.
- Git hook tests proving Junior author/committer identity and complete human
  co-author attribution.
- Git smart-HTTP classification and repository-scoped permission-body tests.
- Local-agent behavior checks for issue and pull request creation.
