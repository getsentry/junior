---
title: Plugins Overview
description: Extend Junior with plugins and skills, either locally in your app or as npm packages.
type: conceptual
summary: Choose between local and npm-distributed plugins and understand how plugin manifests and skills are discovered.
prerequisites:
  - /start-here/quickstart/
related:
  - /extend/custom-plugins/
  - /extend/agent-browser-plugin/
  - /extend/github-plugin/
  - /extend/sentry-plugin/
---

Junior’s extension model is simple: keep runtime wiring stable, and add behavior through plugin manifests plus skills. You can do this locally in your app or ship plugins as npm packages.

## What plugins provide

A plugin bundles two things:

- A manifest (`plugin.yaml`) that declares optional capabilities, optional config keys, and optional credential behavior.
- Skills (`SKILL.md`) that consume those capabilities at runtime.

This keeps provider-specific behavior out of core runtime files.

## Local plugins in `app/plugins`

For app-specific workflows, define plugins directly in your app:

```text
app/plugins/<plugin-name>/
├── plugin.yaml
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

Use this path when you want fast iteration inside a single app without publishing packages.

## npm-distributed plugins

For reuse across apps or teams, package plugin manifests + skills as npm packages and install them next to `@sentry/junior`.

```bash
pnpm add @sentry/junior @sentry/junior-agent-browser @sentry/junior-github @sentry/junior-sentry
```

If you publish your own package, include `plugin.yaml` and `skills` in package `files` so runtime discovery works.

## Local skills and plugin skills

Junior discovers both:

- App-local skills in `app/skills/<skill-name>/SKILL.md`
- Plugin-provided skills under each plugin’s `skills/` root

Both follow the same `SKILL.md` contract, capability checks, and validation behavior.

## Validate extensions

```bash
pnpm skills:check
```

## Next step

- [Custom Plugins](/extend/custom-plugins/)
- [Agent Browser Plugin](/extend/agent-browser-plugin/)
- [GitHub Plugin](/extend/github-plugin/)
- [Sentry Plugin](/extend/sentry-plugin/)
