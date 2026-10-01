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

The package includes three skills:

- `/agent-browser` for general browser navigation, interaction, extraction, and capture
- `/visual-web-qa` for evidence-driven verification of frontend, docs, layout, theme, loading, animation, and interaction changes
- `/demo-video` for edited product presentations with browser captures, optional narration, and Remotion

For example:

```text
/visual-web-qa Verify the docs theme on desktop and mobile, then share the evidence.
```

`/demo-video` captures the production workflow; it does not install Remotion or FFmpeg. Use a local artifact project with compatible dependencies and an appropriate Remotion license. For generated narration, enable a TTS plugin such as `@sentry/junior-tts`, or supply an audio file. Keep video artifacts separate from the app unless a repository change is requested.

Full setup guide: https://junior.sentry.dev/extend/agent-browser-plugin/
