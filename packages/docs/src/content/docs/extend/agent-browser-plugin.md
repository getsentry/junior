---
title: Agent Browser Plugin
description: Configure browser automation workflows with agent-browser in Junior.
type: tutorial
summary: Install browser automation and evidence-driven visual QA workflows for Junior.
prerequisites:
  - /extend/
related:
  - /concepts/skills-and-plugins/
  - /extend/
  - /operate/security-hardening/
---

The Agent Browser plugin adds browser automation and visual QA skills backed by the `agent-browser` CLI.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-agent-browser
```

## Runtime setup

Add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-agent-browser"]);
```

## Config

No plugin config is required.

## Plugin-specific setup

This plugin adds two skills and installs a browser runtime into the sandbox snapshot:

- `/agent-browser` for general browser interaction
- `/visual-web-qa` for evidence-driven visual checks

Rebuild the sandbox snapshot after you enable the plugin so browser commands work in new sandboxes.

Use `/agent-browser` for general browser interaction:

```text
/agent-browser Open https://example.com, capture a screenshot, and summarize what is on the page.
```

Use `/visual-web-qa` when a frontend or docs change needs scoped browser evidence:

```text
/visual-web-qa Verify the updated docs navigation in light and dark themes, then share the evidence.
```

## Verify

1. Run `/agent-browser` with a simple open-and-snapshot request.
2. Run `/visual-web-qa` against a reachable local or preview page.
3. Confirm both turns can execute `agent-browser` commands successfully.
4. Confirm visual QA reports the exact target, scoped result, and successfully shared screenshot or video evidence.

## Failure modes

- `command not found: agent-browser`: the plugin runtime did not load. Confirm the plugin is registered and rebuild the sandbox snapshot.
- Browser launch fails during the turn: the snapshot browser runtime is missing or incomplete. Rebuild the sandbox snapshot after enabling the plugin.
- Stale element references like `@e*`: the DOM changed after the snapshot was taken. Run a fresh `snapshot -i` after navigation or UI updates.
- Page appears incomplete: the page had not finished loading before the next action. Wait explicitly with `agent-browser wait --load networkidle` before interacting.
- Visual QA is blocked: no local server or preview URL is reachable. Start the repo-native development server or provide a preview URL, then retry.

## Next step

Continue with [Plugins](/extend/) to build provider-specific extensions or review [Security Hardening](/operate/security-hardening/) for production controls.
