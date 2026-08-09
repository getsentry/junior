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

Keep policies short. Use ASD-STE100 English: common words, active voice, short
sentences, and one idea per sentence. Keep required domain terms from
`../TERMINOLOGY.md`, but explain them when the reader may not know them. Remove
other jargon. State the intent, the default, and only real exceptions. Update
the policy when the repo changes the default. Silence elsewhere does not create
an exception.

Use `policy-template.md` for new policies.
