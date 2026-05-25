# Packaging

## Generic npm package layout

```text
my-junior-plugin/
├── package.json
├── plugin.yaml
└── skills/
    └── my-provider/
        └── SKILL.md
```

```json
{
  "name": "@acme/junior-my-provider",
  "private": false,
  "type": "module",
  "files": ["plugin.yaml", "skills"]
}
```

## Host app wiring

Install next to `@sentry/junior`, then list in `plugins.packages`.

```ts
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      plugins: {
        packages: ["@acme/junior-my-provider"],
      },
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
```

For local dev paths that call `createApp()` directly, pass the same list there unless the app already centralizes it.

```ts
const app = await createApp({
  plugins: {
    packages: ["@acme/junior-my-provider"],
  },
});
```

Packages that export trusted runtime hooks must be registered from app code with
their plugin factory instead of a plain package list:

```ts
import { createApp } from "@sentry/junior";
import { myProviderPlugin } from "@acme/junior-my-provider";

const app = await createApp({
  plugins: [myProviderPlugin()],
});
```

The trusted plugin's `pluginConfig.packages` should include the package that
contains `plugin.yaml`. Nitro still owns build-time package copying.

## Monorepo package checklist

When adding a new package under this repository's `packages/` directory:

- Match naming such as `@sentry/junior-<provider>`.
- Include `plugin.yaml` and `skills` in `package.json` `files`.
- Add a package README if users need setup or verification steps.
- Keep package version aligned with the monorepo release process.
- Keep release package lists aligned across `.craft.yml`, `scripts/bump-release-versions.mjs`, `.github/workflows/ci.yml`, `README.md`, and release docs.
- Run `pnpm release:check` after release-list changes.

## Packaged plugin discovery

- Junior only loads packaged plugin content from package names supplied to the app.
- A package with root `plugin.yaml` contributes that manifest.
- A package with root `skills/` contributes those skill roots.
- A package with `plugins/` contributes each child plugin containing `plugin.yaml`.
- Nitro copies app content and declared package content into the server bundle.

## Packaging validation

- Run package-local lint/type checks when package code changes.
- Run `pnpm skills:check` in this repository after changing package skill files.
- Run `pnpm exec junior check` in a consumer app for app-local files.
- Validate the packaged root `plugin.yaml` by loading it through a configured host app/runtime or a targeted parser test.
- Run `junior snapshot create` when runtime dependencies or postinstall steps need sandbox snapshot warmup.
