# Common GitHub CLI Use Cases — code & pull requests

Use these patterns as direct execution playbooks.

## 1) Clone a repository for local work

Default to a shallow clone:

```bash
gh repo clone owner/repo -- --depth=1
```

Clone into a specific directory:

```bash
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

## 3) Create a pull request safely in automation

Push the branch explicitly before creating the PR. This avoids `gh pr create`
trying to push or fork implicitly.

```bash
git -C worktree/repo push -u origin BRANCH
gh pr create --repo owner/repo --head BRANCH --base main --title "fix(repo): narrow GitHub repo scoping" --body-file /vercel/sandbox/tmp/pr.md
```
