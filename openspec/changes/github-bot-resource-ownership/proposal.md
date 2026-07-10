# GitHub Bot Resource Ownership

## Summary

Make Junior the primary GitHub identity for issues, pull requests, and
Junior-managed pull-request branches while keeping bot write authority
deny-by-default and narrowly scoped to approved resource workflows.

## Motivation

GitHub reads currently use GitHub App installation tokens, but writes use a
requesting or delegated user's GitHub App OAuth token. That makes ordinary
Junior-owned work appear to have been performed by a human and turns every
multi-actor run into a credential-delegation decision.

Junior should act as itself when it owns the resulting resource. Human identity
belongs in explicit attribution metadata, not in the provider credential used
to execute the operation. This matches the existing scheduler split between a
system execution actor and creator audit metadata and reduces the confused
deputy surface tracked in #773.

The cutover must not create an ambient installation write token. A credential
issued for an approved issue, pull request, or branch operation must not become
usable for arbitrary REST mutations, GraphQL mutations, pushes, or repository
administration.

## Scope

- Define service-principal identity as the default execution identity for
  Junior-owned provider resources.
- Make Junior the creator and lifecycle actor for GitHub issues and pull
  requests within an explicit operation allowlist.
- Add operation-scoped installation grants for issue management, pull request
  management, and repository-scoped Git smart-HTTP pushes.
- Allow headless system turns, including subscribed resource-event deliveries,
  to use those scoped installation grants without borrowing a human OAuth
  credential.
- Bind bot write leases to the classified operation and target repository and
  request only the minimum GitHub App permissions required by that grant.
- Keep raw or unclassified GitHub writes off bot credentials.
- Keep operations that inherently express human judgment, including reviews,
  approvals, and change requests, on explicit delegated user identity.
- Keep merge, repository administration, and non-Git write surfaces outside the
  initial bot-owned allowlist.
- Make Junior the Git author and committer for Junior-managed commits and credit
  every resolvable human run actor with `Co-Authored-By` trailers.
- Add runtime-owned requester attribution to issues and pull requests without
  fabricating GitHub identities.
- Update identity, credential, GitHub setup, and behavior documentation.

## Non-Goals

- Giving the GitHub App a generic or provider-wide write grant.
- Automatically falling back from a denied bot operation to a human OAuth
  token.
- Treating run actor membership as provider authorization.
- Performing reviews, approvals, or change requests as Junior.
- Enabling merges, REST ref administration, workflow administration, or
  repository administration through this change.
- Providing an independent branch-ownership, force-push, or ref-deletion policy beyond the
  target repository scope and GitHub branch protections.
- Solving provider-resource ownership for every plugin in the first
  implementation.

## Design Notes

Typed issue and pull request creation already carry trusted operation names and
are the first safe cutover. Additional lifecycle routes must be explicitly
classified before receiving installation write credentials.

Git smart HTTP exposes a distinct `git-receive-pack` operation and target
repository. Junior classifies that surface into a repository-scoped
installation grant. This intentionally does not add a second branch-level
policy engine; operators use GitHub branch protection and installation scope
for branch, force-update, and ref-deletion controls.

Related work: #773, #777, #778, #780, and #789.
