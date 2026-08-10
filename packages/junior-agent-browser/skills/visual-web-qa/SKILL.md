---
name: visual-web-qa
description: Verifies user-visible web changes with scoped browser evidence and reports only what the captured screenshots, videos, or state checks support. Use when frontend, docs, CSS, layout, theme, responsive, navigation, loading, animation, or interaction changes need visual validation; use agent-browser for general automation that is not specifically visual QA.
spec_hash: 7dd651f9311c
allowed-tools: bash sendFiles
---

# Visual Web QA

Verify rendered behavior in a browser instead of inferring visual correctness from code. Choose the smallest set of evidence that directly answers the request.

Capture evidence with `agent-browser` only. Missing system Chrome/Chromium or a repo-local Playwright install is not a visual-QA blocker.

## Workflow

1. Classify the requested behavior as stable, temporal, or exact-state verification.
2. Resolve a valid local, preview, or explicitly requested target URL.
3. Choose representative pages, states, viewports, and themes.
4. Capture browser evidence with meaningful waits and fresh element refs.
5. Share requested artifacts with `sendFiles` and verify delivery success.
6. Report the exact target, evidence, result, findings, and limitations.

## Choose Evidence

| Request                                   | Primary evidence                   | Optional support                                 |
| ----------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| Layout, CSS, content, typography          | Screenshot                         | DOM text or style check                          |
| Light and dark themes                     | Screenshot per relevant theme      | Theme attribute check                            |
| Responsive behavior                       | Screenshot per relevant breakpoint | Video only if resize motion matters              |
| Loading state, animation, transition      | Short video                        | Screenshot for a distinct final-state question   |
| Navigation or interaction sequence        | Short video                        | Screenshot for a specific defect                 |
| Stable menu, modal, hover, or focus state | Screenshot                         | Video if the transition matters                  |
| Exact text, route, ARIA, or attribute     | DOM check                          | Screenshot or video if the visible state matters |

Use screenshots for stable rendered states. Use short videos for timing, motion, loading, or sequence. A purely temporal request may use video without a redundant screenshot. DOM checks support visual evidence; they do not replace it when the user asks how something looks.

```bash
agent-browser --session visual-qa screenshot /tmp/visual-qa.png
agent-browser --session visual-qa screenshot --full /tmp/visual-qa-full.png
agent-browser --session visual-qa screenshot --annotate /tmp/visual-qa-issue.png
```

## Keep Scope Representative

- Check one to four representative pages or states unless the user requests broader coverage or the change spans more templates.
- Choose the viewport-theme combinations most likely to expose the issue instead of building an exhaustive matrix by default.
- State clearly when only part of the requested surface was verified.

## Resolve The Target

Use this order:

1. User-provided URL
2. Running local development server
3. Repo-native server such as `pnpm dev`
4. Preview deployment
5. Production as an explicitly requested or read-only baseline
6. `file://` output only when the site renders correctly without a server

Do not check production and claim an unmerged change is present. If no valid target is reachable, report **blocked** and name the missing server, preview, build, or authentication requirement.

## Capture Reliable State

Wait for the state that proves progress instead of adding arbitrary delays:

```bash
agent-browser --session visual-qa wait --url "**/expected-path"
agent-browser --session visual-qa wait --text "Expected text"
agent-browser --session visual-qa wait --load networkidle
agent-browser --session visual-qa wait 100
```

- Prefer URL or text waits for route and content changes.
- Use `networkidle` only when the action triggers real network activity.
- Use a short fixed wait only when an animation has no semantic completion signal.
- Run `snapshot -i` after navigation or significant DOM changes before using element refs.

For initial loading behavior, start recording before the first navigation:

```bash
agent-browser --session visual-qa set viewport 1440 900
agent-browser --session visual-qa record start /tmp/visual-qa-load.webm "$URL"
agent-browser --session visual-qa wait --load networkidle
agent-browser --session visual-qa record stop
```

For post-load interactions, explore first, then start recording. `record start` creates a fresh browser context and reloads the page, so discard earlier refs and run `snapshot -i` again before interacting. Stop recording as soon as the target behavior is captured. Never end a QA run with an active recording.

## Share Evidence

Use `sendFiles` for every artifact the user should receive:

```json
{
  "files": [
    { "path": "/tmp/visual-qa.png" },
    { "path": "/tmp/visual-qa-load.webm" }
  ]
}
```

- Claim an artifact was shared only when `sendFiles` succeeds in this turn.
- If delivery fails or `sendFiles` is unavailable, report the error and saved paths without claiming attachment success.

## Protect Sensitive Data

Never capture or share credential entry, session tokens, customer data, or unrelated sensitive UI state. If reaching the target requires exposing that data, use an existing safe authenticated session or report the authentication requirement as a limitation or blocker.

## Report The Result

Report:

- **Target:** exact URL verified
- **Evidence:** screenshots, videos, and state checks gathered, with why each was chosen
- **Result:** pass, issues found, or blocked
- **Findings:** specific rendered behavior observed
- **Limitations:** requested pages, states, viewports, or themes not verified

Use **pass** only when the captured evidence matches the requested behavior without an obvious scoped regression. Use **issues found** for broken layout, incorrect motion, flicker, missing assets, or invalid states. Use **blocked** when no safe reachable target exists.

Never generalize beyond the evidence collected, and never claim a rendered change looks correct without opening a browser and gathering supporting evidence.
