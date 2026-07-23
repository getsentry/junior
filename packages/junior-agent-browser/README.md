# @sentry/junior-agent-browser

`@sentry/junior-agent-browser` adds browser automation and visual QA workflows to Junior via the `agent-browser` CLI.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-agent-browser
```

Add the package name to the plugin set exported from `plugins.ts`:

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-agent-browser"]);
```

The package includes two skills:

- `/agent-browser` for general browser navigation, interaction, extraction, and capture
- `/visual-web-qa` for evidence-driven verification of frontend, docs, layout, theme, loading, animation, and interaction changes

For example:

```text
/visual-web-qa Verify the docs theme on desktop and mobile, then share the evidence.
```

Full setup guide: https://junior.sentry.dev/extend/agent-browser-plugin/
