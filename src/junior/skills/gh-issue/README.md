# gh-issue setup

This skill uses host-issued GitHub App installation tokens and only accepts `GITHUB_TOKEN` in the sandbox.

## 1) Create/install GitHub App

In GitHub:
1. Go to `Settings -> Developer settings -> GitHub Apps -> New GitHub App`.
2. Set app name and callback URL (any valid HTTPS URL is fine if you do not use web flow).
3. Under repository permissions, grant:
- Issues: Read and write
- Metadata: Read
4. Create the app and generate a private key.
5. Install the app on the target org/repo(s).

Install the app on target repos/orgs and collect:
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` (PEM)

## 2) Configure host runtime

Set on the harness host (never in skill files):
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- optional `GITHUB_INSTALLATION_ID` (pin installation instead of repo lookup)

## 3) Runtime behavior

- Capability runtime issues a short-lived installation token per command lease.
- Sandbox receives only `GITHUB_TOKEN` for command scope.
- `jr-rpc credential issue` does not print token values.

## 4) Script usage

Run via `jr-rpc credential exec`:

```bash
jr-rpc credential exec --cap github.issues.write --repo owner/repo -- \
  node /vercel/sandbox/skills/gh-issue/scripts/gh_issue_api.mjs create \
    --repo owner/repo \
    --title "Example issue" \
    --body-file /vercel/sandbox/tmp/issue.md
```

`gh_issue_api.mjs` fails fast if `GITHUB_TOKEN` is missing.

## 5) Quick verification

- `pnpm skills:check`
- Create issue in a test repo.
- Update/comment/label the same issue.

## 6) Production verification (step-by-step)

1. Confirm host env vars are present in prod:
   - `GITHUB_APP_ID`
   - `GITHUB_APP_PRIVATE_KEY`
   - optional `GITHUB_INSTALLATION_ID`
2. Confirm the GitHub App is installed on your test repo with the permissions above.
3. Deploy `main` to prod.
4. Run `/gh-issue` to create an issue in a safe test repo.
5. Verify the issue is authored by the GitHub App identity.
6. Run `/gh-issue` to update title/body, add/remove labels, and add a comment.
7. Verify all mutations succeed and are attributed to the app.
8. Verify `jr-rpc credential issue` output is metadata/redacted only (no raw token).
9. Verify `jr-rpc credential exec` can run a command that requires `GITHUB_TOKEN`.
10. Check logs for:
   - `credential_issue_request`
   - `credential_issue_success`
   - `credential_inject_start`
   - `credential_inject_cleanup`
11. Verify logs contain no token/private-key values.
12. Negative test: target a repo without app installation and confirm explicit failure.
