# Policies

Policies are durable repo-wide engineering rules and defaults. They are the
highest-authority repository documentation below executable configuration and
must remain consistent with code-enforced constraints.

Use a policy when the repository needs to say "this is how we do this here"
across multiple packages or features. Examples include testing, comments,
security, privacy, error handling, provider boundaries, interface design, and
serverless work.

Do not use policies for:

- one feature's architecture or lifecycle;
- implementation plans, status, TODOs, or rollout tracking;
- copied schemas, commands, or test inventories;
- public product documentation.

Feature architecture and non-obvious invariants belong in the owning package or
module `README.md`. Code, runtime schemas, exported types, and tests define the
implemented contract. Temporary implementation plans live under
`../openspec/changes/` and cannot override policy.

Keep policies short: explain the intent, state the default, and name only
meaningful exceptions. Update the policy directly when the repo intends to
change the default; silence elsewhere never creates an exception.

Use `policy-template.md` for new policies.
