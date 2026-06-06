# Task Issue Guide

Load when issue type is `task`. Cross-type rules (title length, delegated footer, generalization, compression) live in `SKILL.md` § Draft issue content.

## Primary goal

Create a concise execution ticket for maintenance, cleanup, docs, refactors, or operational chores.

## Shape

A task can be just a title + 2-3 bullets. Use headed sections only when scope is complex.

**Summary** — up to 3 sentences describing the task. Short imperative title (e.g. "Remove deprecated legacyAuth middleware").

**Suggested sections (use only when complexity warrants):**

- **Background** — why this task exists, with code snippets if relevant
- **Scope** — what's included and excluded, quantify when possible

For simple tasks, skip sections and use flat bullets for scope and next step.

## Research guidance

- Minimal research by default. Prefer first-party repository context when available.
- Include implementation steps only when the thread discusses approach. Otherwise, state the goal and scope.
- Include dependencies or risks only when material.

## Context generalization

Before (session-specific):

> @bob asked in #eng-chat to clean up the unused `legacyAuth` middleware that he noticed while reviewing PR #312

After (generalized):

> Remove unused `legacyAuth` middleware to reduce maintenance surface
