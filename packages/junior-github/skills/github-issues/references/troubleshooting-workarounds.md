# GitHub CLI Troubleshooting — issues

Use this table to recover quickly while keeping operations deterministic.

| Symptom                                                    | Likely cause                                                                | Fix                                                                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown command "issue"` from `gh`                        | CLI version too old or wrong binary in the plugin runtime.                  | Verify `gh --version`; if it is unavailable or too old, report that the GitHub plugin runtime dependency is not available.                |
| `Missing required option --repo`                           | Repo not passed and no default was resolved.                                | Resolve with `jr-rpc config get github.repo`; pass `--repo owner/repo` explicitly when missing.                                           |
| Command affects or authenticates against the wrong repo    | Stale `github.repo` default or authenticated command missing explicit repo. | Pass `--repo owner/repo` for the target repository, or update `github.repo` before retrying.                                              |
| `GraphQL: Could not resolve to a Repository`               | Repo slug is wrong or inaccessible.                                         | Validate `owner/repo` and confirm app installation on target repository.                                                                  |
| 401 Unauthorized                                           | Issued GitHub credentials were rejected upstream.                           | Verify the target repo, then use the grant/auth signal to distinguish stale user OAuth from app installation or host env setup.           |
| `junior-auth-required provider=github grant=user-write`    | User-to-server OAuth is missing or stale for a human-identity operation.    | Follow the private OAuth prompt; do not ask the user to paste or manage tokens manually.                                                  |
| 403 without `permission_denied` where `source: "upstream"` | Junior may have rejected an unsupported route before contacting GitHub.     | Read the response body. Follow any required-tool instruction; do not ask for GitHub permissions unless the failure is confirmed upstream. |
| `permission_denied` with `source: "upstream"`              | GitHub rejected the injected installation credential.                       | Verify the target, accepted permissions, and App installation scope; do not request user OAuth for a bot-owned issue operation.           |
| 404 Not Found                                              | Issue number or repo is wrong.                                              | Validate repo + issue ID with `gh issue view NUMBER --repo owner/repo`.                                                                   |
| Issue label mutation fails                                 | Wrong REST payload or wrong repo context.                                   | Use the allowlisted issue labels endpoint with an explicit `owner/repo` path and valid JSON input.                                        |
| Comment command fails with empty body                      | JSON input is missing a non-empty `body`.                                   | Ensure the REST comment payload contains a non-empty `body` before retrying.                                                              |

## Retry guidance

- Retry once for transient transport failures after verifying repo context.
- Do not loop retries on repeated 401/403/404 validation errors.
- Treat missing or stale `user-read`/`user-write` grants as private GitHub App OAuth work. Treat all `installation-*` failures as App permission, installation scope, or host environment setup; they do not fall back to user OAuth.
- For persistent permission problems, return explicit remediation and stop.
