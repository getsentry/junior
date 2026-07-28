# Sandbox Compatibility Image

This image smoke-tests the example app's sandbox dependency snapshot on the
same documented operating-system family as Vercel Sandbox:

- Amazon Linux 2023
- Node.js 22
- Git and ripgrep, which Junior expects from the prepared runtime
- the `vercel-sandbox` user with passwordless `sudo`
- `/vercel/sandbox` as the working directory
- plugin runtime dependencies and postinstall commands

The stock Amazon Linux image does not package `ripgrep`, so the compatibility
base installs that CLI before applying the generated profile.

`runtime-profile.json` is generated from the plugins enabled in
`apps/example/plugins.ts`. Regenerate it after changing plugin runtime
dependencies:

```sh
pnpm sandbox:image:profile
```

Build and validate the image locally:

```sh
pnpm sandbox:image:test
```

The Docker build validates package availability and installation behavior. It
does not reproduce Vercel's Firecracker kernel, network policy, credential
proxy, resource limits, or nested Docker runtime.
