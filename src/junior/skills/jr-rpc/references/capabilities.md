# Capability guidance

Use capability names declared by active skill policy, for example:

- `github.issues.read`
- `github.issues.write`
- `github.issues.comment`
- `github.labels.write`
- `sentry.issues.read`
- `sentry.events.read`
- `sentry.replays.read`

Examples:

- `jr-rpc issue-credential github.issues.write --repo getsentry/junior`
- `jr-rpc issue-credential sentry.issues.read`

Scoping rules:

- Capability should be declared in the active skill frontmatter (`requires-capabilities`).
- Declarations are currently soft-enforced (warn-only) and will harden later.
- GitHub capabilities require `--repo <owner/repo>`. Sentry capabilities are org-scoped (no `--repo` needed).
