# Tasks

## 1. Credential Grant Scope

- [x] Extend the plugin grant contract with a small provider-neutral lease scope
      used for credential-cache isolation.
- [x] Include the lease scope in sandbox egress cache lookup, persistence,
      clearing, and validation without changing user-visible grant names.
- [x] Keep the lease scope opaque to the host so provider plugins can carry a
      validated resource target into credential issuance without leaking
      provider request types.
- [x] Add component coverage proving leases cannot be reused across operation
      families, repositories, actors, sandbox contexts, or expired contexts.

## 2. GitHub Installation Write Credentials

- [x] Add explicit `installation-issues-write` and
      `installation-pull-requests-write` GitHub grants.
- [x] Parse and canonicalize the target repository inside the GitHub provider
      boundary.
- [x] Mint repository-scoped installation tokens with the minimum permissions
      required by the selected grant.
- [x] Keep missing installation configuration and unsupported App permissions
      as unavailable or permission-denied outcomes without OAuth fallback.
- [x] Add focused GitHub plugin tests for permission bodies, repository scope,
      cache scope, and provider rejection diagnostics.

## 3. Issue And Pull Request Ownership

- [x] Move typed issue creation from `user-write` to the scoped issue
      installation grant.
- [x] Move typed pull request creation from `user-write` to the scoped pull
      request installation grant.
- [x] Add explicit REST classifications for the approved issue lifecycle
      operations and deny unsupported issue mutations.
- [x] Add explicit REST classifications for the approved pull request lifecycle
      operations and deny reviews, approvals, merge, deletion, and
      administration.
- [x] Keep unknown REST writes, GraphQL mutations, oversized GraphQL bodies, and
      generic non-read fallbacks denied rather than delegated automatically.
- [x] Add sandbox egress integration coverage for typed creation, allowlisted
      lifecycle writes, denied mutations, and no user-OAuth fallback.

## 4. Resource Attribution

- [x] Add a GitHub-owned attribution helper that formats verified runtime actors
      without inventing provider handles.
- [x] Append deterministic `Requested by` attribution to typed issue bodies.
- [x] Append deterministic `Requested by` attribution to typed pull request
      bodies.
- [x] Make Junior the Git author and committer for Junior-managed commits.
- [x] Include every resolvable human run actor, including the primary actor,
      exactly once as `Co-Authored-By`.
- [x] Add focused tool and Git-hook tests for interactive, multi-actor, missing
      profile, duplicate actor, and system-actor attribution.

## 5. Repository-Scoped Branch Pushes

- [x] Select `installation-pr-branch-write` only for Git smart-HTTP
      `git-receive-pack` traffic.
- [x] Bind the branch-write lease to the canonical target repository.
- [x] Request `contents: write` and include `workflows: write` only when it is
      present in the configured App permission envelope.
- [x] Keep REST contents writes, merges, and unknown write surfaces denied.
- [x] Document that branch ownership, force-update, and ref-deletion controls rely on GitHub
      branch protection, rulesets, and installation scope.
- [x] Add focused classification and credential permission-body coverage.
- [x] Add host egress coverage proving a headless resource-event system actor
      can receive the scoped branch-write credential without a user subject.
- [x] Preserve the resource-event system actor across Slack continuation slices
      and cover resumed headless turns at the integration boundary.

## 6. Human-Identity Exceptions

- [x] Enumerate the remaining GitHub operations that genuinely require human
      identity, beginning with reviews, approvals, change requests, and
      user-private reads.
- [x] Restrict `user-write` selection to those enumerated operations.
- [x] Preserve private OAuth authorization only for explicit human-identity
      operations.
- [x] Add integration coverage proving bot-owned operations do not prompt for
      OAuth and human-owned operations do not use installation credentials.

## 7. Specifications And Documentation

- [x] Update `specs/identity.md` with service-principal preference for
      Junior-owned provider operations.
- [x] Update `specs/credential-injection.md` with scoped installation write
      grants, cache isolation, request-aware issuance, and failure behavior.
- [x] Update GitHub setup and public plugin documentation with required App
      permissions and the bot-owned operation allowlist.
- [x] Update GitHub skills so identity, confirmation, and denied-operation
      guidance matches the runtime policy.
- [x] Cross-reference #780 and preserve the distinction between execution
      identity and requester/contributor attribution.

## 8. Validation

- [x] Run focused `@sentry/junior-github` tests for grant classification,
      credential issuance, typed tools, and Git attribution.
- [x] Run a focused resource-event eval proving the agent fixes, commits, and
      pushes a watched pull request branch against an isolated local Git
      remote without requesting human authorization; deterministic integration
      tests separately prove bot identity and installation credential issuance.
- [x] Run focused `@sentry/junior` integration tests for sandbox egress lease
      scope, provider denial, and push intent.
- [x] Run package typechecks and the repository typecheck gate.
- [ ] Run local-agent validation for issue creation and pull request creation
      using `pnpm cli -- chat ...`.
- [ ] Verify the created GitHub issue and pull request show Junior as creator,
      include requester attribution, and do not require user OAuth.
- [ ] Verify a human review still requires delegated human identity.
