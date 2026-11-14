# GitHub plugin setup

The full setup guide is at https://junior.sentry.dev/extend/github-plugin/. It
covers the GitHub App, permissions, environment variables, webhooks,
migrations, and verification.

## Private key on Vercel

`GITHUB_APP_PRIVATE_KEY` is a multiline PEM key. Add it from the file so that
Vercel keeps the newlines:

```bash
vercel env add GITHUB_APP_PRIVATE_KEY production --sensitive < ./github-app-private-key.pem
```

Use `vercel env update` when the variable already exists. Redeploy after each
change.

## Write limits

- Do not grant `Administration: write`. Junior pushes a branch and opens the
  pull request with `github_createPullRequest`. It does not create forks.
- Grant `Repository creation: write`, organization `Custom properties: write`,
  and `Members: read` only if Junior may create organization repositories,
  and configure `repositoryProfiles`. Define the organization custom property
  `provisioned-by` with the value `jr`. Only `github_createRepository` uses the
  create token, which has only the create and custom property permissions. Guardian reviews each creation.
- Junior cannot detect force pushes or ref deletion. Use branch protection,
  and install the App only on repositories where Junior may push.
