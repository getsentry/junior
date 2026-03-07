---
title: GitHub Plugin
description: Configure GitHub App credentials for issue workflows.
---

The GitHub plugin uses GitHub App credentials so Junior can run repository workflows with explicit capability scoping.

## Setup

### Configure host env vars

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_INSTALLATION_ID`

Vercel example:

```bash
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_INSTALLATION_ID production
vercel env add GITHUB_APP_PRIVATE_KEY production --sensitive < ./github-app-private-key.pem
```

### Issue capability-scoped credentials at runtime

```bash
jr-rpc issue-credential github.issues.write
gh issue create --repo owner/repo --title "Example issue" --body "Created from Junior"
```

Optional default repo:

```bash
jr-rpc config set github.repo getsentry/junior
```

## Verify

- Create/update/comment/label operations succeed in a test repo.
- Actions are attributed to the GitHub App identity.

## Failure modes

- Access denied: app not installed on target repo/org.
- Missing capability: wrong credential scope for operation.

## Next step

Read [Runtime Commands](/reference/runtime-commands/) for credential/config command behavior.
