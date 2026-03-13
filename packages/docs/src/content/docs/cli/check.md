---
title: "junior check"
description: "Validate Junior plugin manifests and skill files under app/ before build or deploy."
type: reference
summary: "`junior check [dir]` validates `app/plugins`, `app/skills`, and plugin-local skills, prints a grouped inventory of what it checked, then exits non-zero on schema or duplicate-name errors."
prerequisites:
  - /start-here/quickstart/
related:
  - /concepts/skills-and-plugins/
  - /extend/
  - /cli/init/
  - /cli/snapshot-create/
---

`junior check` validates the same `app/` content layout that the runtime loads. It ignores legacy top-level `plugins/` and `skills/` directories.

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

`junior check` walks these locations:

- `app/plugins/<plugin>/plugin.yaml`
- `app/plugins/<plugin>/skills/<skill>/SKILL.md`
- `app/skills/<skill>/SKILL.md`

For each file it validates:

- Plugin manifest schema
- Skill frontmatter schema
- Skill name matches the containing directory
- Duplicate plugin names
- Duplicate skill names across app and plugin skill roots

If a skill file has frontmatter but no instructions after it, the command emits a warning instead of failing.

## Example output

Successful validation:

```text
Checking /repo
✓ plugin demo
  └─ ✓ skill demo-helper
✓ app skills
  └─ ✓ skill repo-local
✓ Validation passed (1 plugin manifest, 2 skill directories checked).
```

Validation failure:

```text
Checking /repo
✓ plugin demo
✖ app skills
  └─ ✖ skill repo-local
✖ error: /repo/app/skills/repo-local/SKILL.md: uses-config token "GITHUB_REPO" is invalid; expected dotted lowercase tokens (for example "github.repo")
junior command failed: Validation failed (1 error, 1 plugin manifest, 1 skill directory checked).
```

## Verification

1. Run `pnpm exec junior check` from the app root, or pass the app path explicitly.
2. Confirm the command prints `Validation passed` or only expected `warning:` lines.
3. Fix any reported errors before build or deploy.

## Next step

After validation passes, continue with [junior snapshot create](/cli/snapshot-create/) if your plugins need sandbox dependencies, or return to [Plugins](/extend/) to keep extending the app surface.
