# Visual Web QA

## Intent

This skill makes the agent verify user-visible web changes by opening the rendered surface in a real browser, collecting evidence appropriate to the behavior, and reporting only what that evidence supports. It keeps coverage representative, avoids unsafe targets or sensitive capture, and distinguishes visual QA from general browser automation.

## Triggers

- **SHOULD** apply when a user asks whether frontend, docs, CSS, layout, theme, responsive, navigation, loading, animation, or interaction changes look correct.
- **SHOULD** apply when a visual change needs browser evidence across relevant states, viewports, or themes.
- **SHOULD NOT** apply to backend-only, CLI, library-internal, test-only, or non-rendered configuration changes.
- **SHOULD NOT** apply to general browser navigation, extraction, or form automation without a visual correctness question; use the general `agent-browser` workflow instead.
- **SHOULD NOT** apply when the user explicitly opts out of browser verification.

## Behaviors

### Behavior: Static visual verification

The agent SHALL open stable rendered states in a browser, capture screenshots as primary evidence, and report the exact target, covered states, result, findings, and limitations.

#### Scenario: Verify a responsive card layout

- **WHEN** a user asks to verify static spacing and typography on a local page at desktop and mobile widths
- **THEN** the agent opens the page in a browser, captures desktop and mobile screenshots without unnecessary video, and reports what those screenshots establish

### Behavior: Temporal visual verification

The agent SHALL use short video for loading, animation, transition, or interaction sequences; start initial-load recording before navigation; refresh element references after recording reloads or DOM changes; use meaningful waits; and stop recording when the target behavior is captured.

#### Scenario: Verify loading and menu behavior

- **WHEN** a local page has an initial skeleton followed by an interactive menu transition
- **THEN** the agent records the initial load before navigation, obtains fresh references for the interaction, captures the menu sequence, stops recording, and reports the temporal evidence

### Behavior: Representative coverage

The agent SHALL use the browser to verify a small representative set of pages, states, viewports, and themes most likely to expose the requested regression rather than creating an exhaustive matrix by default.

#### Scenario: Verify a shared docs theme

- **WHEN** a shared navigation and theme change affects several local docs pages across desktop, mobile, light, and dark modes
- **THEN** the agent opens and captures one to four representative surfaces and relevant combinations, then reports both the covered evidence and any combinations not checked

### Behavior: Target resolution

The agent SHALL use a user-provided, local, or preview target for changed code, use production only as an explicitly requested or read-only baseline, and report blocked when no valid target is reachable.

#### Scenario: Unmerged change has no runnable target

- **WHEN** a user asks to verify an unmerged frontend change but the workspace has no runnable page, local server, or preview deployment
- **THEN** the agent investigates enough to confirm the missing target and reports blocked instead of checking production and claiming the change is present

## Constraints

### Constraint: Evidence required

The agent MUST NOT claim that a rendered change looks correct from code inspection alone or without browser evidence that supports the claim.

### Constraint: Browser runtime

The agent MUST capture visual evidence with `agent-browser` and MUST NOT treat missing system Chrome/Chromium or a repo-local Playwright install as a visual-QA blocker.

### Constraint: Artifact delivery claims

The agent MUST NOT claim a screenshot or video was shared unless `sendFiles` succeeded; when delivery is unavailable or fails, it must report the saved path and limitation.

### Constraint: Production claims

The agent MUST NOT imply that unmerged code is visible on production unless the verified production target actually contains that code.

### Constraint: Recording lifecycle

The agent MUST NOT leave an active video recording running after the target behavior has been captured or the QA run ends.

### Constraint: Sensitive capture

The agent MUST NOT record, screenshot, or share credential entry, session tokens, customer data, or unrelated sensitive interface state.
