---
title: "junior init"
description: "Scaffold a new Junior app in an empty directory."
type: reference
prerequisites:
  - /start-here/quickstart/
related:
  - /start-here/quickstart/
  - /reference/config-and-env/
  - /cli/check/
  - /cli/snapshot-create/
---

Use `junior init` when you want a new project to start from the supported runtime shape instead of wiring Junior by hand.

## Usage

```bash
pnpm dlx @sentry/junior init my-bot
```

The command requires exactly one argument: the target directory.

## What it creates

The scaffold includes:

- `package.json` with `hono`, `@sentry/node`, `@sentry/junior`, `nitro`, and `vite`
- `server.ts`
- `nitro.config.ts`
- `vite.config.ts`
- `vercel.json`
- `app/SOUL.md`
- `app/WORLD.md`
- `app/DESCRIPTION.md`
- `app/skills/`
- `app/plugins/`
- `.env.example`
- `.gitignore`

`SOUL.md` sets Junior's default voice, `WORLD.md` holds operational context, and `DESCRIPTION.md` powers the user-facing app description. Add other `app/*.md` files only when you want optional reference material available to the agent at runtime. `ABOUT.md` is not part of the scaffold and is not supported.

This gives you the minimum app shape needed to run Junior locally and continue with plugin or skill setup.

## Example output

After a successful run, the CLI prints the created path and the next command to run:

```text
Created my-bot at /path/to/my-bot

  cd my-bot && pnpm install && pnpm dev
```

## Constraints

`junior init` is strict about the target path:

- The path must be a directory, not a file
- The directory must be empty if it already exists
- Extra arguments are rejected

If validation fails, the CLI exits non-zero and prints an error such as:

```text
junior command failed: refusing to initialize non-empty directory: /path/to/my-bot
```

## Verification

After scaffolding:

1. Run `cd my-bot && pnpm install`.
2. Fill in the required values from `.env.example`.
3. Run `pnpm dev`.
4. Check `http://localhost:3000/api/health`.

For the complete setup flow, continue with [Quickstart](/start-here/quickstart/).

## Next step

Follow [Quickstart](/start-here/quickstart/) to add env vars, then run [junior check](/cli/check/) once you start adding skills or plugins.
