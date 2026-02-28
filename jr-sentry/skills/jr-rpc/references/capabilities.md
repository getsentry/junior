# Capability guidance

Use provider-qualified capability names:

- `github.issues.read`
- `github.issues.write`
- `github.issues.comment`
- `github.labels.write`
- `sentry.api`

Examples:

- `jr-rpc issue-credential github.issues.write --repo getsentry/junior`
- `jr-rpc issue-credential sentry.api`

Scoping rules:

- GitHub capabilities require `--repo <owner/repo>`.
- Sentry capabilities are org-scoped (no `--repo` needed).
- Declare capabilities in the consuming skill's `requires-capabilities` frontmatter. Currently soft-enforced (warn-only).
