# GitHub CLI Troubleshooting — code & pull requests

Use this table to recover quickly while keeping operations deterministic.

| Symptom                                                                         | Likely cause                                                                | Fix                                                                                                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown command "..."` from `gh`                                               | CLI version too old or wrong binary.                                        | Verify `gh --version`; ensure GitHub CLI from `gh-cli` repo is installed.                                                                   |
| `unknown flag: --depth` from `gh repo clone`                                    | `git clone` flags were passed before `--`.                                  | Pass clone flags after `--`, for example `gh repo clone owner/repo -- --depth=1`.                                                           |
| `Missing required option --repo`                                                | Repo not passed and no default was resolved.                                | Resolve with `jr-rpc config get github.repo`; pass `--repo owner/repo` explicitly when missing.                                             |
| Command affects or authenticates against the wrong repo                         | Stale `github.repo` default or authenticated command missing explicit repo. | Pass `--repo owner/repo` for the target repository, or update `github.repo` before retrying.                                                |
| `GraphQL: Could not resolve to a Repository`                                    | Repo slug is wrong or inaccessible.                                         | Validate `owner/repo` and confirm app installation on target repository.                                                                    |
| 401 Unauthorized                                                                | Repo context is missing, stale, or the stored GitHub auth needs reconnect.  | Verify `--repo owner/repo` or `github.repo`, then retry the real command once so the runtime can reconnect automatically when needed.       |
| `git push` fails with 401/403 or auth/permission output                         | Write auth was stale or the command is targeting the wrong repo.            | Verify the remote and repo context, retry the same push once, then confirm app permissions and installation scope if the retry still fails. |
| 403 Forbidden                                                                   | App lacks required permission on repo or install scope is too narrow.       | Verify the repo context, then confirm GitHub App permissions and installation scope.                                                        |
| `gh pr create` fails with auth/permission errors or tries to push interactively | The branch was not pushed first, or repo context is wrong.                  | Push the branch explicitly first, then rerun `gh pr create --repo owner/repo --head BRANCH ...`.                                            |
| `git blame`, long log history, or old commits are missing after clone           | Repo was cloned shallow by design.                                          | Deepen incrementally with `git -C DIRECTORY fetch --depth=N origin`, or `git -C DIRECTORY fetch --unshallow` when full history is required. |
| `sandbox setup failed (dnf install gh failed ...)`                              | `gh` package not available in default repos.                                | Configure/install from GitHub RPM repo (`gh-cli`) in sandbox dependency bootstrap, then retry.                                              |

## Retry guidance

- Retry once for transient auth/transport failures after verifying repo context.
- Do not loop retries on repeated 401/403/404 validation errors.
- For persistent permission problems, return explicit remediation and stop.
