# github setup

This skill uses host-issued GitHub App installation tokens.

## 1) Create/install GitHub App

In GitHub:

1. Go to `Settings -> Developer settings -> GitHub Apps -> New GitHub App`.
2. Set app name and callback URL (any valid HTTPS URL is fine if you do not use web flow).
3. Under repository permissions, grant:

- Issues: Read and write
- Contents: Read and write
- Pull requests: Read and write
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
- `GITHUB_INSTALLATION_ID`

Current limitation: one Junior deployment uses one GitHub App installation ID.
That works for repositories covered by the same installation, but not for repositories that live
under different app installations across orgs/accounts.

### Vercel env setup (multiline-safe)

`GITHUB_APP_PRIVATE_KEY` is accepted as:

- Raw PEM (multiline)
- Escaped-newline PEM (single-line with `\n`)
- Base64-encoded PEM

For Vercel, prefer CLI file input so newlines are preserved exactly:

```bash
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_INSTALLATION_ID production
vercel env add GITHUB_APP_PRIVATE_KEY production --sensitive < ./github-app-private-key.pem
```

If variables already exist, use `vercel env update` instead of `vercel env add`:

```bash
vercel env update GITHUB_APP_PRIVATE_KEY production --sensitive < ./github-app-private-key.pem
```

Repeat for `preview` and `development` as needed. After env changes, redeploy so the new deployment picks up updated values.

## 3) Runtime behavior

- Credentials are issued lazily when `jr-rpc issue-credential <capability>` is run.
- Issued credentials are reused for the rest of the current turn.
- Sandbox does not receive raw tokens via env; host applies scoped Authorization header transforms for GitHub API calls.

## 4) CLI usage

Run as a regular sandbox `bash` command while this skill is active:

Clone a repository with a shallow checkout by default:

```bash
gh repo clone owner/repo -- --depth=1
```

Deepen later only if the task needs more history:

```bash
git -C repo fetch --depth=50 origin
git -C repo fetch --unshallow
```

GitHub operations still require scoped credentials:

```bash
jr-rpc issue-credential github.issues.write --target owner/repo
gh issue create --repo owner/repo --title "Example issue" --body-file /vercel/sandbox/tmp/issue.md
```

`gh` supports either direct `GITHUB_TOKEN` (for local debugging) or sandbox-level header injection.
Use `github.issues.read` for read-only issue commands, `github.issues.write` for issue edits, comments, and labels, `github.contents.write` for pushes and merge operations, and `github.pull-requests.write` for PR mutations after the branch is already on the remote.

GitHub capability scoping is a safety rail, not a hard sandbox boundary. It helps prevent accidental write scope and wrong-repo mutations, but the host runtime still decides when to mint credentials and the agent can request broader GitHub capabilities when the task requires them.

Be careful with mixed-surface PR commands:

- `gh pr edit` title/body/base/reviewer changes fit `github.pull-requests.write`.
- `gh pr edit` label changes fit `github.issues.write`.
- `gh pr edit` assignee/milestone changes fit `github.issues.write`.
- `gh pr close --comment` may need `github.issues.write`.
- `gh pr close --delete-branch` needs `github.contents.write`.

For PR creation in automation, push explicitly and use `--head`:

```bash
jr-rpc issue-credential github.contents.write --target owner/repo
git -C repo push -u origin BRANCH
jr-rpc issue-credential github.pull-requests.write --target owner/repo
gh pr create --repo owner/repo --head BRANCH --base main --title "Example PR" --body-file /vercel/sandbox/tmp/pr.md
```

Optional: set a default repository once per channel/thread context so `--repo` is not needed each turn:

```bash
jr-rpc config set github.repo getsentry/junior
```

## 5) Quick verification

- `pnpm skills:check`
- Create issue in a test repo.
- Update/comment/label the same issue.
- Push a test branch and create a draft PR with `--head`.
- Use read-only commands (`gh issue view`, `gh api .../comments`, `gh pr view`) for issue inspection.

## 6) Production verification (step-by-step)

1. Confirm host env vars are present in prod:
   - `GITHUB_APP_ID`
   - `GITHUB_APP_PRIVATE_KEY`
   - `GITHUB_INSTALLATION_ID`
2. Confirm the GitHub App is installed on your test repo with the permissions above.
3. Deploy `main` to prod.
4. Run `/github` to create an issue in a safe test repo.
5. Verify the issue is authored by the GitHub App identity.
6. Run `/github` to update title/body, add/remove labels, and add a comment.
7. Push a test branch and run `/github` to create a draft PR using explicit repo targeting and `--head`.
8. Verify all mutations succeed and are attributed to the app.
9. Verify GitHub API calls succeed while this skill is active without writing tokens into sandbox env/files.
10. Verify raw token values are never printed in output or logs.
11. Check logs for:

- `credential_issue_request`
- `credential_issue_success`
- `credential_inject_start`
- `credential_inject_cleanup`

12. Verify logs contain no token/private-key values.
13. Negative test: target a repo without app installation and confirm explicit failure.
