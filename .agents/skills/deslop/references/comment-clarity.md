# Comment Clarity Rules

Use this guide to remove comment noise and keep only high-signal documentation.

## Keep Comments That

1. Explain intent, invariants, constraints, or non-obvious tradeoffs.
2. Capture rationale for surprising decisions.
3. Document external contract details not obvious from code.

## Remove or Rewrite Comments That

1. Restate what the next line already says.
2. Drift from current code behavior.
3. Use inconsistent names for the same concept.
4. Serve as stale implementation narration.

## Rewrite Pattern

1. Delete low-value comment first.
2. Re-add only if intent is still non-obvious.
3. Use one short sentence focused on "why" or contract constraints.

## Examples

| Before | After |
| --- | --- |
| `// increment i` | _deleted_ |
| `// parse user here` above obvious parse call | _deleted_ |
| `// Retry to avoid transient provider failures observed in prod` | kept (explains non-obvious rationale) |

## Sources

- Google Go style guide doc comments: https://google.github.io/styleguide/go/guide#doc-comments
- PEP 8 comments section: https://peps.python.org/pep-0008/#comments
