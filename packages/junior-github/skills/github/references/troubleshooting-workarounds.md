# GitHub CLI Troubleshooting

Use this table to recover quickly while keeping operations deterministic.

| Symptom                                                               | Likely cause                                                                   | Fix                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unknown command "issue"` from `gh`                                   | CLI version too old or wrong binary.                                           | Verify `gh --version`; ensure GitHub CLI from `gh-cli` repo is installed.                                                                              |
| `unknown flag: --depth` from `gh repo clone`                          | `git clone` flags were passed before `--`.                                     | Pass clone flags after `--`, for example `gh repo clone owner/repo -- --depth=1`.                                                                      |
| `Missing required option --repo`                                      | Repo not passed and no default was resolved.                                   | Resolve with `jr-rpc config get github.repo`; pass `--repo owner/repo` explicitly when missing.                                                        |
| `GraphQL: Could not resolve to a Repository`                          | Repo slug is wrong or inaccessible.                                            | Validate `owner/repo` and confirm app installation on target repository.                                                                               |
| 401 Unauthorized                                                      | Credential not issued for current command scope.                               | Run `jr-rpc issue-credential <capability>` for the exact command and retry once.                                                                       |
| 401 on `git clone`/`git push` after credential issuance               | `gh repo clone` embeds the placeholder token in the URL, bypassing proxy auth. | Use `git clone https://github.com/owner/repo.git` directly instead of `gh repo clone`. The sandbox proxy injects the real token via header transforms. |
| 403 Forbidden                                                         | App lacks required permission on repo.                                         | Confirm GitHub App permissions and installation scope.                                                                                                 |
| 404 Not Found                                                         | Issue number or repo is wrong.                                                 | Validate repo + issue ID with `gh issue view NUMBER --repo owner/repo`.                                                                                |
| `git blame`, long log history, or old commits are missing after clone | Repo was cloned shallow by design.                                             | Deepen incrementally with `git -C DIRECTORY fetch --depth=N origin`, or use `git -C DIRECTORY fetch --unshallow` when full history is required.        |
| `sandbox setup failed (dnf install gh failed ...)`                    | `gh` package not available in default repos.                                   | Configure/install from GitHub RPM repo (`gh-cli`) in sandbox dependency bootstrap, then retry.                                                         |
| `gh issue edit` does not change labels                                | Wrong flag usage or missing label capability context.                          | Use repeated `--add-label/--remove-label` flags and issue `github.labels.write` credential first.                                                      |
| Comment command fails with empty body                                 | Body file missing/empty.                                                       | Ensure comment file exists and has content before `gh issue comment`.                                                                                  |

## Retry guidance

- Retry once for transient auth/transport failures after reissuing credentials.
- Do not loop retries on repeated 401/403/404 validation errors.
- For persistent permission problems, return explicit remediation and stop.
