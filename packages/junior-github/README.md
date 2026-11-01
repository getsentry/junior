# @sentry/junior-github

GitHub repository, issue, pull request, deployment, and release workflows for Junior through a GitHub App.

```bash
pnpm add @sentry/junior @sentry/junior-github
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";

export const plugins = defineJuniorPlugins([
  githubPlugin({
    botNameEnv: "GITHUB_APP_BOT_NAME",
    botEmailEnv: "GITHUB_APP_BOT_EMAIL",
  }),
]);
```

Setup and configuration: https://junior.sentry.dev/extend/github-plugin/
