# Packaging

## Generic npm package layout

```text
my-junior-plugin/
├── package.json
├── index.ts
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
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "default": "./index.js"
    }
  },
  "files": ["index.d.ts", "index.js", "plugin.yaml", "skills"],
  "dependencies": {
    "@sentry/junior-plugin-api": "workspace:*"
  }
}
```

## Host app wiring

Install next to `@sentry/junior`, then export a runtime-safe plugin set.

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@acme/junior-my-provider"]);
```

Point `juniorNitro()` at the plugin module. `createApp()` reads that enabled
set from Nitro's virtual module.

```ts
import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      plugins: "./plugins",
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
```

```ts
const app = await createApp();
```

Packages that export runtime hooks must be registered from app code with
their plugin factory in the same plugin set:

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { myProviderPlugin } from "@acme/junior-my-provider";

export const plugins = defineJuniorPlugins([myProviderPlugin()]);
```

Each factory should return `defineJuniorPlugin({ manifest, hooks })`. Use
package-name strings for packages that are only `plugin.yaml` plus optional
skills.

## Monorepo package checklist

When adding a new package under this repository's `packages/` directory:

- Match naming such as `@sentry/junior-<provider>`.
- For manifest-only packages, include `plugin.yaml` and optional `skills` in `package.json` `files`.
- For JS plugin packages, include the factory entrypoint and optional `skills` in `package.json` `files`.
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
- Validate packaged manifests by loading them through a configured host app/runtime or a targeted parser test.
- Run `junior snapshot create` when runtime dependencies or postinstall steps need sandbox snapshot warmup.
