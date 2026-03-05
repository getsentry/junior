# Interface Simplicity Rules

Use this guide when code exposes too much surface area or unclear contracts.

## Core Rules

1. Prefer consumer-oriented interfaces: define the smallest contract needed by the caller.
2. Prefer explicit parameter types over catch-all maps/options objects when fields are stable.
3. Avoid introducing abstractions before there are at least two concrete consumers.
4. Keep exported symbols minimal; keep helpers private by default.
5. Split broad interfaces by responsibility rather than adding optional methods.

## Common Anti-Patterns and Fixes

| Anti-pattern | Better move |
| --- | --- |
| Wide interface with unrelated methods | Split into focused interfaces by usage boundary |
| "Utility" module exported everywhere | Move narrowly used logic close to call sites |
| Generic `options: Record<string, unknown>` | Replace with explicit typed shape |
| Wrapper that forwards all calls unchanged | Remove wrapper and call concrete dependency directly |

## Review Checklist

1. Did the change reduce exported API surface?
2. Are new abstractions justified by actual reuse?
3. Is each interface cohesive and purpose-specific?

## Sources

- Go Code Review Comments (interfaces): https://go.dev/wiki/CodeReviewComments
- Fowler on code smells as refactoring signals: https://martinfowler.com/bliki/CodeSmell.html
