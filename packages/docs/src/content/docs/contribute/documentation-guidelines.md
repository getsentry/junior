---
title: Documentation Guidelines
description: Structure and depth guidelines for high-quality Junior docs.
type: reference
summary: Use this guide to choose page type, section structure, and depth targets for every docs page.
prerequisites:
  - /contribute/development/
related:
  - /start-here/overview/
  - /start-here/quickstart/
  - /reference/config-and-env/
---

## Goal

Write docs that let a reader answer three questions quickly:

1. What is this?
2. Is this for me right now?
3. What should I do next?

For Junior specifically, keep the extension-first story obvious: wire runtime once, then add behavior through skills and plugins.

## Metadata contract

Use these frontmatter fields on all new or substantially updated pages:

- `type`: `conceptual`, `tutorial`, `reference`, or `troubleshooting`
- `summary`: one sentence describing the page outcome
- `prerequisites`: internal links readers should complete first
- `related`: internal links to next useful pages

## Cross-page writing standards

- Lead with a clear one-sentence purpose.
- Keep prerequisites explicit instead of implied.
- Prefer concrete actions and observable outcomes over abstract language.
- End with a clear next step path.
- Keep examples minimal and runnable when action is required.
- For file snippets, use titled code fences (for example, ````ts title="path/to/file.ts"````) instead of a separate backticked filename line above the block.
- Avoid mixing reference detail into quickstart flow.
- Avoid "header + bullet list only" sections. Each major section should include at least 2 sentences of explanatory prose before or after lists.

## Page templates and depth

### `conceptual` pages

Use for orientation, mental models, and decision support.

Recommended depth:

- 300 to 700 words
- 4 to 7 `##` sections
- 0 to 1 short code block

Recommended sections:

1. What this is
2. Who should use it
3. When to use and when not to
4. How it works at a high level
5. What success looks like
6. Next paths

### `tutorial` pages

Use for setup and execution steps.

Recommended depth:

- 250 to 900 words
- Numbered setup sequence
- At least one explicit verification check

Recommended sections:

1. Outcome
2. Prerequisites
3. Setup
4. Verify
5. Common failures
6. Next step

### `reference` pages

Use for API, config, and command lookup.

Recommended depth:

- 200 to 1200 words
- Table-first or signature-first layout
- Low narrative density

Recommended sections:

1. Scope summary
2. Contract table or signatures
3. Examples
4. Constraints and caveats

### `troubleshooting` pages

Use for diagnosis and recovery.

Recommended depth:

- 200 to 900 words
- Symptom-first organization
- Triage path visible in first screenful

Recommended sections:

1. Symptoms
2. Likely causes
3. First checks
4. Recovery order
5. Escalation links

## Anti-patterns

- Overview pages that are only feature lists.
- Tutorials without a verification step.
- Troubleshooting pages without concrete first checks.
- Reference pages buried under long conceptual introductions.
- Pages that read like an outline with little narrative explanation.
