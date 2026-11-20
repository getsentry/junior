---
name: visual-web-qa
description: Verifies user-visible web changes with scoped browser evidence and reports only what the captured screenshots, videos, or state checks support. Use when frontend, docs, CSS, layout, theme, responsive, navigation, loading, animation, or interaction changes need visual validation; use agent-browser for general automation that is not specifically visual QA.
spec_hash: 7ef6809d0e08
allowed-tools: bash sendFiles viewImage publishImage unpublishImage
---

# Visual Web QA

Verify rendered behavior in a browser. Never claim a rendered change looks correct from code alone, and never claim more than the captured evidence shows.

## Resolve The Target

Use this order:

1. User-provided URL
2. Running local development server
3. Repo-native server such as `pnpm dev`
4. Preview deployment
5. Production as an explicitly requested or read-only baseline
6. `file://` output only when the site renders correctly without a server

Do not check production and claim an unmerged change is present. If no valid target is reachable, report **blocked** and name the missing server, preview, build, or authentication requirement.

## Choose Evidence

- **Stable states** such as layout, CSS, typography, themes, breakpoints, menus, modals, and focus: take screenshots. Take one for each relevant theme or breakpoint.
- **Temporal behavior** such as loading, animation, transitions, and interaction sequences: record a short video. A redundant screenshot is not necessary.
- **Exact text, route, ARIA, or attributes:** use a DOM check. A DOM check supports visual evidence. It does not replace visual evidence when the user asks how something looks.

Check one to four representative pages or states, with the viewport-theme combinations most likely to show the issue. Do not build an exhaustive matrix unless the user asks for it.

```bash
agent-browser --session visual-qa screenshot /tmp/visual-qa.png
agent-browser --session visual-qa screenshot --full /tmp/visual-qa-full.png
agent-browser --session visual-qa screenshot --annotate /tmp/visual-qa-issue.png
```

## Capture Reliable State

Wait for a signal that proves progress, not an arbitrary delay:

- `wait --url "**/expected-path"` or `wait --text "Expected text"` for route and content changes.
- `wait --load networkidle` only when the action makes real network requests.
- `wait 100` only for an animation that has no completion signal.

Run `snapshot -i` after navigation or significant DOM changes before you use element refs.

For initial loading behavior, start recording before the first navigation:

```bash
agent-browser --session visual-qa set viewport 1440 900
agent-browser --session visual-qa record start /tmp/visual-qa-load.webm "$URL"
agent-browser --session visual-qa wait --load networkidle
agent-browser --session visual-qa record stop
```

For post-load interactions, explore first, then start recording. `record start` creates a fresh browser context and reloads the page, so discard earlier refs and run `snapshot -i` again before interacting. Stop recording as soon as the target behavior is captured. Never end a QA run with an active recording.

## Share Evidence

Send every artifact the user should receive with `sendFiles`. Claim an artifact was shared only when `sendFiles` succeeds in this turn. If delivery fails or `sendFiles` is unavailable, report the error and the saved paths.

## Attach Evidence To Pull Requests

When the QA is for a pull request, attach screenshots to the PR when you can. Reviewers then see the rendered result without the Slack thread.

1. Open each screenshot with `viewImage` and check it for sensitive data. See **Protect Sensitive Data**.
2. If a screenshot shows sensitive data, do not publish it. Recapture it with the data out of view, or skip it.
3. Publish each safe screenshot with `publishImage`. The URL is public to anyone who has it.
4. Embed the returned URLs in the PR body or a PR comment, with one short caption for each page, state, viewport, or theme.

- `publishImage` accepts only images. Do not publish videos. Describe the temporal result in text instead.
- Do not link private Slack files or conversation attachment URLs in the PR.
- If you publish an image by mistake, remove it with `unpublishImage` and remove it from the PR.
- If `publishImage` or the PR update fails, report the failure and do not claim the PR has screenshots.

## Protect Sensitive Data

Never capture or share credential entry, session tokens, customer data, or unrelated sensitive UI state. Apply this rule with more care to published images, because their URLs are public. Look for real emails, names, avatars, customer org or project names, tokens, API keys, DSNs, and private URLs. Seeded or fake local data is safe. If reaching the target requires exposing that data, use an existing safe authenticated session or report the authentication requirement as a limitation or blocker.

## Report The Result

- **Target:** exact URL verified
- **Evidence:** screenshots, videos, and state checks gathered, with why each was chosen
- **Result:** pass, issues found, or blocked
- **Findings:** specific rendered behavior observed
- **Limitations:** requested pages, states, viewports, or themes not verified

Use **pass** only when the captured evidence matches the requested behavior without an obvious scoped regression. Use **issues found** for broken layout, incorrect motion, flicker, missing assets, or invalid states. Use **blocked** when no safe reachable target exists.
