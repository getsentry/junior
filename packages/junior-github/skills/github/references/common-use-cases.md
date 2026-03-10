# Common GitHub Issue CLI Use Cases

Use these patterns as direct execution playbooks.

## 1) Create a bug issue

```bash
jr-rpc issue-credential github.issues.write
gh issue create --repo owner/repo --title "OAuth token refresh fails in long-running thread" --body-file /vercel/sandbox/tmp/issue.md
```

`/vercel/sandbox/tmp/issue.md` should end with:

```md
Action taken on behalf of Jane Doe.
```

## 2) Patch issue title/body

```bash
jr-rpc issue-credential github.issues.write
gh issue edit 123 --repo owner/repo --title "Clarify retry semantics for lock contention" --body-file /vercel/sandbox/tmp/revised-issue.md
```

## 3) Close or reopen issue

```bash
jr-rpc issue-credential github.issues.write
gh issue close 123 --repo owner/repo --comment "Fixed in #456"
```

Reopen:

```bash
gh issue reopen 123 --repo owner/repo
```

## 4) Add implementation comment

```bash
jr-rpc issue-credential github.issues.comment
gh issue comment 123 --repo owner/repo --body-file /vercel/sandbox/tmp/comment.md
```

## 5) Apply triage labels

```bash
jr-rpc issue-credential github.labels.write
gh issue edit 123 --repo owner/repo --add-label bug --add-label needs-triage
```

Remove labels:

```bash
gh issue edit 123 --repo owner/repo --remove-label needs-triage
```

## 6) Read issue details before mutation

```bash
jr-rpc issue-credential github.issues.read
gh issue view 123 --repo owner/repo --json number,title,state,labels,assignees,author,url,body
```

## 7) Read comment history in JSON

```bash
jr-rpc issue-credential github.issues.read
gh api /repos/owner/repo/issues/123/comments --method GET --header "Accept: application/vnd.github+json"
```
