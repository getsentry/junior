# Common GitHub CLI Use Cases — issues

Use these patterns as direct execution playbooks.

## 1) Create an issue

```bash
gh issue create --repo owner/repo --title "OAuth token refresh fails in long-running thread" --body-file /vercel/sandbox/tmp/issue.md
```

`/vercel/sandbox/tmp/issue.md` should end with the delegated-action footer when applicable:

```md
Action taken on behalf of Jane Doe.
```

## 2) Patch issue title/body

```bash
gh issue edit 123 --repo owner/repo --title "Clarify retry semantics for lock contention" --body-file /vercel/sandbox/tmp/revised-issue.md
```

## 3) Close or reopen issue

```bash
gh issue close 123 --repo owner/repo --comment "Fixed in #456"
gh issue reopen 123 --repo owner/repo
```

## 4) Add implementation comment

```bash
gh issue comment 123 --repo owner/repo --body-file /vercel/sandbox/tmp/comment.md
```

## 5) Apply and remove triage labels

```bash
gh issue edit 123 --repo owner/repo --add-label bug --add-label needs-triage
gh issue edit 123 --repo owner/repo --remove-label needs-triage
```

## 6) Read issue details before mutation

```bash
gh issue view 123 --repo owner/repo --json number,title,state,labels,assignees,author,url,body
```

## 7) Read comment history in JSON

```bash
gh api /repos/owner/repo/issues/123/comments --method GET --header "Accept: application/vnd.github+json"
```
