# @sentry/junior-github

`@sentry/junior-github` adds GitHub issue, pull request, and repository workflows to Junior using a GitHub App.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-github
```

Register the trusted plugin from app code:

```ts
import { createApp } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";

const app = await createApp({
  plugins: [
    githubPlugin({
      botNameEnv: "GITHUB_APP_BOT_NAME",
      botEmailEnv: "GITHUB_APP_BOT_EMAIL",
    }),
  ],
});
```

Also list `@sentry/junior-github` in `juniorNitro({ plugins: { packages: [...] } })`
so Nitro bundles the manifest and bundled GitHub skill.

Full setup guide: https://junior.sentry.dev/extend/github-plugin/
