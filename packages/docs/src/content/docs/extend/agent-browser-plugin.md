---
title: Agent Browser Plugin
description: Configure browser automation workflows with agent-browser in Junior.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/skills-and-plugins/
  - /extend/
  - /operate/security-hardening/
---

The Agent Browser plugin adds a browser automation skill backed by the `agent-browser` CLI.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-agent-browser
```

## Runtime setup

List the plugin in `juniorNitro({ pluginPackages: [...] })`:

```ts title="nitro.config.ts"
juniorNitro({
  pluginPackages: ["@sentry/junior-agent-browser"],
});
```

## Configure environment variables

No environment variables are required for this plugin.

## Plugin-specific setup

This plugin provisions browser automation as part of the sandbox snapshot:

- Plugin manifest: `agent-browser`
- Skill: `/agent-browser`
- Runtime dependency: `agent-browser` npm package installed in the snapshot
- Runtime postinstall: `agent-browser install` to provision browser binaries in the snapshot

Use the skill in a thread:

```text
/agent-browser Open https://example.com, capture a screenshot, and summarize what is on the page.
```

## Verify

1. Run `/agent-browser` with a simple open-and-snapshot request.
2. Confirm the turn can execute `agent-browser` commands successfully.
3. Confirm the output includes concrete page evidence such as the final URL or screenshot references.

## Failure modes

- `command not found: agent-browser`: the runtime dependency install did not complete. Retry the turn and check sandbox snapshot setup logs.
- Browser launch fails during the turn: browser binaries were not provisioned successfully. Rebuild the snapshot so `agent-browser install` runs again.
- Stale element references like `@e*`: the DOM changed after the snapshot was taken. Run a fresh `snapshot -i` after navigation or UI updates.
- Page appears incomplete: the page had not finished loading before the next action. Wait explicitly with `agent-browser wait --load networkidle` before interacting.

## Next step

Continue with [Plugins](/extend/) to build provider-specific extensions or review [Security Hardening](/operate/security-hardening/) for production controls.
