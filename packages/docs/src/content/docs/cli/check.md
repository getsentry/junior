---
title: "junior check"
description: "Validate Junior content and deployment config before build or deploy."
type: reference
prerequisites:
  - /start-here/quickstart/
related:
  - /concepts/skills-and-plugins/
  - /extend/
  - /cli/init/
  - /cli/snapshot-create/
  - /cli/upgrade/
---

`junior check` validates local app content, installed plugin package content, and Junior deployment config before build or deploy. It ignores legacy top-level `plugins/` and `skills/` directories, and it only runs app-file checks when the target already looks like a Junior app.

## Usage

Run it from your app root:

```bash
pnpm exec junior check
```

## Extended usage

You can also point it at another app directory:

```bash
pnpm exec junior check packages/my-bot
```

The command accepts zero or one directory argument.

## Validation

`junior check` validates the plugin and skill files under `app/`:

- `app/plugins/<plugin>/plugin.yaml`
- `app/plugins/<plugin>/skills/<skill>/SKILL.md`
- `app/skills/<skill>/SKILL.md`

It also checks installed package dependencies that contain Junior plugin content:

- `node_modules/<package>/plugin.yaml`
- `node_modules/<package>/plugins/<plugin>/plugin.yaml`
- package `skills/` directories

For each file it validates:

- Plugin manifest schema
- Skill frontmatter schema
- Skill name matches the containing directory
- Duplicate plugin names
- Duplicate skill names across app and plugin skill roots

For official `@sentry/junior-*` plugin packages, the command warns when the installed package version differs from `@sentry/junior`. This catches partial updates without requiring migration-specific checks.

When the target already contains Junior app markers such as `app/SOUL.md`, `app/WORLD.md`, `app/DESCRIPTION.md`, `app/skills/`, or `app/plugins/`, the command also checks the app-root Markdown files:

- `app/SOUL.md` for assistant personality. Missing emits a warning.
- `app/WORLD.md` for operational context. Missing emits a warning.
- `app/DESCRIPTION.md` for the user-facing app description. Missing emits a warning.
- `app/ABOUT.md` must not exist. This is a clean break; use `WORLD.md` and `DESCRIPTION.md` instead.
- Other `app/*.md` files are allowed and stay available at runtime as optional sandbox reference documents.

If a skill file has frontmatter but no instructions after it, the command emits a warning instead of failing.

For Nitro/Vercel apps, the command checks deployment wiring when it sees Junior markers such as `@sentry/junior`, `juniorNitro()`, or app content files. It fails when `nitro.config.ts` omits `juniorNitro()`, because that module emits Junior's heartbeat cron and Vercel Queue trigger into the Nitro build output. It also fails when root `vercel.json` still targets `functions["api/internal/agent/continue.ts"]`; Nitro does not deploy that source file as a Vercel function.

Root `vercel.json` heartbeat crons emit a warning. `juniorNitro()` now emits `/api/internal/heartbeat` into `.vercel/output/config.json`, so keeping the root cron can drift from the deployed Nitro config.

## Example output

Successful validation:

```text
Checking /repo
✓ app files
✓ plugin demo
  └─ ✓ skill demo-helper
✓ app skills
  └─ ✓ skill repo-local
✓ Validation passed (1 plugin manifest, 2 skill directories checked).
```

Validation failure:

```text
Checking /repo
✓ app files
✓ plugin demo
✖ app skills
  └─ ✖ skill repo-local
✖ error: /repo/app/skills/repo-local/SKILL.md: Frontmatter field "uses-config" is no longer supported; plugin config keys come from plugin.yaml.
junior command failed: Validation failed (1 error, 1 plugin manifest, 1 skill directory checked).
```

Deprecated app-file layout:

```text
Checking /repo
✖ app files
✖ error: /repo/app/ABOUT.md: ABOUT.md is no longer supported. Rename to WORLD.md (operational context) and DESCRIPTION.md (user-facing description).
junior command failed: Validation failed (1 error, 0 plugin manifests, 0 skill directories checked).
```

## Verification

1. Run `pnpm exec junior check` from the app root, or pass the app path explicitly.
2. Confirm the command prints `Validation passed` or only expected `warning:` lines.
3. If you are migrating older app docs, replace `app/ABOUT.md` with `app/WORLD.md` and `app/DESCRIPTION.md`.
4. Fix any reported errors before build or deploy.

## Next step

After validation passes, continue with [junior snapshot create](/cli/snapshot-create/) if your plugins need sandbox dependencies, or return to [Plugins](/extend/) to keep extending the app surface.
