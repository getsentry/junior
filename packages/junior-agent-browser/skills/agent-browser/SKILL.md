---
name: agent-browser
description: Automate websites with the agent-browser CLI for navigation, form flows, screenshots, extraction, and repeatable browser tasks. Use when users ask to interact with web apps, gather evidence from pages, or run browser-based QA steps.
allowed-tools: bash
---

# Browser Automation

Use this skill when work requires real browser interaction instead of API-only lookups.

## Core Workflow

1. Open target page:
- `agent-browser open <url>`

2. Capture interactive refs:
- `agent-browser snapshot -i`

3. Interact by ref:
- `agent-browser click @e1`
- `agent-browser fill @e2 "value"`

4. Re-snapshot after every navigation or significant DOM change:
- `agent-browser snapshot -i`

5. Capture result evidence:
- `agent-browser screenshot --annotate <file.png>`

## Operational Rules

- Use `agent-browser` directly; do not use `npx agent-browser`.
- Prefer one named session for multi-step flows:
  - `agent-browser --session <name> ...`
- Use chained commands with `&&` only when no intermediate output is needed.
- For commands that need refs (`@e*`), run `snapshot -i` first and use fresh refs.
- If page load is async-heavy, wait explicitly:
  - `agent-browser wait --load networkidle`
- For user-facing findings, include screenshots and the exact page URL.

## Common Patterns

### Form flow

```bash
agent-browser --session demo open https://example.com/signup
agent-browser --session demo wait --load networkidle
agent-browser --session demo snapshot -i
agent-browser --session demo fill @e1 "user@example.com"
agent-browser --session demo click @e2
agent-browser --session demo wait --load networkidle
agent-browser --session demo screenshot --annotate /tmp/signup-result.png
```

### Structured extraction

```bash
agent-browser open https://example.com
agent-browser snapshot --json > /tmp/page.json
agent-browser get text body > /tmp/page.txt
```

## Reference Files

Read only what is needed:

- Command surface: [references/commands.md](references/commands.md)
- Auth vault + login flows: [references/authentication.md](references/authentication.md)
- Session/state persistence: [references/session-management.md](references/session-management.md)
- Snapshot refs and stale-ref handling: [references/snapshot-refs.md](references/snapshot-refs.md)
- Proxy/network setup: [references/proxy-support.md](references/proxy-support.md)
- Recording and video capture: [references/video-recording.md](references/video-recording.md)
- Performance profiling: [references/profiling.md](references/profiling.md)

## Templates

- Authenticated flow bootstrap: [templates/authenticated-session.sh](templates/authenticated-session.sh)
- Capture workflow skeleton: [templates/capture-workflow.sh](templates/capture-workflow.sh)
- Form automation skeleton: [templates/form-automation.sh](templates/form-automation.sh)
