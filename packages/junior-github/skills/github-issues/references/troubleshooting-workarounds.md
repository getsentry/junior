# GitHub CLI Troubleshooting — issues

Use this table to recover quickly while keeping operations deterministic.

| Symptom                                                 | Likely cause                                                                | Fix                                                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `unknown command "issue"` from `gh`                     | CLI version too old or wrong binary in the plugin runtime.                  | Verify `gh --version`; if it is unavailable or too old, report that the GitHub plugin runtime dependency is not available.     |
| `Missing required option --repo`                        | Repo not passed and no default was resolved.                                | Resolve with `jr-rpc config get github.repo`; pass `--repo owner/repo` explicitly when missing.                                |
| Command affects or authenticates against the wrong repo | Stale `github.repo` default or authenticated command missing explicit repo. | Pass `--repo owner/repo` for the target repository, or update `github.repo` before retrying.                                   |
| `GraphQL: Could not resolve to a Repository`            | Repo slug is wrong or inaccessible.                                         | Validate `owner/repo` and confirm app installation on target repository.                                                       |
| 401 Unauthorized                                        | Host-managed GitHub App credentials were rejected.                          | Verify the target repo, then report the exact command failure and confirm the app installation and host environment variables. |
| 403 Forbidden                                           | App lacks required permission on repo or install scope is too narrow.       | Verify the repo context, then confirm GitHub App permissions and installation scope.                                           |
| 404 Not Found                                           | Issue number or repo is wrong.                                              | Validate repo + issue ID with `gh issue view NUMBER --repo owner/repo`.                                                        |
| `gh issue edit` does not change labels                  | Wrong flag usage or wrong repo context.                                     | Use repeated `--add-label/--remove-label` flags and keep `--repo owner/repo` explicit.                                         |
| Comment command fails with empty body                   | Body file missing/empty.                                                    | Ensure comment file exists and has content before `gh issue comment`.                                                          |

## Retry guidance

- Retry once for transient transport failures after verifying repo context.
- Do not loop retries on repeated 401/403/404 validation errors.
- Do not describe GitHub auth failures as user reconnect work; this plugin uses host-managed GitHub App credentials.
- For persistent permission problems, return explicit remediation and stop.
