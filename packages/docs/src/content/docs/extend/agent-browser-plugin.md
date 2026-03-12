---
title: Agent Browser Plugin
description: Configure browser automation workflows with agent-browser in Junior.
type: tutorial
summary: Install the agent-browser plugin package, run browser workflows through `/agent-browser`, and verify sandbox execution.
prerequisites:
  - /extend/
related:
  - /concepts/skills-and-plugins/
  - /extend/
  - /operate/security-hardening/
---

The Agent Browser plugin adds a browser automation skill backed by the `agent-browser` CLI.

## Setup

### Install the plugin package

```bash
pnpm add @sentry/junior @sentry/junior-agent-browser
```

### What this plugin provides

- Plugin manifest: `agent-browser`
- Skill: `/agent-browser`
- Runtime dependency: `agent-browser` npm package installed in the sandbox snapshot
- Runtime postinstall: `agent-browser install` to provision browser binaries in the snapshot

No OAuth or capability setup is required for this plugin.

### Use the skill in a thread

Example invocation:

```text
/agent-browser Open https://example.com, capture a screenshot, and summarize what is on the page.
```

## Verify

1. Run `/agent-browser` with a simple open + snapshot request.
2. Confirm the turn can execute `agent-browser` commands successfully.
3. Confirm output includes concrete page evidence (URL and/or screenshot references).

## Failure Modes

- `command not found: agent-browser`: runtime dependency install did not complete; retry the turn and check sandbox setup logs.
- Stale element refs (`@e*`): take a fresh `snapshot -i` after navigation or DOM changes.
- Page appears incomplete: wait explicitly with `agent-browser wait --load networkidle` before interacting.

## Next step

Continue with [Plugins](/extend/) to build provider-specific extensions or review [Security Hardening](/operate/security-hardening/) for production controls.
