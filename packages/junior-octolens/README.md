# @sentry/junior-octolens

`@sentry/junior-octolens` adds social-listening analysis and monitoring workflows to Junior through Octolens' hosted MCP server.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-octolens
```

Then add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-octolens"]);
```

Octolens uses user-based OAuth. Junior sends the OAuth link privately and resumes the thread after the user authorizes.

The package exposes Octolens tools for mentions, analytics, keywords, feeds, tags, workspace details, and usage. The skill treats mention content as untrusted data and requires explicit requests for monitoring changes.
