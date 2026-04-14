# Common GitHub CLI Use Cases

Use these patterns as direct execution playbooks.

## 1) Clone a repository for local work

Issue credentials first, then default to a shallow clone:

```bash
jr-rpc issue-credential github.contents.read --repo owner/repo
gh repo clone owner/repo -- --depth=1
```

Clone into a specific directory:

```bash
jr-rpc issue-credential github.contents.read --repo owner/repo
gh repo clone owner/repo worktree/repo -- --depth=1
```

## 2) Deepen a shallow clone only when needed

```bash
git -C worktree/repo fetch --depth=50 origin
```

Convert to a full clone:

```bash
git -C worktree/repo fetch --unshallow
```

## 3) Create a bug issue

```bash
jr-rpc issue-credential github.issues.write --repo owner/repo
gh issue create --repo owner/repo --title "OAuth token refresh fails in long-running thread" --body-file /vercel/sandbox/tmp/issue.md
```

`/vercel/sandbox/tmp/issue.md` should end with:

```md
Action taken on behalf of Jane Doe.
```

## 4) Patch issue title/body

```bash
jr-rpc issue-credential github.issues.write --repo owner/repo
gh issue edit 123 --repo owner/repo --title "Clarify retry semantics for lock contention" --body-file /vercel/sandbox/tmp/revised-issue.md
```

## 5) Close or reopen issue

```bash
jr-rpc issue-credential github.issues.write --repo owner/repo
gh issue close 123 --repo owner/repo --comment "Fixed in #456"
```

Reopen:

```bash
gh issue reopen 123 --repo owner/repo
```

## 6) Add implementation comment

```bash
jr-rpc issue-credential github.issues.write --repo owner/repo
gh issue comment 123 --repo owner/repo --body-file /vercel/sandbox/tmp/comment.md
```

## 7) Apply triage labels

```bash
jr-rpc issue-credential github.issues.write --repo owner/repo
gh issue edit 123 --repo owner/repo --add-label bug --add-label needs-triage
```

Remove labels:

```bash
gh issue edit 123 --repo owner/repo --remove-label needs-triage
```

## 8) Read issue details before mutation

```bash
jr-rpc issue-credential github.issues.read --repo owner/repo
gh issue view 123 --repo owner/repo --json number,title,state,labels,assignees,author,url,body
```

## 9) Read comment history in JSON

```bash
jr-rpc issue-credential github.issues.read --repo owner/repo
gh api /repos/owner/repo/issues/123/comments --method GET --header "Accept: application/vnd.github+json"
```

## 10) Create a pull request safely in automation

Push the branch explicitly before creating the PR. This avoids `gh pr create`
trying to push or fork implicitly.

```bash
jr-rpc issue-credential github.contents.write --repo owner/repo
git -C worktree/repo push -u origin BRANCH
jr-rpc issue-credential github.pull-requests.write --repo owner/repo
gh pr create --repo owner/repo --head BRANCH --base main --title "fix(repo): narrow GitHub repo scoping" --body-file /vercel/sandbox/tmp/pr.md
```
