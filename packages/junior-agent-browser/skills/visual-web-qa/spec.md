# Visual Web QA

## Intent

This skill makes the agent verify user-visible web changes with browser evidence instead of inferring visual correctness from code. It chooses evidence that fits the behavior under test, keeps coverage representative, protects sensitive data, and reports only what the captured evidence supports.

## Triggers

- **SHOULD** apply when a user asks whether frontend, docs, CSS, layout, theme, responsive, navigation, loading, animation, or interaction changes look correct.
- **SHOULD** apply when a visual change needs screenshot or video evidence across relevant states, viewports, or themes.
- **SHOULD NOT** apply to backend-only, CLI, library-internal, test-only, or non-rendered configuration changes.
- **SHOULD NOT** apply to general browser navigation, extraction, or form automation that is not specifically visual verification; use the general `agent-browser` workflow instead.
- **SHOULD NOT** apply when the user explicitly opts out of browser verification.

## Behaviors

### Behavior: Evidence selection

The agent SHALL choose screenshots for stable rendered states, short videos for temporal behavior, and DOM or text checks only when they resolve ambiguity or verify an exact state.

#### Scenario: Static theme and spacing change

- **WHEN** a user asks to verify updated colors, spacing, typography, or layout
- **THEN** the agent uses screenshots as primary evidence and does not record video unless timing or motion is also relevant

#### Scenario: Loading or animation change

- **WHEN** a user asks to verify a loading state, transition, animation, or interaction sequence
- **THEN** the agent uses a short video as primary evidence and adds a screenshot only when it answers a distinct static question

### Behavior: Representative scope

The agent SHALL choose a small representative set of pages, states, viewports, and themes that can expose the requested issue instead of creating an exhaustive matrix by default.

#### Scenario: Responsive theme verification

- **WHEN** a user asks to verify a responsive light and dark theme change without requesting exhaustive coverage
- **THEN** the agent selects the few pages or states and viewport-theme combinations most likely to expose regressions, normally one to four

### Behavior: Target resolution

The agent SHALL verify changed code against a user-provided, local, or preview target, use production only as an explicitly requested or read-only baseline, and report blocked when no valid target is reachable.

#### Scenario: Unmerged change without a preview

- **WHEN** a user asks to verify an unmerged frontend change but provides no URL and no local or preview server is reachable
- **THEN** the agent reports the missing target as a blocker instead of checking production and claiming the change is present

### Behavior: Reliable browser state

The agent SHALL wait for meaningful route, text, network, or animation state; refresh element references after navigation or recording-context reloads; and stop every recording before the run ends.

#### Scenario: Capture an initial loading state

- **WHEN** a user asks to record an initial loading state and then interact with the loaded page
- **THEN** the agent starts recording before the first navigation, obtains fresh element references after recording starts, uses meaningful waits, and stops recording after the target behavior is captured

### Behavior: Artifact delivery

The agent SHALL share requested artifacts with `sendFiles`, claim they were shared only after a successful tool result, and otherwise report the saved path and delivery error.

#### Scenario: File delivery fails

- **WHEN** screenshots or video were captured but `sendFiles` is unavailable or returns an error
- **THEN** the agent states that sharing failed and provides the saved artifact paths without claiming an attachment succeeded

### Behavior: Scoped report

The agent SHALL report the exact target, chosen evidence, pass or issues found or blocked result, specific findings, and limitations of the performed coverage.

#### Scenario: Partial verification

- **WHEN** the agent verifies only a subset of requested pages, states, viewports, or themes
- **THEN** the report names the exact target and covered evidence, identifies the result, and explicitly states what remains unverified

### Behavior: Sensitive data handling

The agent SHALL avoid capturing or sharing credentials, session tokens, customer data, or unrelated sensitive UI state during visual verification.

#### Scenario: Authenticated page requires credential entry

- **WHEN** reaching the requested page would require recording or screenshotting credential entry or sensitive customer data
- **THEN** the agent avoids capturing the sensitive flow and reports the authentication or safe-session requirement as a limitation or blocker

### Behavior: Workflow boundary

The agent SHALL keep visual QA focused on evidence-driven visual verification and use the general `agent-browser` workflow for browser navigation, extraction, or form automation without a visual correctness question.

#### Scenario: General page extraction

- **WHEN** a user asks to browse a site and extract structured information without asking whether the rendered interface looks correct
- **THEN** the agent uses the general browser workflow instead of applying visual QA evidence and reporting requirements

## Constraints

### Constraint: Evidence required

The agent MUST NOT claim that a rendered change looks correct without opening a browser and collecting evidence that supports the claim.

### Constraint: Production claims

The agent MUST NOT imply that unmerged code is visible on production unless the user explicitly asks about production and the verified target actually contains that code.

### Constraint: Recording lifecycle

The agent MUST NOT leave an active video recording running after the target behavior has been captured or the QA run ends.

### Constraint: Sensitive capture

The agent MUST NOT record, screenshot, or share credential entry, session tokens, customer data, or unrelated sensitive interface state.
